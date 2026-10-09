# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Restow storage plugin shim for Proxmox VE: the storage plugin.
# Copyright (C) 2026 the Restow authors
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or (at your
# option) any later version. This program is distributed in the hope that it
# will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty
# of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero
# General Public License (the LICENSE file in this folder) for more details.
#
# Installed as /usr/share/perl5/PVE/Storage/Custom/RestowPlugin.pm. A storage
# of type `restow` with content `backup` and the `backup-provider` feature:
# vzdump hands every backup onto it to the provider in RestowProvider.pm
# (installed as PVE/BackupProvider/Plugin/Restow.pm).
#
# This file is deliberately thin. Every call that needs Restow is passed to
# the separate program `restow-pve provider <verb>` (JSON on stdin and
# stdout, documented in docs/PVE-PROTOCOL.md of the Restow repository).
# status() and list_volumes() only read caches restow-pve maintains, with a
# short timeout, so pvestatd never waits for the network. Deleting backups
# and pruning are refused: retention is managed in Restow.
package PVE::Storage::Custom::RestowPlugin;

use strict;
use warnings;

use IO::Select;
use IPC::Open3;
use JSON::PP;
use Symbol qw(gensym);

use PVE::BackupProvider::Plugin::Restow;

use base qw(PVE::Storage::Plugin);

# Overridable by the test harness only.
our $HELPER = '/opt/restow-pve/bin/restow-pve';

my $json = JSON::PP->new->canonical->allow_nonref;

# --- exec bridge ---------------------------------------------------------------

# call_helper($verb, \%request, $log_function, $timeout_seconds)
sub call_helper {
    my ($verb, $request, $log, $timeout) = @_;

    die "restow-pve is not installed ($HELPER)\n" if !-x $HELPER;
    my $input = $json->encode($request // {});
    my ($stdout, $partial) = ('', '');
    my $relay = sub {
        my ($line) = @_;
        return if !defined($line) || $line eq '';
        my ($level, $msg) = $line =~ m/^(info|warn|err):\s?(.*)$/ ? ($1, $2) : ('info', $line);
        if ($log) {
            $log->($level, $msg);
        } else {
            print STDERR "$level: $msg\n";
        }
    };

    my $err = gensym;
    my $pid = open3(my $in, my $out, $err, $HELPER, 'provider', $verb);
    my $run = sub {
        print {$in} $input;
        close($in);
        my $sel = IO::Select->new($out, $err);
        while ($sel->count) {
            for my $fh ($sel->can_read) {
                my $n = sysread($fh, my $buf, 65536);
                if (!$n) {
                    $sel->remove($fh);
                    next;
                }
                if ($fh == $out) {
                    $stdout .= $buf;
                } else {
                    $partial .= $buf;
                    while ($partial =~ s/^([^\n]*)\n//) {
                        $relay->($1);
                    }
                }
            }
        }
        $relay->($partial) if $partial ne '';
        waitpid($pid, 0);
    };

    if ($timeout) {
        local $SIG{ALRM} = sub { die "restow-pve provider $verb timed out\n" };
        alarm($timeout);
        eval { $run->() };
        my $e = $@;
        alarm(0);
        if ($e) {
            kill('TERM', $pid);
            waitpid($pid, 0);
            die $e;
        }
    } else {
        $run->();
    }

    my $response = eval { $json->decode($stdout) };
    die "restow-pve provider $verb gave no valid answer (exit status " . ($? >> 8) . ")\n"
        if !$response || ref($response) ne 'HASH';
    die(($response->{error} // 'unknown error') . "\n") if !$response->{ok};
    return $response->{result} // {};
}

# --- plugin definition ---------------------------------------------------------

# The storage API versions this plugin was checked against. 11 introduced the
# backup provider interface (PVE 8.4: APIVER 11, APIAGE 2). The changes up to
# 16 (pve-storage ApiChangeLog) touch only what this plugin does not use:
#   12  qemu_blockdev_options, rename_snapshot, volume_qemu_snapshot_method,
#       get_formats (the default keeps the plugindata behaviour)
#   13  $hints for activate_volume/map_volume (ignored here), on_update_hook_full
#   14  get_identity (optional; the base implementation dies)
#   15  $snapname for volume_resize, virtual-size in volume_snapshot_info
#       (no images, no snapshots here)
#   16  volname_for_format and friends, called only by the base alloc_image and
#       rename_volume (alloc_image dies here, rename is not offered)
use constant MIN_API => 11;
use constant MAX_VERIFIED_API => 16;

# api: the running APIVER while it lies in the verified range, so PVE 9.x does
# not warn about "an older storage API" on every pveum/pvesm call. A newer PVE
# gets the newest verified version: it loads (and warns) while APIAGE still
# accepts it and is refused by PVE itself once it does not. Without
# PVE::Storage loaded (tests, perl -c) the minimum.
sub api {
    my $apiver = _pve_storage_apiver();
    return MIN_API if !defined($apiver);
    return $apiver if $apiver >= MIN_API && $apiver <= MAX_VERIFIED_API;
    return MAX_VERIFIED_API if $apiver > MAX_VERIFIED_API;
    # Older than the backup provider interface: PVE refuses it with a clear message.
    return MIN_API;
}

# The APIVER of the running PVE::Storage (which loads this plugin), else undef.
sub _pve_storage_apiver {
    my $apiver = UNIVERSAL::can('PVE::Storage', 'APIVER');
    return $apiver ? $apiver->() : undef;
}

sub type {
    return 'restow';
}

sub plugindata {
    return {
        content => [{ backup => 1 }, { backup => 1 }],
        features => { 'backup-provider' => 1 },
    };
}

sub properties {
    return {};
}

sub options {
    return {
        nodes => { optional => 1 },
        disable => { optional => 1 },
        content => { optional => 1 },
    };
}

sub new_backup_provider {
    my ($class, $scfg, $storeid, $log_function) = @_;
    return PVE::BackupProvider::Plugin::Restow->new($class, $scfg, $storeid, $log_function);
}

# --- volumes ---------------------------------------------------------------------

my $VOLNAME_RE = qr!^backup/((vm|ct)/(\d+)/[0-9TZ:-]+)$!;

sub parse_volname {
    my ($class, $volname) = @_;
    if ($volname =~ $VOLNAME_RE) {
        my ($name, $kind, $vmid) = ($1, $2, $3);
        return ('backup', $name, $vmid, undef, undef, undef, "restow-$kind");
    }
    die "unable to parse restow volume name '$volname'\n";
}

sub path {
    my ($class, $scfg, $volname, $storeid, $snapname) = @_;
    my ($vtype, $name, $vmid) = $class->parse_volname($volname);
    # Not a file: restores go through the backup provider.
    return ("restow://$storeid/$volname", $vmid, $vtype);
}

sub filesystem_path {
    my ($class, $scfg, $volname, $snapname) = @_;
    my ($vtype, $name, $vmid) = $class->parse_volname($volname);
    return wantarray ? ("restow://$volname", $vmid, $vtype) : "restow://$volname";
}

sub list_images {
    return [];
}

sub list_volumes {
    my ($class, $storeid, $scfg, $vmid, $content_types) = @_;
    return [] if !grep { $_ eq 'backup' } @{ $content_types // ['backup'] };
    my $result = eval {
        call_helper('list-volumes', { storeid => $storeid, (defined($vmid) ? (vmid => int($vmid)) : ()) }, undef, 10);
    };
    if (my $err = $@) {
        warn "restow: listing backups failed: $err";
        return [];
    }
    my $res = [];
    for my $v (@{ $result->{volumes} // [] }) {
        push @$res, {
            volid => "$storeid:$v->{volname}",
            format => $v->{format},
            size => $v->{size},
            ctime => $v->{ctime},
            vmid => $v->{vmid},
            subtype => $v->{subtype},
            content => 'backup',
        };
    }
    return $res;
}

sub status {
    my ($class, $storeid, $scfg, $cache) = @_;
    my $s = eval { call_helper('storage-status', { storeid => $storeid }, undef, 5) };
    return (0, 0, 0, 0) if $@ || !$s;
    return ($s->{total} // 0, $s->{avail} // 0, $s->{used} // 0, $s->{active} ? 1 : 0);
}

sub activate_storage {
    my ($class, $storeid, $scfg, $cache) = @_;
    die "restow-pve is not installed on this node ($HELPER)\n" if !-x $HELPER;
    return 1;
}

sub deactivate_storage {
    return 1;
}

sub check_connection {
    return 1;
}

sub activate_volume {
    return 1;
}

sub deactivate_volume {
    return 1;
}

sub volume_size_info {
    my ($class, $scfg, $storeid, $volname, $timeout) = @_;
    my ($vtype, $name, $vmid) = $class->parse_volname($volname);
    for my $v (@{ $class->list_volumes($storeid, $scfg, $vmid, ['backup']) }) {
        return wantarray ? ($v->{size}, 'raw', $v->{size}, undef) : $v->{size}
            if $v->{volid} eq "$storeid:$volname";
    }
    die "restow: volume '$volname' not found\n";
}

sub get_volume_attribute {
    return undef;
}

sub update_volume_attribute {
    die "restow: notes and protection of restore points are managed in Restow\n";
}

sub alloc_image {
    die "restow: this storage holds backups only\n";
}

sub free_image {
    die "restow: restore points cannot be deleted from Proxmox VE; retention is managed in Restow\n";
}

sub create_base {
    die "restow: not supported\n";
}

sub clone_image {
    die "restow: not supported\n";
}

sub prune_backups {
    die "restow: pruning is not done by Proxmox VE; retention is managed in Restow\n";
}

sub volume_snapshot {
    die "restow: not supported\n";
}

sub volume_has_feature {
    return undef;
}

sub on_add_hook {
    return undef;
}

sub on_delete_hook {
    return undef;
}

1;
