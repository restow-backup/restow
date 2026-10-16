#!/bin/sh
# Builds the guest disk images the guest file system readers are tested against
# (guestfs.test.ts). Run as root on Linux with e2fsprogs, xfsprogs, ntfs-3g, dosfstools,
# mtools, gdisk, fdisk and lvm2; the images are committed gzipped, so CI needs none of it.
#
#   sh packages/core/src/pve/guestfs/testdata/make-fixtures.sh
#
# Every image holds the same tree (see tree() below); the tests compare against it.
set -eu
out="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
cleanup() {
  umount "$work/mnt" 2>/dev/null || true
  for d in $(losetup -j "$work/disk.img" -O NAME -n 2>/dev/null); do losetup -d "$d"; done
  vgchange -an fixvg >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/mnt"

tree() {
  root="$1"
  mkdir -p "$root/etc" "$root/home/anna/Documents" "$root/var/log" "$root/many" "$root/empty"
  printf 'web01\n' > "$root/etc/hostname"
  printf 'root:x:0:0:root:/root:/bin/sh\n' > "$root/etc/passwd"
  printf 'Hello Anna\n' > "$root/home/anna/notes.txt"
  printf 'Quarterly report\n' > "$root/home/anna/Documents/report 2026.txt"
  printf 'unicode\n' > "$root/home/anna/ümlaut-é.txt"
  # 300 KiB + 123 bytes of a fixed pattern (the tests rebuild it).
  python3 -c "
import sys
data = bytearray()
i = 0
while len(data) < 300 * 1024 + 123:
    data += (i * 2654435761 % 4294967296).to_bytes(4, 'little'); i += 1
sys.stdout.buffer.write(bytes(data[: 300 * 1024 + 123]))
" > "$root/var/log/big.bin"
  i=0
  while [ $i -lt 300 ]; do
    printf 'entry %d\n' "$i" > "$root/many/file-with-a-rather-long-name-$(printf %03d $i).txt"
    i=$((i + 1))
  done
  ln -s /etc/hostname "$root/link" 2>/dev/null || true
}

tree "$work/tree"

# 1. GPT: an EFI system partition (FAT) and ext4 with the tree.
truncate -s 48M "$work/disk.img"
sgdisk -n 1:2048:+8M -t 1:EF00 -c 1:EFI -n 2:0:0 -t 2:8300 -c 2:root "$work/disk.img" >/dev/null
mkfs.vfat --invariant -F 16 -s 1 -n EFI --offset 2048 "$work/disk.img" 8192 >/dev/null
printf 'efi\n' > "$work/BOOTX64.EFI"
printf 'long name\n' > "$work/Long File Name.txt"
MTOOLS_SKIP_CHECK=1 mmd -i "$work/disk.img@@1M" ::/EFI ::/EFI/BOOT
MTOOLS_SKIP_CHECK=1 mcopy -i "$work/disk.img@@1M" "$work/BOOTX64.EFI" ::/EFI/BOOT/
MTOOLS_SKIP_CHECK=1 mcopy -i "$work/disk.img@@1M" "$work/Long File Name.txt" ::/
start=$(sgdisk -i 2 "$work/disk.img" | sed -n 's/^First sector: \([0-9]*\).*/\1/p')
mkfs.ext4 -q -L root -b 4096 -O ^has_journal -E offset=$((start * 512)) -d "$work/tree" "$work/disk.img" 9M
gzip -9 -n -c "$work/disk.img" > "$out/gpt-efi-ext4.img.gz"
rm "$work/disk.img"

# 2. ext2 with 1 KiB blocks on the whole disk: the classic block map with indirect blocks.
truncate -s 8M "$work/disk.img"
mkfs.ext2 -q -L legacy -b 1024 -d "$work/tree" "$work/disk.img"
gzip -9 -n -c "$work/disk.img" > "$out/raw-ext2.img.gz"
rm "$work/disk.img"

# 3. MBR with one NTFS partition (filled through ntfs-3g).
truncate -s 24M "$work/disk.img"
printf 'label: dos\nstart=2048, type=7\n' | sfdisk -q "$work/disk.img"
dev=$(losetup -f --show -o $((2048 * 512)) "$work/disk.img")
mkntfs -q -F -f -L DATA "$dev" >/dev/null
ntfs-3g "$dev" "$work/mnt"
cp -a "$work/tree/." "$work/mnt/"
rm -f "$work/mnt/link"
umount "$work/mnt"
losetup -d "$dev"
gzip -9 -n -c "$work/disk.img" > "$out/mbr-ntfs.img.gz"
rm "$work/disk.img"

# 4. MBR with an LVM PV: volume group fixvg with root (XFS, in two segments) and home (ext4
#    copied while mounted, so its journal may hold transactions not yet checkpointed). The
#    logical volumes are created without activating them (no device mapper needed); their
#    file systems are made in files and written to the extents LVM gave them.
truncate -s 300M "$work/root.xfs"
mkfs.xfs -q -L root "$work/root.xfs"
mount -o loop "$work/root.xfs" "$work/mnt"
cp -a "$work/tree/." "$work/mnt/"
umount "$work/mnt"
truncate -s 32M "$work/home.ext4"
mkfs.ext4 -q -L home "$work/home.ext4"
mount -o loop "$work/home.ext4" "$work/mnt"
cp -a "$work/tree/home/." "$work/mnt/"
printf 'written last\n' > "$work/mnt/journal.txt"
sync
cp --sparse=always "$work/home.ext4" "$work/home-mounted.ext4"
umount "$work/mnt"
truncate -s 400M "$work/disk.img"
printf 'label: dos\nstart=2048, type=8e\n' | sfdisk -q "$work/disk.img"
dev=$(losetup -f --show -o $((2048 * 512)) "$work/disk.img")
pvcreate -q "$dev"
vgcreate -q -s 4M fixvg "$dev"
# The logical volumes go in through vgcfgrestore (lvcreate needs the device mapper): root in
# two segments around home, as after an lvextend.
vgcfgbackup -q -f "$work/vg.txt" fixvg >/dev/null
python3 - "$work/vg.txt" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
def lv(name, uid, segments):
    segs = "".join(
        f"""
            segment{n} {{
                start_extent = {start}
                extent_count = {count}
                type = "striped"
                stripe_count = 1
                stripes = [
                    "pv0", {pe}
                ]
            }}"""
        for n, (start, count, pe) in enumerate(segments, 1)
    )
    return f"""
        {name} {{
            id = "{uid}"
            status = ["READ", "WRITE", "VISIBLE"]
            flags = []
            creation_time = 1
            creation_host = "fixture"
            segment_count = {len(segments)}
{segs}
        }}"""
lvs = "\n        logical_volumes {" + lv("root", "r00t00-aaaa-bbbb-cccc-dddd-eeee-ffffff", [(0, 38, 0), (38, 37, 46)]) + lv("home", "h0me00-aaaa-bbbb-cccc-dddd-eeee-ffffff", [(0, 8, 38)]) + "\n        }\n"
end = text.rindex("}", 0, text.rindex("}"))  # the end of physical_volumes
text = text[: end + 1] + lvs + text[end + 1 :]
open(path, "w").write(text)
PY
vgcfgrestore -q -f "$work/vg.txt" fixvg
lvs --noheadings -o lv_name,seg_start_pe,seg_pe_ranges fixvg
pe_start=$(pvs --noheadings --units b --nosuffix -o pe_start "$dev" | tr -d ' ')
base=$((2048 * 512 + pe_start))
extent=$((4 * 1024 * 1024))
dd if="$work/root.xfs" of="$work/disk.img" bs=$extent count=38 conv=notrunc,sparse oflag=seek_bytes seek=$base status=none
dd if="$work/root.xfs" of="$work/disk.img" bs=$extent skip=38 count=37 conv=notrunc,sparse oflag=seek_bytes seek=$((base + 46 * extent)) status=none
dd if="$work/home-mounted.ext4" of="$work/disk.img" bs=$extent count=8 conv=notrunc,sparse oflag=seek_bytes seek=$((base + 38 * extent)) status=none
vgchange -q -an fixvg >/dev/null 2>&1 || true
losetup -d "$dev"
gzip -9 -n -c "$work/disk.img" > "$out/mbr-lvm-xfs-ext4.img.gz"
echo "fixtures written to $out"
