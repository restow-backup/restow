#!/usr/bin/perl
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Tests of the Restow storage plugin shim outside Proxmox VE: the shim is
# installed into a temporary tree the way the installer lays it out, loaded
# against stub base classes (t/stubs), and driven in the order vzdump and the
# restore code call a backup provider, with a stand-in for restow-pve that
# records every call.
#
#   prove integrations/pve/plugin/t/
use strict;
use warnings;

use File::Basename qw(dirname);
use File::Copy qw(copy);
use File::Path qw(make_path);
use File::Spec;
use File::Temp qw(tempdir);
use JSON::PP;
use Test::More;

my $here = File::Spec->rel2abs(dirname(__FILE__));
my $src = dirname($here);
my $tree = tempdir(CLEANUP => 1);
make_path("$tree/PVE/Storage/Custom", "$tree/PVE/BackupProvider/Plugin");
copy("$src/RestowPlugin.pm", "$tree/PVE/Storage/Custom/RestowPlugin.pm") or die $!;
copy("$src/RestowProvider.pm", "$tree/PVE/BackupProvider/Plugin/Restow.pm") or die $!;

# perl -c of both files against the stubs.
for my $file ("$tree/PVE/Storage/Custom/RestowPlugin.pm", "$tree/PVE/BackupProvider/Plugin/Restow.pm") {
    my $out = `$^X -I$tree -I$here/stubs -c $file 2>&1`;
    is($?, 0, "perl -c $file") or diag($out);
}

unshift @INC, $tree, "$here/stubs";
require PVE::Storage::Custom::RestowPlugin;

my $log = "$tree/calls.log";
$ENV{FAKE_RESTOW_LOG} = $log;
chmod(0755, "$here/fake-restow-pve");
$PVE::Storage::Custom::RestowPlugin::HELPER = "$here/fake-restow-pve";

sub calls {
    open(my $fh, '<', $log) or return ();
    my @c = map { JSON::PP->new->decode($_) } <$fh>;
    close($fh);
    unlink($log);
    return @c;
}

my $plugin = 'PVE::Storage::Custom::RestowPlugin';
is($plugin->api, 11, 'storage API version 11 (PVE 8.4) and newer');
is($plugin->type, 'restow', 'type');
is($plugin->plugindata->{features}->{'backup-provider'}, 1, 'declares the backup-provider feature');

my @logged;
my $logf = sub { push @logged, [@_] };
my $p = $plugin->new_backup_provider({ type => 'restow' }, 'restow', $logf);
isa_ok($p, 'PVE::BackupProvider::Plugin::Restow');
isa_ok($p, 'PVE::BackupProvider::Plugin::Base');
is($p->provider_name, 'Restow', 'provider name');

# --- a VM backup in the documented order -------------------------------------
$p->job_init(1790000000);
my $init = $p->backup_init(101, 'qemu', 1790000000);
is($init->{'archive-name'}, 'vm/101/2026-10-03T22:00:00Z', 'archive name from restow-pve');
is($p->backup_get_mechanism(101, 'qemu'), 'nbd', 'VM mechanism nbd');
my $inc = $p->backup_vm_query_incremental(101, { 'drive-scsi0' => { size => 4194304 } });
is($inc->{'drive-scsi0'}, 'use', 'incremental answer passed through');
$p->backup_vm(101, "scsi0: local-lvm:vm-101-disk-0\n", {
    'drive-scsi0' => { size => 4194304, 'bitmap-mode' => 'reuse', 'nbd-path' => '/run/x.sock', 'bitmap-name' => 'snapshot-access:restow' },
}, { 'bandwidth-limit' => 1048576, 'firewall-config' => "[OPTIONS]\n" });
my $cleanup = $p->backup_cleanup(101, 'qemu', 1, {});
is($cleanup->{stats}->{'archive-size'}, 1234, 'archive size');
$p->backup_handle_log_file(101, '/var/log/vzdump/qemu-101.log');
$p->job_cleanup();

my @c = calls();
is_deeply([map { $_->{verb} } @c], [qw(job-init backup-init backup-get-mechanism backup-vm-query-incremental backup-vm backup-cleanup backup-handle-log-file job-cleanup)], 'verbs in order');
is($c[0]->{request}->{storeid}, 'restow', 'storeid passed');
my $vm = $c[4]->{request};
is($vm->{volumes}->{'drive-scsi0'}->{bitmapMode}, 'reuse', 'bitmap mode translated');
is($vm->{volumes}->{'drive-scsi0'}->{nbdPath}, '/run/x.sock', 'NBD path translated');
is($vm->{info}->{bandwidthLimit}, 1048576, 'bandwidth limit translated');
is($vm->{info}->{firewallConfig}, "[OPTIONS]\n", 'firewall config passed');
ok($c[5]->{request}->{success}, 'success flag is a JSON boolean');
ok((grep { $_->[0] eq 'info' && $_->[1] eq 'backup-vm called' } @logged), 'stderr lines reach the task log');
ok((grep { $_->[0] eq 'warn' && $_->[1] eq 'a warning' } @logged), 'a last line without newline is relayed');

