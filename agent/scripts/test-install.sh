#!/bin/sh
# End-to-end test of install/linux.sh in a throwaway Linux container: the script
# is served by a fake Restow instance (with the placeholders filled in), checks
# the release signature, installs the real agent and restic built from this
# checkout to /opt/restow-agent with their license notices, enrolls, is run
# again (idempotence), rejects tampered and unsigned releases, refuses an
# install folder others can write to, moves an earlier pre-release installation
# (below /usr/local) without running it, and uninstalls.
#
# The release is built as 0.1.1 from a copy of this checkout whose
# release-signing.pub holds a throwaway key made for this run, and signed with
# it the way the maintainer signs (ssh-keygen -Y sign). systemd is replaced by
# a recording fake `systemctl` (a container has no systemd; see
# test-systemd.sh for the real thing).
#
#   scripts/test-install.sh
set -eu

AGENT_DIR=$(cd "$(dirname "$0")/.." && pwd)

if [ "${1:-}" != "--inner" ]; then
  # shellcheck source=lib.sh
  . "$AGENT_DIR/scripts/lib.sh"
  if command -v go >/dev/null 2>&1 && [ "$(uname -s)" = Linux ] && [ "$(id -u)" = 0 ]; then
    exec sh "$0" --inner
  fi
  command -v docker >/dev/null 2>&1 || die "docker is required"
  exec docker run --rm -v "$AGENT_DIR":/src -w /src \
    -v restow-agent-gomod:/go/pkg/mod -v restow-agent-gocache:/root/.cache/go-build \
    "$GO_IMAGE" sh scripts/test-install.sh --inner
fi

# ---- inside the container -------------------------------------------------------
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}
ok() { printf 'ok: %s\n' "$*"; }
assert_file() { [ -e "$1" ] || fail "missing $1"; }
assert_absent() { [ ! -e "$1" ] && [ ! -L "$1" ] || fail "$1 should not exist"; }
assert_grep() { grep -q -- "$1" "$2" || fail "'$1' not found in $2"; }
assert_not_grep() { ! grep -q -- "$1" "$2" || fail "'$1' must not appear in $2"; }
assert_root_dir() { [ "$(stat -c '%u:%a' "$1")" = 0:755 ] || fail "$1 must be root:755, is $(stat -c '%u:%a' "$1")"; }

VERSION=0.1.1
PREFIX=/opt/restow-agent
AGENT=$PREFIX/bin/restow-agent
RESTIC=$PREFIX/bin/restic
NOTICES=$PREFIX/THIRD_PARTY_NOTICES.txt
LINK=/usr/local/bin/restow-agent

cd /src
arch=$(go env GOARCH)
target="linux-$arch"
work=$(mktemp -d)
dist="$work/dist"

# A throwaway release key, a copy of the checkout that embeds it, a signed release.
ssh-keygen -q -t ed25519 -N '' -C restow-install-test -f "$work/release-key"
fingerprint=$(ssh-keygen -l -f "$work/release-key.pub" | awk '{ print $2 }')
mkdir -p "$work/src"
tar -C /src --exclude=./.cache --exclude=./dist --exclude=./dist-test -cf - . | tar -C "$work/src" -xf -
cp "$work/release-key.pub" "$work/src/release-signing.pub"
(cd "$work/src" && ./build.sh --version "$VERSION" --targets "$target" --out "$dist") >"$work/build.log" 2>&1 || {
  cat "$work/build.log"
  fail "build failed"
}
sign() { # sign <dist>: writes <dist>/SHA256SUMS.sig
  rm -f "$1/SHA256SUMS.sig"
  ssh-keygen -q -Y sign -f "$work/release-key" -n restow-agent-release "$1/SHA256SUMS" >/dev/null 2>&1 || fail "signing failed"
}
sign "$dist"

# Fake systemd.
mkdir -p /run/systemd/system "$work/bin"
cat >"$work/bin/systemctl" <<'FAKE'
#!/bin/sh
echo "systemctl $*" >>/tmp/systemctl.log
case "$1" in
  show) printf 'ActiveState=active\nSubState=running\nMainPID=4242\n' ;;
