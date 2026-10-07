# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Restow storage plugin shim for Proxmox VE: the backup provider.
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
# Installed as /usr/share/perl5/PVE/BackupProvider/Plugin/Restow.pm. Every
# method turns its arguments into one JSON request for
# `restow-pve provider <verb>` and its answer back into what PVE expects.
# No state is kept here: what crosses calls (the run, the archive name) is
# kept by restow-pve under /run/restow-pve, which also works for
# backup_container, which PVE runs forked and unprivileged.
package PVE::BackupProvider::Plugin::Restow;

use strict;
use warnings;

use JSON::PP ();

use base qw(PVE::BackupProvider::Plugin::Base);

sub new {
    my ($class, $storage_plugin, $scfg, $storeid, $log_function) = @_;
    my $self = bless {
        scfg => $scfg,
        storeid => $storeid,
        storage_plugin => $storage_plugin,
        log_function => $log_function,
    }, $class;
    return $self;
}

sub provider_name {
    return 'Restow';
}

sub helper {
    my ($self, $verb, $request) = @_;
    $request->{storeid} = $self->{storeid};
    return PVE::Storage::Custom::RestowPlugin::call_helper($verb, $request, $self->{log_function});
}

sub info_hash {
    my ($info) = @_;
    $info //= {};
    my $res = {};
    $res->{bandwidthLimit} = int($info->{'bandwidth-limit'}) if $info->{'bandwidth-limit'};
    $res->{firewallConfig} = $info->{'firewall-config'} if defined($info->{'firewall-config'});
    $res->{directory} = $info->{directory} if defined($info->{directory});
    $res->{sources} = $info->{sources} if defined($info->{sources});
    $res->{backupUserId} = int($info->{'backup-user-id'}) if defined($info->{'backup-user-id'});
    $res->{error} = "$info->{error}" if defined($info->{error});
    return $res;
}

# --- backup ------------------------------------------------------------------

sub job_init {
    my ($self, $start_time) = @_;
    $self->helper('job-init', { startTime => int($start_time // 0) });
    return;
}

sub job_cleanup {
    my ($self) = @_;
    $self->helper('job-cleanup', {});
    return;
}

sub backup_init {
    my ($self, $vmid, $vmtype, $start_time) = @_;
    my $res = $self->helper(
        'backup-init',
        { vmid => int($vmid), vmtype => $vmtype, startTime => int($start_time // 0) },
    );
    return { 'archive-name' => $res->{archiveName} };
}

sub backup_cleanup {
    my ($self, $vmid, $vmtype, $success, $info) = @_;
    my $res = $self->helper(
        'backup-cleanup',
        {
            vmid => int($vmid),
            vmtype => $vmtype,
            success => $success ? JSON::PP::true : JSON::PP::false,
            info => info_hash($info),
        },
    );
    return { stats => { 'archive-size' => int($res->{stats}->{archiveSize} // 0) } };
}

sub backup_get_mechanism {
    my ($self, $vmid, $vmtype) = @_;
    my $res = $self->helper('backup-get-mechanism', { vmid => int($vmid), vmtype => $vmtype });
    return $res->{mechanism};
}

sub backup_handle_log_file {
    my ($self, $vmid, $filename) = @_;
    $self->helper('backup-handle-log-file', { vmid => int($vmid), logFile => "$filename" });
    return;
}

sub backup_vm_query_incremental {
    my ($self, $vmid, $volumes) = @_;
    my $req = {};
    for my $device (keys %$volumes) {
        $req->{$device} = { size => int($volumes->{$device}->{size}) };
    }
    my $res = $self->helper('backup-vm-query-incremental', { vmid => int($vmid), volumes => $req });
    return $res->{devices};
}

sub backup_vm {
    my ($self, $vmid, $guest_config, $volumes, $info) = @_;
    my $req = {};
    for my $device (keys %$volumes) {
        my $v = $volumes->{$device};
        $req->{$device} = {
            size => int($v->{size}),
            bitmapMode => $v->{'bitmap-mode'} // 'none',
            (defined($v->{'nbd-path'}) ? (nbdPath => "$v->{'nbd-path'}") : ()),
            (defined($v->{'bitmap-name'}) ? (bitmapName => "$v->{'bitmap-name'}") : ()),
        };
    }
    $self->helper(
        'backup-vm',
        {
            vmid => int($vmid),
            vmtype => 'qemu',
            guestConfig => "$guest_config",
            volumes => $req,
            info => info_hash($info),
        },
    );
    return;
}

sub backup_container_prepare {
    my ($self, $vmid, $info) = @_;
    $self->helper('backup-container-prepare', { vmid => int($vmid), vmtype => 'lxc', info => info_hash($info) });
    return;
}

sub backup_container {
    my ($self, $vmid, $guest_config, $exclude_patterns, $info) = @_;
    $self->helper(
        'backup-container',
        {
            vmid => int($vmid),
            vmtype => 'lxc',
            guestConfig => "$guest_config",
            excludePatterns => [map {"$_"} @{ $exclude_patterns // [] }],
            info => info_hash($info),
        },
    );
    return;
}

# --- restore -----------------------------------------------------------------

sub restore_get_mechanism {
    my ($self, $volname) = @_;
    my $res = $self->helper('restore-get-mechanism', { volname => $volname });
    return ($res->{mechanism}, $res->{vmtype});
}

sub archive_get_guest_config {
    my ($self, $volname) = @_;
    return $self->helper('archive-get-guest-config', { volname => $volname })->{config};
}

sub archive_get_firewall_config {
    my ($self, $volname) = @_;
    return $self->helper('archive-get-firewall-config', { volname => $volname })->{config};
}

sub restore_vm_init {
    my ($self, $volname) = @_;
    return $self->helper('restore-vm-init', { volname => $volname })->{devices};
}

sub restore_vm_cleanup {
    my ($self, $volname) = @_;
    $self->helper('restore-vm-cleanup', { volname => $volname });
    return;
}

sub restore_vm_volume_init {
    my ($self, $volname, $device_name, $info) = @_;
    my $res = $self->helper(
        'restore-vm-volume-init',
        { volname => $volname, device => $device_name, info => info_hash($info) },
    );
    return { 'qemu-img-path' => $res->{qemuImgPath} };
}

sub restore_vm_volume_cleanup {
    my ($self, $volname, $device_name, $info) = @_;
    $self->helper('restore-vm-volume-cleanup', { volname => $volname, device => $device_name });
    return;
}

sub restore_container_init {
    my ($self, $volname, $info) = @_;
    my $res = $self->helper('restore-container-init', { volname => $volname, info => info_hash($info) });
    return { 'archive-directory' => $res->{archiveDirectory} };
}

sub restore_container_cleanup {
    my ($self, $volname, $info) = @_;
    $self->helper('restore-container-cleanup', { volname => $volname });
    return;
}

1;
