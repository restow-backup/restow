#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# No secret and nothing instance-specific in the image (README.md, "Check"):
#   test/no-secrets.sh <unpacked filesystem.squashfs>
# Exits 1 and names every finding: a private key, a recovery code, a rebind token,
# the address of an instance, an SSH host key.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=../lib/functions.sh
. "$HERE/../lib/functions.sh"
[ $# -eq 1 ] || { echo "usage: $0 <dir>" >&2; exit 2; }
if rr_no_secrets "$1"; then
  echo "no-secrets: nothing found in $1"
else
  exit 1
fi
