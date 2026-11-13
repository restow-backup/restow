# SPDX-License-Identifier: GPL-3.0-or-later
# shellcheck shell=sh
#
# The test machine factory of the recovery end-to-end tests (README.md, "Check";
# the cases are those of the CI job recovery-e2e). A machine script runs as root
# inside a VM that booted the recovery ISO itself, which has every disk tool. The
# VM has a second, read-only disk with the label RESTOWFACTORY that holds the
# .deb files of debootstrap, of what it needs that the ISO lacks (wget, distro-info
# and their libraries; scripts/recovery-e2e/factory-debs.mjs) and of the archive
# keyrings, all from the same snapshot (the ISO's package list stays as it is), and
# the target disks with serial numbers.
#
# What every machine gets besides its own layout:
#   - a kernel, its initramfs generator and a boot loader of the distribution;
#   - /var/lib/restow-e2e/marker (random bytes) and the unit restow-e2e-boot, which
#     prints "E2E-BOOT <hostname> <sha256 of the marker>" on ttyS0 after every boot;
#   - the unit restow-e2e-enroll, which at the first boot reads the instance address
#     and a one-time enrollment token from fw_cfg (opt/restow/enroll) and installs the
#     agent with the instance's own linux.sh.
# File systems are created with the features of the source distribution, never
# with the defaults of the ISO's newer tools.

FACTORY_MEDIA=/run/restow-factory
E2E_DIR=/var/lib/restow-e2e

fdie() {
  printf 'factory: %s\n' "$*" >&2
  exit 1
}

say() {
  printf 'factory: %s\n' "$*"
}

# The disk whose serial number is <serial> (QEMU: -device ...,serial=<serial>).
disk_by_serial() {
  serial="$1"
  for link in /dev/disk/by-id/virtio-"$serial" /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_"$serial" \
    /dev/disk/by-id/ata-QEMU_HARDDISK_"$serial" /dev/disk/by-id/nvme-QEMU_NVMe_Ctrl_"$serial"; do
    if [ -e "$link" ]; then
      readlink -f "$link"
      return 0
    fi
  done
  fdie "no disk with the serial number $serial"
}

# Partition <n> of a disk (sda1, vda1, nvme0n1p1).
part() {
  case "$1" in
    *[0-9]) printf '%sp%s\n' "$1" "$2" ;;
    *) printf '%s%s\n' "$1" "$2" ;;
  esac
}

