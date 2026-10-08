#!/bin/sh
# Tests build.sh itself, without a Go toolchain, Docker or network: a stand-in
# `go` (a few lines of shell, first on PATH) writes placeholder files, so the
# logic of build.sh runs for real: option handling, the per-target SHA256SUMS,
# the combined dist/SHA256SUMS, VERSION and RESTIC_VERSION.
#
# It guards against regressions such as `build.sh --no-restic` exiting silently
# after the first target (under `set -e` a `[ -f restic ] && ...` whose test is
# false ends the loop with status 1 and kills the script without any message),
# and checks that release builds are refused while release-signing.pub holds
# the placeholder. build.sh runs from a copy with a throwaway public key, so
# the checkout's own key file does not matter.
#
#   scripts/test-build.sh
set -eu

AGENT_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=lib.sh
. "$AGENT_DIR/scripts/lib.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}
ok() { printf 'ok: %s\n' "$*"; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM

# Keep the caller's environment from steering the build.
unset RESTOW_VERSION RESTOW_BUILD_WITH_RESTIC SOURCE_DATE_EPOCH
RESTOW_COMMIT=teststub
export RESTOW_COMMIT

# The stand-in toolchain. `go build -o F` and `go run ./tools/fetch -out F`
# (what fetch_tool calls) write a small file whose content depends on the target
# and the path, so a checksum line that ends up in the wrong place is noticed.
mkdir -p "$work/bin"
cat >"$work/bin/go" <<'STUB'
#!/bin/sh
case "$1" in
  version) echo "go version go0.0.0 stub/stub" ;;
  env)
    case "$2" in
      GOHOSTOS) echo stubos ;;
      GOHOSTARCH) echo stubarch ;;
      *) echo "stub go: unsupported 'go env $2'" >&2; exit 2 ;;
    esac
    ;;
  build | run)
    cmd="$1"
    out=""
    shift
    while [ $# -gt 0 ]; do
      case "$1" in
        -o | -out) out="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    [ -n "$out" ] || { echo "stub go: no output file given" >&2; exit 2; }
    printf 'stub %s %s/%s %s\n' "$cmd" "${GOOS:-}" "${GOARCH:-}" "$out" >"$out"
    ;;
  *) echo "stub go: unsupported command $1" >&2; exit 2 ;;
esac
STUB
chmod +x "$work/bin/go"
PATH="$work/bin:$PATH"
export PATH

# The copy of build.sh that runs: with a syntactically valid public key (any
# key works, nothing is signed here).
TEST_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMRVvWWyNWQd+TdyI0JkmmUUvnSIwVWcpYspaF0SOyZA test-only'
mkdir -p "$work/agent/scripts"
cp "$AGENT_DIR/build.sh" "$AGENT_DIR/tools.env" "$AGENT_DIR/THIRD_PARTY_NOTICES.txt" "$work/agent/"
cp "$AGENT_DIR/scripts/lib.sh" "$work/agent/scripts/"
printf '%s\n' "$TEST_KEY" >"$work/agent/release-signing.pub"

all_targets="linux-amd64 linux-arm64 darwin-amd64 darwin-arm64"

# build <name> [build.sh arguments]: runs build.sh into $work/<name> (log in
# $work/<name>.log) and returns its exit status.
build() {
  _name="$1"
  shift
  sh "$work/agent/build.sh" --version 0.1.0 --out "$work/$_name" "$@" >"$work/$_name.log" 2>&1
}

