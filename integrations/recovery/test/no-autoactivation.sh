#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Runs inside the started recovery ISO (the CI starts it in QEMU with a second disk
# that carries an md array, a volume group and a swap partition): nothing of it may
# be active (README.md, "No auto-activation"). Prints the state and exits 1 when
# something came up by itself.
set -eu
fail=0
if grep -q '^md' /proc/mdstat 2>/dev/null; then
  echo "FAIL: an md array is active:"
  cat /proc/mdstat
  fail=1
fi
if dmsetup ls 2>/dev/null | grep -v '^No devices found' | grep -q .; then
  echo "FAIL: device mapper devices exist:"
  dmsetup ls
  fail=1
fi
if [ "$(wc -l </proc/swaps)" -gt 1 ]; then
  echo "FAIL: swap is on:"
  cat /proc/swaps
  fail=1
fi
if grep -qE ' (btrfs|ext4|xfs) ' /proc/mounts && grep -E ' (btrfs|ext4|xfs) ' /proc/mounts | grep -v ' /run/live/' | grep -q .; then
  echo "FAIL: a file system of a disk is mounted:"
  grep -E ' (btrfs|ext4|xfs) ' /proc/mounts
  fail=1
fi
[ "$fail" -eq 0 ] && echo "no-autoactivation: nothing active"
exit "$fail"
