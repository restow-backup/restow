#!/bin/sh
# Tests the agent under a real systemd (Debian 12 in a privileged container):
#
#   1. The integration tests (agent + restic + rest-server: backup, restore,
#      hooks, append-only) pass inside a transient service with exactly the
#      hardening of restow-agent.service (taken from internal/svc/systemd.go),
#      so the hardening does not break backups or restores.
#   2. The hardening is in effect: no new privileges through setuid binaries,
#      no CAP_SYS_MODULE, no namespaces, /proc/sys read-only; a restic backup
#      of /etc and /usr/lib and its restore are complete and keep file modes.
#   3. An earlier pre-release installation below /usr/local (built from
#      RESTOW_TEST_OLD_REF as version 0.1.0, installed with that commit's
#      installer) self-updates to this checkout (built as version 0.1.1), which
#      installs its signed release to /opt/restow-agent, rewrites the unit and
#      restarts from there; the old files below /usr/local are gone.
#   4. The moved agent runs from /opt/restow-agent under the hardened unit.
#
# The version numbers 0.1.0 and 0.1.1 are test fixtures (old and newer), not
# releases. The newer one is built from a copy of this checkout with a
# throwaway release key and signed with it. Needs Docker with privileged containers and cgroup v2
# (Docker Desktop, colima, a Linux host). Containers and the image it creates
# are named restow-agent-test-systemd and removed at the end (the image stays
# for faster re-runs; remove it with `docker rmi restow-agent-test-systemd`).
#
#   RESTOW_TEST_OLD_REF=<commit> scripts/test-systemd.sh
#
# RESTOW_TEST_OLD_REF is a commit whose agent/ still installs below /usr/local
# (the layout before the move to the root-owned prefix).
set -eu

# ---- inside the systemd container ------------------------------------------------
if [ "${1:-}" = "--in-systemd" ]; then
  fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
  }
  ok() { printf 'ok: %s\n' "$*"; }
  arch=$(dpkg --print-architecture)
  new="/work/new-dist/linux-$arch"
  props=''
  while IFS= read -r line; do
    [ -n "$line" ] && props="$props -p $line"
  done </work/props

  # 1. integration tests inside the hardened service
  # shellcheck disable=SC2086
  if ! systemd-run --quiet --wait --pipe --collect --unit=restow-hardened-it $props \
    -E HOME=/root -E RESTOW_TEST_RESTIC="$new/restic" -E RESTOW_TEST_REST_SERVER=/work/rest-server \
    -E RESTOW_TEST_AGENT_BIN="$new/restow-agent" \
    /work/integration.test -test.count=1 -test.timeout=15m -test.v >/work/it.log 2>&1; then
    tail -60 /work/it.log
    fail "the integration tests failed under the service hardening"
  fi
  grep -q '^PASS$' /work/it.log || fail "the integration tests did not report PASS"
  ok "integration tests (backup, restore, hooks) pass under the hardening of restow-agent.service ($(grep -c '^--- PASS' /work/it.log) tests)"

  # 2. the hardening is in effect and a backup/restore of system paths is complete
  cp /usr/bin/id /var/tmp/id-setuid
  chown 0:0 /var/tmp/id-setuid
  chmod 4755 /var/tmp/id-setuid
  cat >/work/hardening.sh <<'CHECK'