esac
exit 0
FAKE
chmod +x "$work/bin/systemctl"
PATH="$work/bin:$PATH"
export PATH

# Tool sets for the signature checks: an ssh-keygen without -Y (OpenSSH < 8.1,
# e.g. RHEL 8), and additionally an OpenSSL 1.1.1 that cannot verify raw Ed25519.
mkdir -p "$work/oldtools" "$work/notools"
cat >"$work/oldtools/ssh-keygen" <<'FAKE'
#!/bin/sh
echo "ssh-keygen: illegal option -- Y" >&2
echo "usage: ssh-keygen [-q] [-b bits] [-C comment] [-f output_keyfile]" >&2
exit 1
FAKE
cp "$work/oldtools/ssh-keygen" "$work/notools/ssh-keygen"
cat >"$work/notools/openssl" <<'FAKE'
#!/bin/sh
[ "$1" = version ] && { echo "OpenSSL 1.1.1k  FIPS 25 Mar 2021"; exit 0; }
exit 1
FAKE
chmod +x "$work/oldtools/ssh-keygen" "$work/notools/ssh-keygen" "$work/notools/openssl"

go build -o "$work/fakeinstance" ./internal/testutil/cmd/fakeinstance
"$work/fakeinstance" -listen 127.0.0.1:18080 -dist "$dist" -install install -version "$VERSION" \
  -release-key "$work/release-key.pub" -info "$work/info" >"$work/fake.log" 2>&1 &
fake_pid=$!
trap 'kill $fake_pid 2>/dev/null || true' EXIT
i=0
while [ ! -s "$work/info" ]; do
  i=$((i + 1))
  [ "$i" -lt 100 ] || {
    cat "$work/fake.log"
    fail "fake instance did not start"
  }
  sleep 0.2
done
url=$(sed -n 's/^URL=//p' "$work/info")
token=$(sed -n 's/^TOKEN=//p' "$work/info")
fresh_token() { curl -fsS -X POST "$url/test/token"; }

install_cmd() { # install_cmd <token-or-empty> [script args]
  t="$1"
  shift
  curl -fsS "$url/install/linux.sh" -o "$work/linux.sh"
  if [ -n "$t" ]; then
    RESTOW_TOKEN="$t" RESTOW_ALLOW_INSECURE_HTTP=1 sh "$work/linux.sh" "$@" </dev/null
  else
    RESTOW_ALLOW_INSECURE_HTTP=1 sh "$work/linux.sh" "$@" </dev/null
  fi
}
no_staged_files() {
  for f in "$PREFIX"/bin/.*new-*; do
    [ -e "$f" ] && fail "a staged file was left behind: $f"
  done
  return 0
}

# 0. the served script has its placeholders replaced
curl -fsS "$url/install/linux.sh" -o "$work/served.sh"
assert_grep "INSTANCE_URL='$url'" "$work/served.sh"
assert_grep "AGENT_VERSION='$VERSION'" "$work/served.sh"
assert_grep "RELEASE_KEY='ssh-ed25519 " "$work/served.sh"
assert_not_grep "='__RESTOW_" "$work/served.sh"
ok "the served script carries the instance URL, the version and the release key"