# expect_layout <name> <targets> <files>: every target directory holds exactly
# <files> (restow-agent, or restow-agent and restic, and the notices file
# THIRD_PARTY_NOTICES.txt, a copy of the one in agent/) and a SHA256SUMS that lists
# exactly those files with the right checksums, in this order; dist/SHA256SUMS
# lists all of them with relative paths; VERSION and RESTIC_VERSION are there.
expect_layout() {
  _name="$1"
  _targets="$2"
  _files="$3"
  _out="$work/$_name"
  : >"$work/expected.all"
  for _t in $_targets; do
    : >"$work/expected.target"
    for _f in $_files; do
      [ -f "$_out/$_t/$_f" ] || fail "$_name: $_t/$_f was not built"
      _sum=$(sha256_file "$_out/$_t/$_f")
      printf '%s  %s\n' "$_sum" "$_f" >>"$work/expected.target"
      printf '%s  %s/%s\n' "$_sum" "$_t" "$_f" >>"$work/expected.all"
    done
    for _f in restow-agent restic; do
      case " $_files " in
        *" $_f "*) ;;
        *) [ ! -e "$_out/$_t/$_f" ] || fail "$_name: $_t/$_f must not exist" ;;
      esac
    done
    cmp -s "$work/expected.target" "$_out/$_t/SHA256SUMS" ||
      fail "$_name: $_t/SHA256SUMS is wrong: $(tr '\n' '|' <"$_out/$_t/SHA256SUMS")"
    cmp -s "$work/agent/THIRD_PARTY_NOTICES.txt" "$_out/$_t/THIRD_PARTY_NOTICES.txt" ||
      fail "$_name: $_t/THIRD_PARTY_NOTICES.txt is not the agent's notices file"
  done
  cmp -s "$work/expected.all" "$_out/SHA256SUMS" ||
    fail "$_name: SHA256SUMS is wrong: $(tr '\n' '|' <"$_out/SHA256SUMS")"
  [ "$(cat "$_out/VERSION")" = 0.1.0 ] || fail "$_name: VERSION is wrong"
  [ "$(cat "$_out/RESTIC_VERSION")" = "$RESTIC_VERSION" ] || fail "$_name: RESTIC_VERSION is wrong"
  grep -q '^Done\.' "$work/$_name.log" || fail "$_name: build.sh did not reach its last line"
}

# 1. The regression: --no-restic must build every target and exit 0.
rc=0
build norestic --no-restic || rc=$?
[ "$rc" -eq 0 ] || {
  cat "$work/norestic.log"
  fail "build.sh --no-restic exited with status $rc"
}
expect_layout norestic "$all_targets" "restow-agent THIRD_PARTY_NOTICES.txt"
ok "--no-restic builds all four targets, SHA256SUMS lists restow-agent and the notices only"

# 2. The same through the environment variable that the Docker re-exec uses.
rc=0
(RESTOW_BUILD_WITH_RESTIC=0 && export RESTOW_BUILD_WITH_RESTIC && build norestic-var --targets "linux-arm64 darwin-arm64") || rc=$?
[ "$rc" -eq 0 ] || {
  cat "$work/norestic-var.log"
  fail "RESTOW_BUILD_WITH_RESTIC=0 build exited with status $rc"
}
expect_layout norestic-var "linux-arm64 darwin-arm64" "restow-agent THIRD_PARTY_NOTICES.txt"
ok "RESTOW_BUILD_WITH_RESTIC=0 behaves like --no-restic"

# 3. With restic (fetched by the stand-in) every target lists both files.
rc=0
build restic --targets "linux-arm64 darwin-arm64" || rc=$?
[ "$rc" -eq 0 ] || {
  cat "$work/restic.log"
  fail "build.sh with restic exited with status $rc"
}
expect_layout restic "linux-arm64 darwin-arm64" "restow-agent restic THIRD_PARTY_NOTICES.txt"
ok "the default build lists restow-agent, restic and the notices for every target"

