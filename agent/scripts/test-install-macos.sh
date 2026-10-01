#!/bin/sh
# Tests install/macos.sh on a Mac WITHOUT sudo and without touching launchd: the
# script runs with a relocated install root (RESTOW_INSTALL_ROOT) and a
# development agent layout (RESTOW_AGENT_DIR). The fake Restow instance runs in
# Docker; the darwin binaries are the real ones built as release 0.1.1 from a
# copy of this checkout that embeds a throwaway release key, signed with it
# (ssh-keygen -Y sign, as the maintainer does).
#
#   scripts/test-install-macos.sh
set -eu

AGENT_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=lib.sh
. "$AGENT_DIR/scripts/lib.sh"

[ "$(uname -s)" = Darwin ] || die "run this on a Mac"
command -v docker >/dev/null 2>&1 || die "docker is required (it hosts the fake Restow instance)"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}
ok() { printf 'ok: %s\n' "$*"; }
assert_file() { [ -e "$1" ] || fail "missing $1"; }
assert_absent() { if [ -e "$1" ] || [ -L "$1" ]; then fail "$1 should not exist"; fi; }
assert_grep() { grep -q -- "$1" "$2" || fail "'$1' not found in $2"; }
assert_not_grep() { ! grep -q -- "$1" "$2" || fail "'$1' must not appear in $2"; }

case "$(uname -m)" in
  arm64) arch=arm64 ;;
  *) arch=amd64 ;;
esac
port=18081
cache="$AGENT_DIR/.cache"
work="$cache/test-install-macos"
rm -rf "$work"
mkdir -p "$work"
VERSION=0.1.1

# A throwaway release key, a copy of the checkout that embeds it, a signed release.
ssh-keygen -q -t ed25519 -N '' -C restow-install-test -f "$work/release-key"
fingerprint=$(ssh-keygen -l -f "$work/release-key.pub" | awk '{ print $2 }')
mkdir -p "$work/src"
tar -C "$AGENT_DIR" --exclude=./.cache --exclude=./dist --exclude=./dist-test -cf - . | tar -C "$work/src" -xf -
cp "$work/release-key.pub" "$work/src/release-signing.pub"
"$work/src/build.sh" --version "$VERSION" --targets "darwin-$arch" --out "$work/src/dist" >"$work/build.log" 2>&1 || {
  cat "$work/build.log"
  fail "build failed"
}
mv "$work/src/dist" "$work/dist"
ssh-keygen -q -Y sign -f "$work/release-key" -n restow-agent-release "$work/dist/SHA256SUMS" >/dev/null 2>&1 || fail "signing failed"

container=restow-fakeinstance-test
docker rm -f "$container" >/dev/null 2>&1 || true
docker run -d --rm --name "$container" -p "127.0.0.1:$port:$port" \
  -v "$AGENT_DIR":/src -w /src \
  -v restow-agent-gomod:/go/pkg/mod -v restow-agent-gocache:/root/.cache/go-build \
  "$GO_IMAGE" go run ./internal/testutil/cmd/fakeinstance -listen "0.0.0.0:$port" \
  -public-url "http://127.0.0.1:$port" -dist "/src/.cache/test-install-macos/dist" -install install -version "$VERSION" \
  -release-key /src/.cache/test-install-macos/release-key.pub -info /src/.cache/test-install-macos/info >/dev/null
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
i=0
while [ ! -s "$work/info" ]; do
  i=$((i + 1))
  [ "$i" -lt 300 ] || { docker logs "$container"; fail "fake instance did not start"; }
  sleep 0.5
done
url=$(sed -n 's/^URL=//p' "$work/info")
token=$(sed -n 's/^TOKEN=//p' "$work/info")

root="$work/root"
agentdir="$work/agentdir"
mkdir -p "$root"
chmod 0755 "$root"
bin="$root/Library/Application Support/Restow/bin"
notices="$root/Library/Application Support/Restow/THIRD_PARTY_NOTICES.txt"

run_script() { # run_script <token-or-empty> [args]
  t="$1"
  shift
  curl -fsS "$url/install/macos.sh" -o "$work/macos.sh"
  env RESTOW_INSTALL_ROOT="$root" RESTOW_SKIP_SERVICE=1 RESTOW_AGENT_DIR="$agentdir" RESTOW_ALLOW_INSECURE_HTTP=1 \
    ${t:+RESTOW_TOKEN="$t"} sh "$work/macos.sh" "$@" </dev/null
}

