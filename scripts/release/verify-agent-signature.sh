#!/bin/sh
# Checks the maintainer's signature over an agent release's SHA256SUMS against a
# public key file (agent/release-signing.pub), with the stock OpenSSH ssh-keygen.
# The release workflow, sign-agent.sh and anyone who wants to check a release by
# hand use it.
#
#   scripts/release/verify-agent-signature.sh <SHA256SUMS> <SHA256SUMS.sig> <release-signing.pub>
set -eu

NAMESPACE=restow-agent-release

[ $# -eq 3 ] || {
  echo "usage: $0 <SHA256SUMS> <SHA256SUMS.sig> <release-signing.pub>" >&2
  exit 2
}
sums="$1"
sig="$2"
pub="$3"
for file in "$sums" "$sig" "$pub"; do
  [ -f "$file" ] || {
    echo "error: $file does not exist" >&2
    exit 1
  }
done
command -v ssh-keygen >/dev/null 2>&1 || {
  echo "error: ssh-keygen (OpenSSH 8.1 or newer) is needed" >&2
  exit 1
}

key=$(grep '^ssh-ed25519 ' "$pub" | head -n 1 | cut -d ' ' -f 1-2)
if [ -z "$key" ]; then
  echo "error: $pub holds no ssh-ed25519 key (still the placeholder?). Create the release signing key first (agent/README.md, \"Release signing\")." >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
printf '%s %s\n' "$NAMESPACE" "$key" >"$work/allowed_signers"
if ssh-keygen -Y verify -f "$work/allowed_signers" -I "$NAMESPACE" -n "$NAMESPACE" -s "$sig" <"$sums"; then
  fingerprint=$(printf '%s\n' "$key" | ssh-keygen -l -f - | cut -d ' ' -f 2)
  echo "The signature of $sums is good (release key $fingerprint)."
else
  echo "error: the signature $sig does not match $sums and the key in $pub." >&2
  exit 1
fi