# 3b. With the PVE storage plugin shim: linux-amd64 also carries restow-pve
# and the plugin files with its license, the other targets do not.
mkdir -p "$work/pve-plugin"
printf 'package PVE::Storage::Custom::RestowPlugin;\n1;\n' >"$work/pve-plugin/RestowPlugin.pm"
printf 'package PVE::Storage::Custom::RestowProvider;\n1;\n' >"$work/pve-plugin/RestowProvider.pm"
printf 'AGPL\n' >"$work/pve-plugin/LICENSE"
rc=0
(RESTOW_PVE_PLUGIN_DIR="$work/pve-plugin" && export RESTOW_PVE_PLUGIN_DIR && build pve --no-restic --targets "linux-amd64 linux-arm64") || rc=$?
[ "$rc" -eq 0 ] || {
  cat "$work/pve.log"
  fail "build.sh with the PVE plugin exited with status $rc"
}
! grep -q restow-pve "$work/pve/linux-arm64/SHA256SUMS" || fail "linux-arm64 must not list restow-pve"
[ ! -e "$work/pve/linux-arm64/restow-pve" ] || fail "restow-pve must be built for linux-amd64 only"
for _f in restow-pve RestowPlugin.pm RestowProvider.pm RestowPlugin.LICENSE.txt; do
  grep -q "  $_f\$" "$work/pve/linux-amd64/SHA256SUMS" || fail "linux-amd64/SHA256SUMS does not list $_f"
  grep -q "  linux-amd64/$_f\$" "$work/pve/SHA256SUMS" || fail "SHA256SUMS does not list linux-amd64/$_f"
done
ok "with the PVE plugin, linux-amd64 carries restow-pve and the plugin files"

# 4. Failures are loud and exit non-zero.
rc=0
build badtarget --targets "plan9-amd64" || rc=$?
[ "$rc" -ne 0 ] || fail "an unsupported target was accepted"
grep -q 'unsupported target plan9-amd64' "$work/badtarget.log" || fail "no message for an unsupported target"
rc=0
build badversion --version x.y || rc=$?
[ "$rc" -ne 0 ] || fail "an invalid version was accepted"
grep -q "version 'x.y' is not major.minor.patch" "$work/badversion.log" || fail "no message for an invalid version"
ok "unsupported targets and invalid versions fail with a message"

# 5. A checksum tool that fails must stop the build with a message, not leave a
# SHA256SUMS line without a checksum.
mkdir -p "$work/failbin"
printf '#!/bin/sh\nexit 1\n' >"$work/failbin/sha256sum"
chmod +x "$work/failbin/sha256sum"
rc=0
(PATH="$work/failbin:$PATH" && build nosum --no-restic --targets "linux-amd64") || rc=$?
[ "$rc" -ne 0 ] || fail "build succeeded although the checksum tool failed"
grep -q 'cannot compute the SHA-256' "$work/nosum.log" || fail "no message when the checksum tool fails"
ok "a failing checksum tool stops the build with a message"

# 6. Without the notices file there is no build: an agent never ships without them.
mv "$work/agent/THIRD_PARTY_NOTICES.txt" "$work/notices.txt"
rc=0
build nonotices --no-restic --targets "linux-amd64" || rc=$?
mv "$work/notices.txt" "$work/agent/THIRD_PARTY_NOTICES.txt"
[ "$rc" -ne 0 ] || fail "a build without THIRD_PARTY_NOTICES.txt succeeded"
grep -q 'THIRD_PARTY_NOTICES.txt is missing' "$work/nonotices.log" || fail "no message when the notices file is missing"
ok "a build without the notices file fails with a message"

# 7. A release build is refused while release-signing.pub holds the
# placeholder; a development build is not.
# A fixed sample of the placeholder: the checkout itself holds the real key since
# the key ceremony, so the sample can no longer be taken from it.
cat >"$work/agent/release-signing.pub" <<'SAMPLE'
# PLACEHOLDER: no release signing key has been created yet.
#
# This file must hold the public half of the Ed25519 key that signs the agent
SAMPLE
rc=0
build placeholder --no-restic --targets "linux-amd64" || rc=$?
[ "$rc" -ne 0 ] || fail "a release build with the placeholder key was accepted"
grep -q 'release-signing.pub still holds the placeholder' "$work/placeholder.log" || fail "no message for the placeholder key"
[ ! -e "$work/placeholder" ] || fail "the refused release build wrote output"
rc=0
sh "$work/agent/build.sh" --version 0.0.0-dev --out "$work/devbuild" --no-restic --targets "linux-amd64" >"$work/devbuild.log" 2>&1 || rc=$?
[ "$rc" -eq 0 ] || {
  cat "$work/devbuild.log"
  fail "a development build with the placeholder key was refused"
}
ok "release builds are refused with the placeholder key, development builds are not"

echo "build.sh tests passed"
