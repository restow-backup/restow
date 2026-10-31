#!/bin/sh
# Prints the tools.env pin lines for a restic or rest-server release, after
# checking that the release's SHA256SUMS is signed by the restic release key.
# Review the output and paste it into tools.env by hand.
#
#   scripts/pin-tools.sh restic 0.19.1
#   scripts/pin-tools.sh rest-server 0.14.0
#
# Needs curl and either gpg or Docker (alpine + gnupg is used then).
set -eu

AGENT_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=lib.sh
. "$AGENT_DIR/scripts/lib.sh"

# Fingerprint of the restic release signing key (https://restic.net/#verifying-release-integrity).
EXPECTED_FPR=CF8F18F2844575973F79D4E191A6868BD3F7A907

tool="${1:-}"
version="${2:-}"
if [ -z "$tool" ] || [ -z "$version" ]; then
  die "usage: pin-tools.sh restic|rest-server <version>"
fi
case "$tool" in
  restic)
    var=RESTIC
    base="https://github.com/restic/restic/releases/download/v$version"
    pattern="restic_${version}_%s_%s.bz2"
    # restic ships Windows builds as .zip (holding restic_<v>_windows_<arch>.exe).
    windows_pattern="restic_${version}_%s_%s.zip"
    ;;
  rest-server)
    var=REST_SERVER
    base="https://github.com/restic/rest-server/releases/download/v$version"
    pattern="rest-server_${version}_%s_%s.tar.gz"
    # rest-server has .zip and .tar.gz for Windows; .tar.gz fits tools/fetch's tar.gz path.
    windows_pattern="$pattern"
    ;;
  *) die "unknown tool $tool" ;;
esac

work="$AGENT_DIR/.cache/pin"
rm -rf "$work"
mkdir -p "$work"
curl -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS"
curl -fsSL -o "$work/SHA256SUMS.asc" "$base/SHA256SUMS.asc"
curl -fsSL -o "$work/key.asc" "https://restic.net/gpg-key-alex.asc"

verify_script='gpg --batch --import key.asc >/dev/null 2>&1; gpg --batch --status-fd 1 --verify SHA256SUMS.asc SHA256SUMS 2>/dev/null'
if command -v gpg >/dev/null 2>&1; then
  status=$(cd "$work" && GNUPGHOME="$work/gnupg" sh -c "mkdir -p \$GNUPGHOME && chmod 700 \$GNUPGHOME && $verify_script")
else
  command -v docker >/dev/null 2>&1 || die "need gpg or docker to verify the signature"
  status=$(docker run --rm -v "$work":/w -w /w alpine:3 sh -c "apk add --no-cache gnupg >/dev/null 2>&1; $verify_script")
fi
printf '%s\n' "$status" | grep -q '^\[GNUPG:\] GOODSIG' || die "the signature of SHA256SUMS is not valid"
printf '%s\n' "$status" | grep -q "^\[GNUPG:\] VALIDSIG .* $EXPECTED_FPR\$" || die "SHA256SUMS is signed, but not by the restic release key $EXPECTED_FPR"

echo "# $tool $version: SHA256SUMS signature verified against key $EXPECTED_FPR"
for target in linux_amd64 linux_arm64 darwin_amd64 darwin_arm64 windows_amd64; do
  os="${target%_*}"
  arch="${target#*_}"
  p="$pattern"
  if [ "$os" = windows ]; then p="$windows_pattern"; fi
  # shellcheck disable=SC2059
  file=$(printf "$p" "$os" "$arch")
  sum=$(awk -v f="$file" '$2 == f { print $1 }' "$work/SHA256SUMS")
  [ -n "$sum" ] || die "no checksum for $file"
  echo "${var}_SHA256_${target}=$sum"
done