set -eu
fail() { echo "FAIL: $*"; exit 1; }
grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status || fail "NoNewPrivs is not set"
capbnd=$(sed -n 's/^CapBnd:[[:space:]]*//p' /proc/self/status)
[ $((0x$capbnd & 0x10000)) -eq 0 ] || fail "CAP_SYS_MODULE is in the bounding set"
euid=$(runuser -u nobody -- /var/tmp/id-setuid -u)
[ "$euid" != 0 ] || fail "a setuid-root binary gained root"
if unshare -U true 2>/dev/null; then fail "a user namespace could be created"; fi
if (echo restow-test >/proc/sys/kernel/domainname) 2>/dev/null; then fail "/proc/sys is writable"; fi
cat /proc/sys/kernel/hostname >/dev/null || fail "/proc/sys is not readable"
[ "$(umask)" = 0077 ] || fail "umask is $(umask), not 0077"
export RESTIC_PASSWORD=restow-hardening-test RESTIC_REPOSITORY=/var/tmp/hardening-repo RESTIC_CACHE_DIR=/var/tmp/hardening-cache
rm -rf /var/tmp/hardening-repo /var/tmp/hardening-cache /var/tmp/hardening-restore
"$1" init >/dev/null
"$1" backup --quiet /etc /usr/lib
"$1" restore latest --target /var/tmp/hardening-restore >/dev/null
diff -r --no-dereference /etc /var/tmp/hardening-restore/etc >/dev/null || fail "the restored /etc differs"
diff -r --no-dereference /usr/lib /var/tmp/hardening-restore/usr/lib >/dev/null || fail "the restored /usr/lib differs"
[ "$(stat -c %a /var/tmp/hardening-restore/etc/passwd)" = 644 ] || fail "the restore did not keep the mode of /etc/passwd"
echo hardening-ok
CHECK
  # shellcheck disable=SC2086
  if ! systemd-run --quiet --wait --pipe --collect --unit=restow-hardening-check $props \
    /bin/sh /work/hardening.sh "$new/restic" >/work/hardening.log 2>&1; then
    cat /work/hardening.log
    fail "the hardening check failed"
  fi
  grep -q hardening-ok /work/hardening.log || {
    cat /work/hardening.log
    fail "the hardening check did not finish"
  }
  ok "hardening in effect (NoNewPrivileges, no CAP_SYS_MODULE, no namespaces, /proc/sys read-only, umask 077); backup and restore of /etc and /usr/lib complete"

  # 3. the pre-release layout, installed with its own installer, self-updates and moves
  systemd-run --quiet --unit=restow-fakeinstance /work/fakeinstance -listen 127.0.0.1:18080 \
    -dist /work/old-dist -install /work/old-install -version 0.1.0 \
    -update 0.1.1 -update-dist /work/new-dist -release-key /work/release-key.pub -info /work/info
  i=0
  while [ ! -s /work/info ]; do
    i=$((i + 1))
    [ "$i" -lt 100 ] || {
      journalctl -u restow-fakeinstance --no-pager | tail -20
      fail "the fake instance did not start"
    }
    sleep 0.2
  done
  token=$(sed -n 's/^TOKEN=//p' /work/info)
  curl -fsS http://127.0.0.1:18080/install/linux.sh -o /work/old-linux.sh
  if ! RESTOW_TOKEN="$token" RESTOW_ALLOW_INSECURE_HTTP=1 sh /work/old-linux.sh >/work/old-install.log 2>&1; then
    cat /work/old-install.log
    fail "the 0.1.0 installer failed"
  fi
  [ "$(/usr/local/bin/restow-agent version --short)" = 0.1.0 ] || fail "0.1.0 is not installed below /usr/local"
  [ -x /usr/local/lib/restow-agent/restic ] || fail "0.1.0 restic is missing"
  i=0
  while :; do
    exe=$(systemctl show -p ExecStart --value restow-agent.service 2>/dev/null || true)
    pid=$(systemctl show -p MainPID --value restow-agent.service 2>/dev/null || echo 0)
    running=''
    [ "$pid" != 0 ] && running=$(readlink "/proc/$pid/exe" 2>/dev/null || true)
    case "$exe" in
      *"path=/opt/restow-agent/bin/restow-agent "*)
        if [ "$running" = /opt/restow-agent/bin/restow-agent ] && [ ! -e /usr/local/lib/restow-agent ] &&
          [ "$(readlink /usr/local/bin/restow-agent 2>/dev/null || true)" = /opt/restow-agent/bin/restow-agent ]; then
          break
        fi
        ;;
    esac
    i=$((i + 1))
    [ "$i" -lt 150 ] || {
      journalctl -u restow-agent --no-pager | tail -60
      ls -la /usr/local/bin /usr/local/lib /opt/restow-agent/bin 2>&1 || true
      fail "the agent did not move to /opt/restow-agent within five minutes (ExecStart: $exe, running: $running)"
    }
    sleep 2
  done
  ok "0.1.0 self-updated to 0.1.1 and moved to /opt/restow-agent (unit rewritten, legacy files removed, command link set)"

  # 4. the moved agent: version, ownership, hardened unit, status
  [ "$(/opt/restow-agent/bin/restow-agent version --short)" = 0.1.1 ] || fail "the agent in /opt is not 0.1.1"
  [ "$(stat -c '%u:%a' /opt/restow-agent/bin)" = 0:755 ] || fail "/opt/restow-agent/bin must be root:755"
  [ "$(stat -c '%u:%a' /opt/restow-agent/bin/restic)" = 0:755 ] || fail "/opt/restow-agent/bin/restic must be root:755"
  grep -q '^NoNewPrivileges=yes$' /etc/systemd/system/restow-agent.service || fail "the rewritten unit is not hardened"
  [ "$(systemctl show -p NoNewPrivileges --value restow-agent.service)" = yes ] || fail "the running service is not hardened"
  for f in /usr/local/bin/.restow-agent.new /usr/local/bin/restow-agent.prev; do
    [ ! -e "$f" ] || fail "$f was left behind"
  done
  /opt/restow-agent/bin/restow-agent status >/work/status.log 2>&1 || true
  grep -q 'Binary: *\(/opt/restow-agent/bin/restow-agent\)' /work/status.log || {
    cat /work/status.log
    fail "status does not show the binary in /opt/restow-agent"
  }
  ok "the moved agent runs 0.1.1 from /opt/restow-agent under the hardened unit"
  printf '\nAll systemd checks passed.\n'
  exit 0