run_script "$token" >"$work/install1.out" 2>&1 || { cat "$work/install1.out"; fail "install failed"; }
sed 's/^/    | /' "$work/install1.out"
assert_file "$bin/restow-agent"
assert_file "$bin/restic"
assert_absent "$root/usr/local/lib/restow-agent"
assert_file "$agentdir/state/state.json"
[ "$(stat -f %Lp "$agentdir/state/state.json")" = 600 ] || fail "state.json must be mode 600"
[ "$(stat -f %Lp "$bin")" = 755 ] || fail "$bin must be mode 755"
assert_file "$notices"
[ "$(stat -f %Lp "$notices")" = 644 ] || fail "$notices must be mode 644"
cmp -s "$notices" "$AGENT_DIR/THIRD_PARTY_NOTICES.txt" || fail "$notices is not the agent's notices file"
assert_grep "THIRD_PARTY_NOTICES.txt: OK" "$work/install1.out"
assert_grep "signature: OK (release key $fingerprint)" "$work/install1.out"
assert_grep "Full Disk Access > add '$bin/restow-agent'" "$work/install1.out"
assert_grep "Hooks from the Restow server: off" "$work/install1.out"
assert_not_grep "$token" "$work/install1.out"
ok "fresh install as a normal user in a relocated root, signature checked, license notices next to the binaries"

"$bin/restow-agent" version --short | grep -qx "$VERSION" || fail "installed agent reports the wrong version"
file "$bin/restow-agent" | grep -q "Mach-O" || fail "the installed agent is not a Mach-O binary"
ok "the installed binaries run"

before=$(sed -n 's/.*"endpointId": *"\([^"]*\)".*/\1/p' "$agentdir/state/state.json")
run_script "" >"$work/install2.out" 2>&1 || { cat "$work/install2.out"; fail "re-run failed"; }
assert_grep "Existing installation found (version $VERSION)" "$work/install2.out"
assert_grep "already enrolled" "$work/install2.out"
after=$(sed -n 's/.*"endpointId": *"\([^"]*\)".*/\1/p' "$agentdir/state/state.json")
[ "$before" = "$after" ] || fail "the re-run changed the enrollment"
ok "re-running repairs in place"

# Tampered download, then a SHA256SUMS re-hashed to match it.
before_hash=$(shasum -a 256 "$bin/restic" | cut -d ' ' -f 1)
cp "$work/dist/darwin-$arch/restic" "$work/restic.orig"
cp "$work/dist/SHA256SUMS" "$work/SHA256SUMS.orig"
printf 'x' >>"$work/dist/darwin-$arch/restic"
if run_script "" >"$work/install3.out" 2>&1; then fail "a tampered restic was accepted"; fi
assert_grep "checksum mismatch for restic" "$work/install3.out"
sum=$(shasum -a 256 "$work/dist/darwin-$arch/restic" | cut -d ' ' -f 1)
sed "s|^[0-9a-f]*  darwin-$arch/restic\$|$sum  darwin-$arch/restic|" "$work/SHA256SUMS.orig" >"$work/dist/SHA256SUMS"
if run_script "" >"$work/rehash.out" 2>&1; then fail "a re-hashed SHA256SUMS was accepted"; fi
assert_grep "the release signature does not match" "$work/rehash.out"
[ "$before_hash" = "$(shasum -a 256 "$bin/restic" | cut -d ' ' -f 1)" ] || fail "installed restic changed"
cp "$work/restic.orig" "$work/dist/darwin-$arch/restic"
cp "$work/SHA256SUMS.orig" "$work/dist/SHA256SUMS"
ok "a checksum mismatch or a re-hashed SHA256SUMS aborts without touching the installation"

# An earlier pre-release installation below /usr/local is moved without running it.
rm -rf "$root/Library"
mkdir -p "$root/usr/local/bin" "$root/usr/local/lib/restow-agent"
printf '#!/bin/sh\ntouch %s/legacy-ran\n' "$work" >"$root/usr/local/bin/restow-agent"
cp "$work/restic.orig" "$root/usr/local/lib/restow-agent/restic"
chmod 0755 "$root/usr/local/bin/restow-agent" "$root/usr/local/lib/restow-agent/restic"
run_script "" >"$work/legacy.out" 2>&1 || {
  cat "$work/legacy.out"
  fail "moving the earlier pre-release installation failed"
}
assert_grep "Found an earlier pre-release installation below /usr/local" "$work/legacy.out"
assert_absent "$work/legacy-ran"
assert_absent "$root/usr/local/lib/restow-agent"
[ "$(readlink "$root/usr/local/bin/restow-agent")" = "$bin/restow-agent" ] || fail "the command link is missing after the move"
assert_file "$bin/restow-agent"
ok "an earlier pre-release installation is moved without running the old binary"

run_script "" --uninstall >"$work/uninstall.out" 2>&1 || {
  cat "$work/uninstall.out"
  fail "uninstall failed"
}
assert_absent "$bin/restow-agent"
assert_absent "$notices"
assert_absent "$root/Library/Application Support/Restow"
assert_absent "$root/usr/local/bin/restow-agent"
assert_absent "$root/usr/local/lib/restow-agent"
assert_absent "$agentdir/state"
ok "--uninstall removes everything"

if run_script "" >"$work/notoken.out" 2>&1; then fail "install without token succeeded"; fi
assert_grep "no enrollment token was given" "$work/notoken.out"
ok "no token on a fresh Mac: refused"

printf '\nAll macOS install script checks passed.\n'