# 1. a fresh install
: >/tmp/systemctl.log
install_cmd "$token" >"$work/install1.out" 2>&1 || {
  cat "$work/install1.out"
  fail "install failed"
}
assert_file "$AGENT"
assert_file "$RESTIC"
assert_root_dir "$PREFIX"
assert_root_dir "$PREFIX/bin"
[ "$(stat -c '%u:%a' "$AGENT")" = 0:755 ] || fail "$AGENT must be root:755"
assert_file "$NOTICES"
[ "$(stat -c '%u:%a' "$NOTICES")" = 0:644 ] || fail "$NOTICES must be root:644, is $(stat -c '%u:%a' "$NOTICES")"
cmp -s "$NOTICES" /src/THIRD_PARTY_NOTICES.txt || fail "$NOTICES is not the agent's notices file"
assert_grep "Restow agent: license and third-party notices" "$NOTICES"
assert_grep "github.com/hashicorp/golang-lru/v2" "$NOTICES"
assert_grep "Apache License" "$NOTICES"
assert_grep "THIRD_PARTY_NOTICES.txt: OK" "$work/install1.out"
[ "$(readlink "$LINK")" = "$AGENT" ] || fail "$LINK must link to $AGENT"
assert_absent /usr/local/lib/restow-agent
assert_file /etc/systemd/system/restow-agent.service
assert_file /etc/restow-agent/state.json
[ "$(stat -c %a /etc/restow-agent/state.json)" = 600 ] || fail "state.json must be mode 600"
assert_grep "ExecStart=$AGENT run" /etc/systemd/system/restow-agent.service
assert_grep "NoNewPrivileges=yes" /etc/systemd/system/restow-agent.service
assert_grep "UMask=0077" /etc/systemd/system/restow-agent.service
assert_grep "systemctl enable restow-agent.service" /tmp/systemctl.log
assert_grep "systemctl restart restow-agent.service" /tmp/systemctl.log
assert_grep "signature: OK (release key $fingerprint)" "$work/install1.out"
assert_grep "Enrolled as endpoint" "$work/install1.out"
assert_grep "Hooks from the Restow server: off" "$work/install1.out"
assert_grep "Done. The Restow agent $VERSION is installed and enrolled" "$work/install1.out"
no_staged_files
ok "fresh install: signed release, root-owned /opt/restow-agent, license notices, link, hardened unit, enrollment"
sed 's/^/    | /' "$work/install1.out"

# 2. the token must never be printed
assert_not_grep "$token" "$work/install1.out"
assert_not_grep "rsea_" "$work/install1.out"
ok "the token and the agent secret are not echoed"

# 3. idempotent re-run without a token repairs instead of installing twice
id_before=$(sed -n 's/.*"endpointId": *"\([^"]*\)".*/\1/p' /etc/restow-agent/state.json)
: >/tmp/systemctl.log
install_cmd "" >"$work/install2.out" 2>&1 || {
  cat "$work/install2.out"
  fail "re-run failed"
}
assert_grep "Existing installation found (version $VERSION)" "$work/install2.out"
assert_grep "already enrolled" "$work/install2.out"
id_after=$(sed -n 's/.*"endpointId": *"\([^"]*\)".*/\1/p' /etc/restow-agent/state.json)
[ "$id_before" = "$id_after" ] || fail "re-run changed the enrollment"
[ "$(grep -c 'restart restow-agent.service' /tmp/systemctl.log)" = 1 ] || fail "service restarted more than once"
no_staged_files
ok "re-running repairs in place and keeps the enrollment"

# 4. a tampered download is rejected before anything is changed
before=$(sha256sum "$RESTIC" | cut -d ' ' -f 1)
cp "$dist/$target/restic" "$work/restic.orig"
cp "$dist/SHA256SUMS" "$work/SHA256SUMS.orig"
printf 'x' >>"$dist/$target/restic"
if install_cmd "" >"$work/install3.out" 2>&1; then fail "a tampered restic was accepted"; fi
assert_grep "checksum mismatch for restic" "$work/install3.out"
[ "$before" = "$(sha256sum "$RESTIC" | cut -d ' ' -f 1)" ] || fail "the installed restic changed although verification failed"
ok "a checksum mismatch aborts without touching the installation"

# 5. ... also when SHA256SUMS is re-hashed to match: the signature no longer fits
sum=$(sha256sum "$dist/$target/restic" | cut -d ' ' -f 1)
sed "s|^[0-9a-f]*  $target/restic\$|$sum  $target/restic|" "$work/SHA256SUMS.orig" >"$dist/SHA256SUMS"
if install_cmd "" >"$work/rehash.out" 2>&1; then fail "a re-hashed SHA256SUMS was accepted"; fi
assert_grep "the release signature does not match" "$work/rehash.out"
if PATH="$work/oldtools:$PATH" install_cmd "" >"$work/rehash-openssl.out" 2>&1; then fail "a re-hashed SHA256SUMS was accepted by the OpenSSL check"; fi
assert_grep "the release signature does not match" "$work/rehash-openssl.out"
[ "$before" = "$(sha256sum "$RESTIC" | cut -d ' ' -f 1)" ] || fail "the installed restic changed although the signature check failed"
ok "a re-hashed SHA256SUMS fails the signature check (ssh-keygen and OpenSSL)"
cp "$work/restic.orig" "$dist/$target/restic"
cp "$work/SHA256SUMS.orig" "$dist/SHA256SUMS"