fi

AGENT_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=lib.sh
. "$AGENT_DIR/scripts/lib.sh"
work="$AGENT_DIR/.cache/test-systemd"

# ---- build step (in the Go container) --------------------------------------------
if [ "${1:-}" = "--build" ]; then
  arch=$(go env GOARCH)
  out="$work/out"
  export CGO_ENABLED=0
  # 0.1.0 with its own build script and installer.
  (cd "$work/old/agent" && ./build.sh --version 0.1.0 --targets "linux-$arch" --out "$out/old-dist") >"$work/build-old.log" 2>&1 || {
    cat "$work/build-old.log"
    die "building the old agent failed"
  }
  cp -R "$work/old/agent/install" "$out/old-install"
  # 0.1.1 from a copy of this checkout with a throwaway release key, signed.
  ssh-keygen -q -t ed25519 -N '' -C restow-systemd-test -f "$work/release-key"
  cp "$work/release-key.pub" "$out/release-key.pub"
  mkdir -p "$work/new"
  tar -C "$AGENT_DIR" --exclude=./.cache --exclude=./dist --exclude=./dist-test -cf - . | tar -C "$work/new" -xf -
  cp "$work/release-key.pub" "$work/new/release-signing.pub"
  (cd "$work/new" && ./build.sh --version 0.1.1 --targets "linux-$arch" --out "$out/new-dist") >"$work/build-new.log" 2>&1 || {
    cat "$work/build-new.log"
    die "building the new agent failed"
  }
  ssh-keygen -q -Y sign -f "$work/release-key" -n restow-agent-release "$out/new-dist/SHA256SUMS" >/dev/null 2>&1
  cd "$AGENT_DIR"
  go build -trimpath -o "$out/fakeinstance" ./internal/testutil/cmd/fakeinstance
  go test -c -tags integration -o "$out/integration.test" ./integration
  fetch_tool rest-server linux "$arch" "$out/rest-server"
  exit 0
fi

# ---- host ------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is required"
OLD_REF="${RESTOW_TEST_OLD_REF:-}"
[ -n "$OLD_REF" ] ||
  die "set RESTOW_TEST_OLD_REF to a commit whose agent/ still installs below /usr/local (the pre-release layout)"
repo=$(git -C "$AGENT_DIR" rev-parse --show-toplevel) || die "$AGENT_DIR is not in a git checkout"
git -C "$repo" rev-parse -q --verify "$OLD_REF^{commit}" >/dev/null ||
  die "$OLD_REF not found; set RESTOW_TEST_OLD_REF to a commit whose agent/ still installs below /usr/local"
image=restow-agent-test-systemd
container=restow-agent-test-systemd

rm -rf "$work"
mkdir -p "$work/old" "$work/out"
git -C "$repo" archive "$OLD_REF" agent | tar -C "$work/old" -xf -

# The hardening of the unit, as systemd-run properties.
grep -E '^(UMask|NoNewPrivileges|Protect[A-Za-z]*|CapabilityBoundingSet|SystemCall[A-Za-z]*|Restrict[A-Za-z]*|LockPersonality|Nice|IOScheduling[A-Za-z]*|WorkingDirectory)=' \
  "$AGENT_DIR/internal/svc/systemd.go" >"$work/out/props"
[ "$(wc -l <"$work/out/props")" -ge 15 ] || die "found only $(wc -l <"$work/out/props") hardening settings in internal/svc/systemd.go"

echo "Building 0.1.0 ($OLD_REF), 0.1.1 (signed with a throwaway key), the fake instance and the integration tests"
docker run --rm -v "$AGENT_DIR":/src -w /src \
  -v restow-agent-gomod:/go/pkg/mod -v restow-agent-gocache:/root/.cache/go-build \
  "$GO_IMAGE" sh scripts/test-systemd.sh --build

echo "Building the systemd image"
docker build -q -t "$image" - >/dev/null <<'DOCKERFILE'
FROM debian:12
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus ca-certificates curl procps \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask getty.target console-getty.service systemd-logind.service systemd-udevd.service systemd-firstboot.service
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
DOCKERFILE

docker rm -f "$container" >/dev/null 2>&1 || true
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$container" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock "$image" >/dev/null
i=0
until docker exec "$container" sh -c 'case "$(systemctl is-system-running 2>/dev/null)" in running | degraded) exit 0 ;; esac; exit 1'; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || die "systemd did not start in the container"
  sleep 1
done
docker cp "$work/out" "$container:/work" >/dev/null
docker cp "$AGENT_DIR/scripts/test-systemd.sh" "$container:/work/test-systemd.sh" >/dev/null
docker exec "$container" sh /work/test-systemd.sh --in-systemd
