#!/usr/bin/perl -T
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# The shim under taint mode, as pvedaemon and pveproxy run it (perl -T): what
# restow-pve answers is tainted there, and PVE dies with "Insecure dependency
# in exec" once such a value reaches a command (tar --directory=<archive
# directory> in a container restore from the web UI). Every value the shim
# hands back to PVE must be untainted, and a value that does not look like what
# restow-pve sends must be refused.
#
#   prove integrations/pve/plugin/t/
use strict;
use warnings;

use File::Copy qw(copy);
use File::Path qw(make_path);
use File::Temp qw(tempdir);
use JSON::PP;
use Scalar::Util qw(tainted);
use Test::More;

# What pvedaemon starts with: a fixed PATH and no shell variables.
$ENV{PATH} = '/usr/bin:/bin';
delete @ENV{qw(IFS CDPATH ENV BASH_ENV)};

my ($here) = (__FILE__ =~ m{^(.*)/[^/]+$}) ? ($1) : ('.');
($here) = ($here =~ m{^([^\0]+)$});
my $src = "$here/..";
my ($tree) = (tempdir(CLEANUP => 1) =~ m{^([^\0]+)$});
make_path("$tree/PVE/Storage/Custom", "$tree/PVE/BackupProvider/Plugin");
copy("$src/RestowPlugin.pm", "$tree/PVE/Storage/Custom/RestowPlugin.pm") or die $!;
copy("$src/RestowProvider.pm", "$tree/PVE/BackupProvider/Plugin/Restow.pm") or die $!;
unshift @INC, $tree, "$here/stubs";
require PVE::Storage::Custom::RestowPlugin;

ok(${^TAINT}, 'taint mode is on');

chmod(0755, "$here/fake-restow-pve");
{
    no warnings 'once';
    $PVE::Storage::Custom::RestowPlugin::HELPER = "$here/fake-restow-pve";
}
$ENV{FAKE_RESTOW_LOG} = "$tree/calls.log";

my $plugin = 'PVE::Storage::Custom::RestowPlugin';
my $p = $plugin->new_backup_provider({ type => 'restow' }, 'restow', sub { });

# Untainted, and usable on a command line as PVE uses it.
sub clean {
    my ($value, $name) = @_;
    ok(!tainted($value), "$name is untainted") or return;
    ok(eval { system('/bin/true', $value); 1 }, "$name can reach a command") or diag($@);
}

my $vol = 'backup/ct/124/2026-11-14T20:00:00Z';
my $dir = $p->restore_container_init($vol, 'restow', {})->{'archive-directory'};
is($dir, "/var/tmp/restow-pve/ct-$vol-1/root", 'archive directory');
clean($dir, 'archive directory');
$p->restore_container_cleanup($vol, 'restow', {});

my ($mechanism, $vmtype) = $p->restore_get_mechanism('backup/vm/101/2026-11-14T20:00:00Z');
clean($mechanism, 'restore mechanism');
clean($vmtype, 'guest type');

my $devices = $p->restore_vm_init('backup/vm/101/2026-11-14T20:00:00Z');
is_deeply($devices, { 'drive-scsi0' => { size => 4194304 } }, 'disks of a VM restore point');
for my $name (keys %$devices) {
    clean($name, 'device name');
    clean($devices->{$name}->{size}, 'disk size');
}
my $nbd = $p->restore_vm_volume_init('backup/vm/101/2026-11-14T20:00:00Z', 'drive-scsi0', {})->{'qemu-img-path'};
is($nbd, 'nbd+unix:///drive-scsi0?socket=/run/x.sock', 'disk address');
clean($nbd, 'disk address');

clean($p->backup_init(101, 'qemu', 1)->{'archive-name'}, 'archive name');
clean($p->backup_get_mechanism(101, 'qemu'), 'backup mechanism');
my $inc = $p->backup_vm_query_incremental(101, { 'drive-scsi0' => { size => 1 } });
is_deeply($inc, { 'drive-scsi0' => 'use' }, 'bitmap modes');
clean($_, 'bitmap mode') for values %$inc;
clean($p->backup_cleanup(101, 'qemu', 1, {})->{stats}->{'archive-size'}, 'archive size');

my ($volume) = @{ $plugin->list_volumes('restow', {}, undef, ['backup']) };
clean($volume->{$_}, "listed $_") for qw(volid format size ctime vmid subtype);
clean($_, 'storage figure') for $plugin->status('restow', {}, {});
clean(scalar($plugin->volume_size_info({}, 'restow', 'backup/vm/101/2026-10-03T22:00:00Z')), 'volume size');

# Refused: anything that is not what restow-pve sends.
my @bad = (
    ['restore-container-init', { archiveDirectory => 'relative/root' }, 'archive directory'],
    ['restore-container-init', { archiveDirectory => '/var/tmp/../../etc' }, 'archive directory'],
    ['restore-container-init', { archiveDirectory => "/var/tmp/x\n/root" }, 'archive directory'],
    ['restore-container-init', { archiveDirectory => '/var/tmp/x y' }, 'archive directory'],
    ['restore-container-init', {}, 'archive directory'],
    ['restore-vm-volume-init', { qemuImgPath => '/dev/sda' }, 'disk address'],
    ['restore-vm-volume-init', { qemuImgPath => 'nbd+unix:///d?socket=/run/../etc/x' }, 'disk address'],
    ['restore-vm-init', { devices => { 'drive-scsi0' => { size => '1; rm -rf /' } } }, 'disk size'],
    ['restore-get-mechanism', { mechanism => 'shell', vmtype => 'qemu' }, 'restore mechanism'],
);
for my $case (@bad) {
    my ($verb, $result, $what) = @$case;
    local $ENV{FAKE_RESTOW_OVERRIDE} = JSON::PP->new->encode({ $verb => $result });
    my $ok = eval {
        if ($verb eq 'restore-container-init') { $p->restore_container_init('backup/ct/1/x', {}) }
        elsif ($verb eq 'restore-vm-volume-init') { $p->restore_vm_volume_init('backup/vm/1/x', 'drive-scsi0', {}) }
        elsif ($verb eq 'restore-vm-init') { $p->restore_vm_init('backup/vm/1/x') }
        else { $p->restore_get_mechanism('backup/vm/1/x') }
        1;
    };
    ok(!$ok, "$verb refuses " . JSON::PP->new->canonical->encode($result));
    like($@ // '', qr/\Q$what\E/, "the error names the $what");
}

# One odd restore point is left out of a listing, the others stay.
{
    local $ENV{FAKE_RESTOW_OVERRIDE} = JSON::PP->new->encode({ 'list-volumes' => { volumes => [
        { volname => 'backup/vm/101/2026-10-03T22:00:00Z', vmid => 101, ctime => 1, size => 5, subtype => 'qemu', format => 'restow-vm' },
        { volname => 'backup/vm/102/$(reboot)', vmid => 102, ctime => 1, size => 5, subtype => 'qemu', format => 'restow-vm' },
    ] } });
    local $SIG{__WARN__} = sub { };
    my $list = $plugin->list_volumes('restow', {}, undef, ['backup']);
    is_deeply([map { $_->{volid} } @$list], ['restow:backup/vm/101/2026-10-03T22:00:00Z'], 'an odd restore point is left out');
}

done_testing();
