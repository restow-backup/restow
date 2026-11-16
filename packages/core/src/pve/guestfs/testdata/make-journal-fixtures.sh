#!/bin/sh
# Builds the ext4 images with hand-written jbd2 journals the journal replay is tested against
# (guestfs.test.ts, "the ext4 journal"). Needs e2fsprogs 1.47 (mkfs.ext4, debugfs with
# journal_open/journal_write, e2fsck), no root; make-fixtures.sh runs it as well.
#
#   sh packages/core/src/pve/guestfs/testdata/make-journal-fixtures.sh
#
# debugfs writes the transactions the way jbd2 does (descriptor, data, revoke and commit
# blocks, escaping a block that begins with the journal magic), and the file system is left
# marked "needs recovery", as in a restore point of a running guest. Before an image is kept,
# e2fsck replays a copy, and the file contents it leaves are the ones the tests expect.
set -eu
out="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

block() { # file, then per 4 KiB block the bytes it begins with (hex); the rest is zeros
  python3 -c "
import sys
data = bytearray(4096 * len(sys.argv[2:]))
for i, hexed in enumerate(sys.argv[2:]):
    raw = bytes.fromhex(hexed)
    data[i * 4096 : i * 4096 + len(raw)] = raw
open(sys.argv[1], 'wb').write(bytes(data))
" "$@"
}

image() { # name, mkfs features: an 8 MiB ext4 with a.txt, b.txt, c.txt
  rm -rf "$work/tree" && mkdir -p "$work/tree"
  printf 'old\nold\n' > "$work/tree/a.txt"
  printf 'bbb\n' > "$work/tree/b.txt"
  printf 'ccc\n' > "$work/tree/c.txt"
  rm -f "$work/$1.img" && truncate -s 8M "$work/$1.img"
  mkfs.ext4 -q -b 4096 -O "$2" -U 0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0 -L journal \
    -d "$work/tree" "$work/$1.img"
}

fsblock() { debugfs -R "bmap $2 0" "$work/$1.img" 2>/dev/null; }

keep() { # name, file, expected contents (hex) after e2fsck's replay
  cp "$work/$1.img" "$work/check.img"
  e2fsck -fy "$work/check.img" >/dev/null 2>&1 || true
  got=$(debugfs -R "cat $2" "$work/check.img" 2>/dev/null | od -An -v -t x1 | tr -d ' \n')
  [ "$got" = "$3" ] || { echo "$1: e2fsck left $got in $2, expected $3" >&2; exit 1; }
  gzip -9 -n -c "$work/$1.img" > "$out/$1.img.gz"
}

# 1. A torn last transaction: transaction 1 (committed) writes a.txt's block, transaction 2
#    revokes it but has no commit block. jbd2 uses only revokes of committed transactions.
image ext4-journal-torn "^metadata_csum"
a=$(fsblock ext4-journal-torn /a.txt)
block "$work/new" 6e65770a6e65770a
debugfs -w -f - "$work/ext4-journal-torn.img" >/dev/null 2>&1 <<EOF
jo
jw -b $a $work/new
jw -r $a -c
jc
EOF
keep ext4-journal-torn /a.txt 6e65770a6e65770a

# 2. Journal checksum v3 on a file system without 64bit: every tag is 16 bytes. One
#    transaction writes the blocks of a.txt, b.txt and c.txt (three tags).
image ext4-journal-csum3-32bit "^64bit,metadata_csum"
a=$(fsblock ext4-journal-csum3-32bit /a.txt)
b=$(fsblock ext4-journal-csum3-32bit /b.txt)
c=$(fsblock ext4-journal-csum3-32bit /c.txt)
block "$work/three" 4e45572141414141 4242420a 4343430a
debugfs -w -f - "$work/ext4-journal-csum3-32bit.img" >/dev/null 2>&1 <<EOF
jo -c
jw -b $a,$b,$c $work/three
jc
EOF
keep ext4-journal-csum3-32bit /a.txt 4e45572141414141
keep ext4-journal-csum3-32bit /c.txt 4343430a

# 3. An escaped block: transaction 1 writes a.txt's block, transaction 2 writes it again with
#    contents that begin with the journal magic (c03b3998), which jbd2 escapes in the log.
image ext4-journal-escaped "^metadata_csum"
a=$(fsblock ext4-journal-escaped /a.txt)
block "$work/mid" 6d69640a6d69640a
block "$work/esc" c03b39984553430a
debugfs -w -f - "$work/ext4-journal-escaped.img" >/dev/null 2>&1 <<EOF
jo
jw -b $a $work/mid
jw -b $a $work/esc
jc
EOF
keep ext4-journal-escaped /a.txt c03b39984553430a

echo "journal fixtures written to $out"
