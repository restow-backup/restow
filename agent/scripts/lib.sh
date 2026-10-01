# shellcheck shell=sh
# Shared helpers for build.sh and the scripts in this directory. Sourced, not run.
# Expects AGENT_DIR to point at the agent/ directory.

# shellcheck source=../tools.env
. "$AGENT_DIR/tools.env"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# pinned_sha256 <VAR_PREFIX> <os> <arch>: prints the pinned checksum.
pinned_sha256() {
  _var="$1_$2_$3"
  eval "_val=\${$_var:-}"
  [ -n "$_val" ] || die "no pinned checksum $_var in tools.env"
  printf '%s' "$_val"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

# fetch_tool <restic|rest-server> <os> <arch> <dest>: download, verify against
# the pinned checksum, unpack. Needs the Go toolchain (tools/fetch).
fetch_tool() {
  _tool="$1"
  _os="$2"
  _arch="$3"
  _dest="$4"
  case "$_tool" in
    restic)
      _sum=$(pinned_sha256 RESTIC_SHA256 "$_os" "$_arch")
      _url="https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_${_os}_${_arch}.bz2"
      (cd "$AGENT_DIR" && go run ./tools/fetch -url "$_url" -sha256 "$_sum" -format bz2 -out "$_dest")
      ;;
    rest-server)
      _sum=$(pinned_sha256 REST_SERVER_SHA256 "$_os" "$_arch")
      _url="https://github.com/restic/rest-server/releases/download/v${REST_SERVER_VERSION}/rest-server_${REST_SERVER_VERSION}_${_os}_${_arch}.tar.gz"
      (cd "$AGENT_DIR" && go run ./tools/fetch -url "$_url" -sha256 "$_sum" -format tar.gz -member rest-server -out "$_dest")
      ;;
    *) die "unknown tool $_tool" ;;
  esac
}