# 5b. the license notices are checked like the binaries
cp "$dist/$target/THIRD_PARTY_NOTICES.txt" "$work/notices.orig"
printf 'changed\n' >>"$dist/$target/THIRD_PARTY_NOTICES.txt"
if install_cmd "" >"$work/notices.out" 2>&1; then fail "a changed notices file was accepted"; fi
assert_grep "checksum mismatch for THIRD_PARTY_NOTICES.txt" "$work/notices.out"
cmp -s "$NOTICES" "$work/notices.orig" || fail "the installed notices changed although verification failed"
cp "$work/notices.orig" "$dist/$target/THIRD_PARTY_NOTICES.txt"
ok "a changed notices file aborts like a changed binary"

# 6. without ssh-keygen -Y: OpenSSL 3 checks the same signature; with neither,
# the install is refused unless the SHA-256 of SHA256SUMS is pinned by hand.
PATH="$work/oldtools:$PATH" install_cmd "" >"$work/openssl.out" 2>&1 || {
  cat "$work/openssl.out"
  fail "the OpenSSL signature check failed"
}
assert_grep "signature: OK (release key $fingerprint)" "$work/openssl.out"
if PATH="$work/notools:$PATH" install_cmd "" >"$work/notools.out" 2>&1; then fail "installed without any way to check the signature"; fi
assert_grep "neither with ssh-keygen (OpenSSH 8.1 or newer) nor with OpenSSL 3" "$work/notools.out"
pin=$(sha256sum "$dist/SHA256SUMS" | cut -d ' ' -f 1)
PATH="$work/notools:$PATH" RESTOW_SHA256SUMS_SHA256="$pin" install_cmd "" >"$work/pin.out" 2>&1 || {
  cat "$work/pin.out"
  fail "the pinned SHA256SUMS was refused"
}
assert_grep "matches the SHA-256 you verified (RESTOW_SHA256SUMS_SHA256)" "$work/pin.out"
if PATH="$work/notools:$PATH" RESTOW_SHA256SUMS_SHA256=0000000000000000000000000000000000000000000000000000000000000000 \
  install_cmd "" >"$work/badpin.out" 2>&1; then fail "a wrong pin was accepted"; fi
assert_grep "not to the value in RESTOW_SHA256SUMS_SHA256" "$work/badpin.out"
ok "OpenSSL 3 fallback, refusal without a signature tool, manual pin"

# 7. an unsigned release is refused, also with the development switch
mv "$dist/SHA256SUMS.sig" "$work/SHA256SUMS.sig"
if RESTOW_ALLOW_UNSIGNED_DEV=1 install_cmd "" >"$work/unsigned.out" 2>&1; then fail "an unsigned release was accepted"; fi
assert_grep "is not signed" "$work/unsigned.out"
mv "$work/SHA256SUMS.sig" "$dist/SHA256SUMS.sig"
ok "an unsigned release is refused (RESTOW_ALLOW_UNSIGNED_DEV only applies to development builds)"

# 8. hooks are a local decision: --hooks on an enrolled machine changes state.json
install_cmd "" --hooks=scripts >"$work/hooks.out" 2>&1 || {
  cat "$work/hooks.out"
  fail "--hooks=scripts failed"
}
grep -q '"hooks": *"scripts"' /etc/restow-agent/state.json || fail "state.json does not record hooks=scripts"
assert_grep "hooks from the Restow server: scripts" "$work/hooks.out"
ok "--hooks=scripts is stored locally"

# 9. an install folder others can write to is refused before anything happens
chmod 0777 "$PREFIX"
if install_cmd "" >"$work/worldwritable.out" 2>&1; then fail "a world-writable install folder was accepted"; fi
assert_grep "writable by group or others" "$work/worldwritable.out"
chmod 0755 "$PREFIX"
ok "a group- or world-writable install folder is refused"