# Make the factory medium's tools available in the live overlay.
factory_prepare() {
  mkdir -p "$FACTORY_MEDIA"
  dev=$(blkid -L RESTOWFACTORY) || fdie "the factory disk (label RESTOWFACTORY) is missing"
  mountpoint -q "$FACTORY_MEDIA" || mount -o ro "$dev" "$FACTORY_MEDIA"
  dpkg -i "$FACTORY_MEDIA"/debs/*.deb >/dev/null
  command -v debootstrap >/dev/null 2>&1 || fdie "debootstrap did not install"
}

# The ext4 features of a source distribution (its mke2fs.conf), so that its own
# e2fsck and GRUB can read the file system.
ext4_features() {
  case "$1" in
    debian12 | ubuntu2204) echo "has_journal,extent,huge_file,flex_bg,metadata_csum,64bit,dir_nlink,extra_isize,^orphan_file,^metadata_csum_seed" ;;
    ubuntu2404 | debian13) echo "has_journal,extent,huge_file,flex_bg,metadata_csum,64bit,dir_nlink,extra_isize" ;;
    *) fdie "no ext4 feature list for $1" ;;
  esac
}

mkfs_ext4() {
  dist="$1"
  dev="$2"
  label="$3"
  mkfs.ext4 -q -F -O "$(ext4_features "$dist")" -L "$label" "$dev"
}

# debootstrap of <suite> from <mirror> into <root>, with the keyring of the factory medium.
bootstrap() {
  suite="$1"
  root="$2"
  mirror="$3"
  keyring="$4"
  shift 4
  debootstrap --keyring="$FACTORY_MEDIA/keyrings/$keyring" --variant=minbase \
    --include="systemd-sysv,udev,kmod,ca-certificates,curl,openssh-client,$(printf '%s' "$*" | tr ' ' ',')" \
    "$suite" "$root" "$mirror"
}

# Bind the API file systems for work inside <root>, and undo it.
chroot_mount() {
  for dir in dev dev/pts proc sys run; do
    mkdir -p "$1/$dir"
    mount --bind "/$dir" "$1/$dir"
  done
}

chroot_umount() {
  for dir in run sys proc dev/pts dev; do
    umount -l "$1/$dir" 2>/dev/null || true
  done
}

in_root() {
  root="$1"
  shift
  chroot "$root" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive "$@"
}

# fstab line by UUID.
fstab_uuid() {
  printf 'UUID=%s %s %s %s 0 %s\n' "$(blkid -s UUID -o value "$1")" "$2" "$3" "$4" "$5"
}

# The marker, the boot unit and the enroll unit (C-M4-7).
install_e2e_units() {
  root="$1"
  hostname="$2"
  printf '%s\n' "$hostname" >"$root/etc/hostname"
  mkdir -p "$root$E2E_DIR"
  head -c 4096 /dev/urandom >"$root$E2E_DIR/marker"
  chmod 0600 "$root$E2E_DIR/marker"
  cat >"$root/usr/local/sbin/restow-e2e-boot" <<'SCRIPT'
#!/bin/sh
sum=$(sha256sum /var/lib/restow-e2e/marker | cut -d ' ' -f 1)
printf 'E2E-BOOT %s %s\n' "$(cat /etc/hostname)" "$sum" >/dev/ttyS0
SCRIPT
  cat >"$root/usr/local/sbin/restow-e2e-enroll" <<'SCRIPT'
#!/bin/sh
# The instance and a one-time token from fw_cfg; once only.
set -eu
[ -f /etc/restow-agent/state.json ] && exit 0
cfg=/sys/firmware/qemu_fw_cfg/by_name/opt/restow/enroll/raw
modprobe qemu_fw_cfg 2>/dev/null || true
[ -r "$cfg" ] || exit 0
url=$(sed -n 's/^url=//p' "$cfg")
umask 077
sed -n 's/^token=//p' "$cfg" >/root/restow.token
# The test instance speaks plain HTTP on QEMU's host address, or HTTPS with a CA of its own.
set --
[ -f /etc/restow-e2e/ca.pem ] && set -- --cacert /etc/restow-e2e/ca.pem
curl -fsS "$@" "$url/install/linux.sh" -o /root/linux.sh
case "$url" in http://*) export RESTOW_ALLOW_INSECURE_HTTP=1 ;; esac
RESTOW_TOKEN_FILE=/root/restow.token sh /root/linux.sh
rm -f /root/restow.token /root/linux.sh
SCRIPT
  chmod 0755 "$root/usr/local/sbin/restow-e2e-boot" "$root/usr/local/sbin/restow-e2e-enroll"
  cat >"$root/etc/systemd/system/restow-e2e-boot.service" <<'UNIT'
[Unit]
Description=Restow end-to-end boot marker
After=multi-user.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/restow-e2e-boot

[Install]
WantedBy=multi-user.target
UNIT
  cat >"$root/etc/systemd/system/restow-e2e-enroll.service" <<'UNIT'
[Unit]
Description=Restow end-to-end agent enrollment
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/restow-e2e-enroll
# On the serial console too: a failed enrollment names its reason in the CI log.
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
UNIT
  mkdir -p "$root/etc/restow-e2e"
  if [ -f "$FACTORY_MEDIA/ca.pem" ]; then
    cp "$FACTORY_MEDIA/ca.pem" "$root/etc/restow-e2e/ca.pem"
  fi
  in_root "$root" systemctl enable restow-e2e-boot.service restow-e2e-enroll.service >/dev/null
}

# A root password nobody knows, DHCP by systemd-networkd and name resolution by
# systemd-resolved. debootstrap copies the factory's resolv.conf (the stub resolver
# 127.0.0.53) as a file; without systemd-resolved running in the machine nobody
# answers there. Debian 12 and 13 and Ubuntu 24.04 ship systemd-resolved as a package
# of its own, Ubuntu 22.04 inside systemd. Runs inside chroot_mount.
finish_root() {
  root="$1"
  in_root "$root" passwd -l root >/dev/null
  cat >"$root/etc/systemd/network/80-e2e.network" <<'NET'
[Match]
Type=ether

[Network]
DHCP=yes
NET
  in_root "$root" systemctl enable systemd-networkd.service >/dev/null 2>&1 || true
  if [ ! -e "$root/usr/lib/systemd/systemd-resolved" ] && [ ! -e "$root/lib/systemd/systemd-resolved" ]; then
    in_root "$root" apt-get install -y --no-install-recommends systemd-resolved >/dev/null ||
      fdie "systemd-resolved did not install"
  fi
  in_root "$root" systemctl enable systemd-resolved.service >/dev/null 2>&1 || true
  ln -sf ../run/systemd/resolve/stub-resolv.conf "$root/etc/resolv.conf"
}

# Unmount everything below <root> and stop what the factory started.
release_all() {
  root="$1"
  chroot_umount "$root"
  umount -R "$root" 2>/dev/null || true
  swapoff -a 2>/dev/null || true
  vgchange -an >/dev/null 2>&1 || true
  for map in /dev/mapper/*; do
    [ "$map" = /dev/mapper/control ] && continue
    if [ -e "$map" ]; then
      cryptsetup close "$(basename "$map")" 2>/dev/null || true
    fi
  done
  mdadm --stop --scan >/dev/null 2>&1 || true
  sync
}