# --- a container backup ------------------------------------------------------
$p->backup_init(200, 'lxc', 1790000000);
is($p->backup_get_mechanism(200, 'lxc'), 'directory', 'CT mechanism directory');
$p->backup_container_prepare(200, { directory => '/mnt/vzsnap0', sources => ['.'], 'backup-user-id' => 100000 });
$p->backup_container(200, "arch: amd64\n", ['/var/cache/**'], { directory => '/mnt/vzsnap0', sources => ['.'], 'backup-user-id' => 100000 });
$p->backup_cleanup(200, 'lxc', 0, { error => 'boom' });
@c = calls();
is($c[2]->{request}->{info}->{backupUserId}, 100000, 'backup user id translated');
is_deeply($c[3]->{request}->{excludePatterns}, ['/var/cache/**'], 'exclude patterns passed');
ok(!$c[4]->{request}->{success}, 'failure flag');
is($c[4]->{request}->{info}->{error}, 'boom', 'error passed');

# --- restore -----------------------------------------------------------------
my ($mech, $type) = $p->restore_get_mechanism('backup/vm/101/2026-10-03T22:00:00Z');
is("$mech/$type", 'qemu-img/qemu', 'restore mechanism');
is($p->archive_get_guest_config('backup/vm/101/2026-10-03T22:00:00Z'), "scsi0: x\n", 'guest config');
is($p->archive_get_firewall_config('backup/vm/101/2026-10-03T22:00:00Z'), undef, 'no firewall config');
is($p->restore_vm_init('x')->{'drive-scsi0'}->{size}, 4194304, 'restore devices');
is($p->restore_vm_volume_init('x', 'drive-scsi0', {})->{'qemu-img-path'}, 'nbd+unix:///drive-scsi0?socket=/run/x.sock', 'qemu-img path');
$p->restore_vm_volume_cleanup('x', 'drive-scsi0', {});
$p->restore_vm_cleanup('x');
is($p->restore_container_init('y', {})->{'archive-directory'}, '/var/tmp/restow-pve/ct', 'container directory');
$p->restore_container_cleanup('y', {});
calls();

# --- storage plugin ----------------------------------------------------------
my @st = $plugin->status('restow', {}, {});
is_deeply(\@st, [100, 60, 40, 1], 'status from the cache');
my $vols = $plugin->list_volumes('restow', {}, 101, ['backup']);
is($vols->[0]->{volid}, 'restow:backup/vm/101/2026-10-03T22:00:00Z', 'volume id');
is($vols->[0]->{content}, 'backup', 'content type');
is_deeply($plugin->list_volumes('restow', {}, undef, ['images']), [], 'no images');
my @parsed = $plugin->parse_volname('backup/ct/200/2026-10-03T22:00:00Z');
is_deeply([@parsed[0, 1, 2]], ['backup', 'ct/200/2026-10-03T22:00:00Z', 200], 'parse_volname');
eval { $plugin->parse_volname('images/vm-1-disk-0') };
like($@, qr/unable to parse/, 'foreign volume names are refused');
eval { $plugin->free_image('restow', {}, 'backup/vm/101/2026-10-03T22:00:00Z') };
like($@, qr/retention is managed in Restow/, 'deleting a restore point is refused');
eval { $plugin->prune_backups({}, 'restow', {}, 101, 'qemu', 0, sub { }) };
like($@, qr/retention is managed in Restow/, 'pruning is refused');
calls();

# --- errors ------------------------------------------------------------------
eval { PVE::Storage::Custom::RestowPlugin::call_helper('fail', {}, sub { }) };
like($@, qr/it failed on purpose/, 'helper errors become Perl errors');
{
    local $PVE::Storage::Custom::RestowPlugin::HELPER = '/nonexistent/restow-pve';
    eval { $plugin->activate_storage('restow', {}, {}) };
    like($@, qr/not installed/, 'missing helper is reported');
    is_deeply([$plugin->status('restow', {}, {})], [0, 0, 0, 0], 'status never dies');
}

done_testing();