# 10. an earlier pre-release installation below /usr/local is moved without running it
rm -rf "$PREFIX" "$LINK"
mkdir -p /usr/local/lib/restow-agent
printf '#!/bin/sh\ntouch %s/legacy-ran\n' "$work" >/usr/local/bin/restow-agent
cp "$work/restic.orig" /usr/local/lib/restow-agent/restic
chmod 0755 /usr/local/bin/restow-agent /usr/local/lib/restow-agent/restic
install_cmd "" >"$work/legacy.out" 2>&1 || {
  cat "$work/legacy.out"
  fail "moving the earlier pre-release installation failed"
}
assert_grep "Found an earlier pre-release installation below /usr/local" "$work/legacy.out"
assert_grep "(location of an earlier pre-release installation)" "$work/legacy.out"
assert_absent "$work/legacy-ran"
assert_absent /usr/local/lib/restow-agent
[ "$(readlink "$LINK")" = "$AGENT" ] || fail "$LINK must link to $AGENT after the move"
assert_grep "ExecStart=$AGENT run" /etc/systemd/system/restow-agent.service
ok "an earlier pre-release installation is moved to $PREFIX without running the old binary"

# 11. uninstall through the script
install_cmd "" --uninstall >"$work/uninstall.out" 2>&1 || {
  cat "$work/uninstall.out"
  fail "uninstall failed"
}
assert_absent "$AGENT"
assert_absent "$RESTIC"
assert_absent "$NOTICES"
assert_absent "$PREFIX"
assert_absent "$LINK"
assert_absent /etc/restow-agent
assert_absent /var/lib/restow-agent
assert_absent /etc/systemd/system/restow-agent.service
assert_grep "Revoke this endpoint" "$work/uninstall.out"
ok "--uninstall removes binaries, notices, link, state, data and the unit"

# 12. fresh machine without a token: refused before anything is downloaded
if install_cmd "" >"$work/notoken.out" 2>&1; then fail "install without a token succeeded"; fi
assert_grep "no enrollment token was given" "$work/notoken.out"
assert_absent "$AGENT"
ok "no token on a fresh machine: refused, nothing installed"

# 13. a spent token: the agent is installed, enrollment fails with guidance
if install_cmd "$token" >"$work/spent.out" 2>&1; then fail "a spent token was accepted"; fi
assert_grep "did not accept the enrollment token" "$work/spent.out"
assert_grep "Create a new" "$work/spent.out"
assert_not_grep "$token" "$work/spent.out"
assert_file "$AGENT"
assert_absent /etc/restow-agent/state.json
ok "a spent token gives a clear message and leaves no half enrollment"

# 14. the retry reads a new token from a file (unattended installs)
fresh_token >"$work/token"
chmod 0644 "$work/token"
curl -fsS "$url/install/linux.sh" -o "$work/linux.sh"
RESTOW_TOKEN_FILE="$work/token" RESTOW_ALLOW_INSECURE_HTTP=1 sh "$work/linux.sh" </dev/null >"$work/tokenfile.out" 2>&1 || {
  cat "$work/tokenfile.out"
  fail "install with RESTOW_TOKEN_FILE failed"
}
assert_file /etc/restow-agent/state.json
assert_grep "can be read by other users" "$work/tokenfile.out"
assert_not_grep "$(cat "$work/token")" "$work/tokenfile.out"
ok "RESTOW_TOKEN_FILE completes the enrollment (and warns about a readable file)"

# 15. plain http:// is refused without the development switch
install_cmd "" --uninstall >/dev/null 2>&1
curl -fsS "$url/install/linux.sh" -o "$work/linux.sh"
if RESTOW_TOKEN="$(fresh_token)" sh "$work/linux.sh" </dev/null >"$work/http.out" 2>&1; then fail "http:// instance accepted"; fi
assert_grep "must start with https://" "$work/http.out"
assert_absent "$AGENT"
ok "an http:// instance URL is refused"

# 16. unprepared script (placeholders still present)
if RESTOW_TOKEN=rset_x sh install/linux.sh </dev/null >"$work/raw.out" 2>&1; then fail "raw script ran"; fi
assert_grep "has not been prepared by your Restow instance" "$work/raw.out"
ok "the raw template refuses to run"

printf '\nAll install script checks passed.\n'
