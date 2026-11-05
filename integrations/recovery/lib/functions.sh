# SPDX-License-Identifier: GPL-3.0-or-later
# shellcheck shell=sh
#
# The pure helpers of the recovery ISO build: parsing and comparing the package
# lock, comparing package lists, the forbidden apt options, the snapshot time,
# the names of the source bundle parts and the scan for secrets. build.sh,
# sources.sh, the hooks (through /live-build/config/restow/functions.sh, which
# build.sh puts there) and test/unit.sh source this file. Nothing in here runs
# a program that changes the machine.

# Print an error and leave.
rr_die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# A version of the agent release: 1.2.3 or 1.2.3-pre.1.
rr_valid_version() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
}

# snapshot.env must hold exactly the three values in their form.
#   rr_check_snapshot_env <SNAPSHOT_TIMESTAMP> <DEBIAN_IMAGE_DIGEST> <LIVE_BUILD_VERSION>
rr_check_snapshot_env() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]{8}T[0-9]{6}Z$' ||
    { echo "SNAPSHOT_TIMESTAMP must look like 20261020T000000Z, not '$1'" >&2; return 1; }
  printf '%s\n' "$2" | grep -Eq '^debian:trixie@sha256:[0-9a-f]{64}$' ||
    { echo "DEBIAN_IMAGE_DIGEST must be debian:trixie@sha256:<64 hex digits>, not '$2'" >&2; return 1; }
  printf '%s\n' "$3" | grep -Eq '^[0-9]+:?[0-9A-Za-z.+~-]+$' ||
    { echo "LIVE_BUILD_VERSION must be a Debian version, not '$3'" >&2; return 1; }
}

# SOURCE_DATE_EPOCH of a snapshot time (20261020T000000Z -> seconds since 1970, UTC).
rr_epoch_of_snapshot() {
  stamp="$1"
  printf '%s\n' "$stamp" | grep -Eq '^[0-9]{8}T[0-9]{6}Z$' || return 1
  day=$(printf '%s' "$stamp" | cut -c 1-8)
  clock=$(printf '%s' "$stamp" | cut -c 10-15)
  date -u -d "$(printf '%s-%s-%s %s:%s:%s' \
    "$(printf '%s' "$day" | cut -c 1-4)" "$(printf '%s' "$day" | cut -c 5-6)" "$(printf '%s' "$day" | cut -c 7-8)" \
    "$(printf '%s' "$clock" | cut -c 1-2)" "$(printf '%s' "$clock" | cut -c 3-4)" "$(printf '%s' "$clock" | cut -c 5-6)")" +%s
}

# The entries of a lock file, sorted: "<package> <version> <sha256>" without
# comments and blank lines. Fails on a malformed line.
rr_lock_entries() {
  entries=$(mktemp)
  awk '
    /^[[:space:]]*(#|$)/ { next }
    NF != 3 || $3 !~ /^[0-9a-f]{64}$/ { printf "packages.lock line %d is not \"<package> <version> <sha256>\": %s\n", NR, $0 > "/dev/stderr"; bad = 1; next }
    { print $1, $2, $3 }
    END { exit bad }
  ' "$1" >"$entries" || { rm -f "$entries"; return 1; }
  LC_ALL=C sort "$entries"
  rm -f "$entries"
}

# How many entries a lock file has (0 for the committed header-only lock).
rr_lock_count() {
  counted=$(rr_lock_entries "$1") || return 1
  if [ -z "$counted" ]; then echo 0; else printf '%s\n' "$counted" | wc -l | tr -d ' '; fi
}

# Compare the lock with what the image holds ("<package> <version> <sha256>"
# per line, sha256 "-" when the .deb was not found). Prints one line per
# difference and fails when there is one.
#   rr_lock_compare <packages.lock> <actual>
rr_lock_compare() {
  want=$(mktemp)
  have=$(mktemp)
  rr_lock_entries "$1" >"$want" || { rm -f "$want" "$have"; return 1; }
  awk '/^#/ { next } NF >= 2 { print $1, $2, (NF >= 3 ? $3 : "-") }' "$2" | LC_ALL=C sort >"$have"
  awk '
    FNR == NR { want[$1] = $2 " " $3; next }
    {
      have[$1] = $2 " " $3
      if (!($1 in want)) { print "not in packages.lock: " $1 " " $2; bad = 1; next }
      split(want[$1], w, " ")
      if (w[1] != $2) { print "version differs: " $1 " " $2 " (lock: " w[1] ")"; bad = 1 }
      else if ($3 == "-") { print "no .deb to hash: " $1 " " $2; bad = 1 }
      else if (w[2] != $3) { print "SHA-256 differs: " $1 " " $2; bad = 1 }
    }
    END {
      for (p in want) if (!(p in have)) { split(want[p], w, " "); print "missing in the image: " p " " w[1]; bad = 1 }
      exit bad
    }
  ' "$want" "$have"
  status=$?
  rm -f "$want" "$have"
  return $status
}

# The package names of a live-build package list (comments and blanks left out).
rr_list_packages() {
  sed -e 's/#.*//' -e 's/[[:space:]]\{1,\}/\n/g' "$1" | sed '/^$/d' | LC_ALL=C sort -u
}

# The firmware packages of the image must be exactly those of the list.
#   rr_list_compare <firmware.list.chroot> <installed names, one per line>
rr_list_compare() {
  want=$(mktemp)
  rr_list_packages "$1" >"$want"
  sed -e '/^#/d' -e '/^$/d' "$2" | LC_ALL=C sort -u | LC_ALL=C comm -3 "$want" - | awk '
    /^\t/ { sub(/^\t/, ""); print "in the image but not listed: " $0; bad = 1; next }
    { print "listed but not in the image: " $0; bad = 1 }
    END { exit bad }
  '
  status=$?
  rm -f "$want"
  return $status
}

# Repository settings that turn off apt's signature checks are forbidden
# anywhere in the build configuration (docs of the work, README "Supply chain").
#   rr_forbidden_apt <dir or file>...
rr_forbidden_apt() {
  found=$(grep -rnE -- 'trusted=yes|--allow-unauthenticated|AllowInsecureRepositories' "$@" 2>/dev/null || true)
  if [ -n "$found" ]; then
    printf 'forbidden apt option: %s\n' "$found"
    return 1
  fi
  return 0
}

# Check-Valid-Until=false only together with a lock that has entries.
#   rr_valid_until_allowed <packages.lock> <update-lock yes|no>
rr_valid_until_allowed() {
  [ "$2" = yes ] && return 0
  [ "$(rr_lock_count "$1")" -gt 0 ]
}

# The source bundle is one file below 2 GiB, else parts of 1900 MiB named
# <name>.part-000, -001, ... (split -b 1900M -d -a 3).
RR_SPLIT_LIMIT=2147483648
RR_PART_BYTES=1992294400

#   rr_part_names <file name> <size in bytes>
rr_part_names() {
  name="$1"
  size="$2"
  if [ "$size" -lt "$RR_SPLIT_LIMIT" ]; then
    printf '%s\n' "$name"
    return 0
  fi
  parts=$(( (size + RR_PART_BYTES - 1) / RR_PART_BYTES ))
  index=0
  while [ "$index" -lt "$parts" ]; do
    printf '%s.part-%03d\n' "$name" "$index"
    index=$((index + 1))
  done
}

# The scan for secrets and instance data in an unpacked image (README,
# "Nothing instance-specific"). Prints every finding and fails when there is one.
#   rr_no_secrets <dir>
rr_no_secrets() {
  dir="$1"
  [ -d "$dir" ] || { echo "no such directory: $dir" >&2; return 2; }
  bad=0
  # Private keys of any kind, recovery codes and rebind tokens, anywhere.
  for pattern in \
    '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----' \
    'rset_[A-Za-z0-9]{20,}' \
    'RC-[0-9A-Z]{5}(-[0-9A-Z]{5}){4}'; do
    hits=$(grep -rlaE -- "$pattern" "$dir" 2>/dev/null || true)
    if [ -n "$hits" ]; then
      printf 'secret pattern %s in:\n%s\n' "$pattern" "$hits"
      bad=1
    fi
  done
  # Addresses of an instance; the programs of the image itself name only their project.
  hits=$(grep -rlaE --exclude-dir=restow-recovery -- 'https?://[A-Za-z0-9.-]*restow[A-Za-z0-9.-]*\.[a-z]{2,}' "$dir" 2>/dev/null |
    grep -v '/usr/share/doc/' || true)
  if [ -n "$hits" ]; then
    printf 'instance address in:\n%s\n' "$hits"
    bad=1
  fi
  # SSH host keys are made at start, never shipped.
  hits=$(find "$dir" -name 'ssh_host_*_key*' -print 2>/dev/null || true)
  if [ -n "$hits" ]; then
    printf 'SSH host key shipped:\n%s\n' "$hits"
    bad=1
  fi
  return $bad
}

# Arguments of build.sh. Sets RR_AGENT_DIST, RR_VERSION, RR_OUT, RR_UPDATE_LOCK
# (yes|no) and RR_SOURCES (yes|no); prints the problem and fails otherwise.
# shellcheck disable=SC2034 # the variables are the result, read by the caller
rr_parse_build_args() {
  RR_AGENT_DIST=''
  RR_VERSION=''
  RR_OUT=''
  RR_UPDATE_LOCK=no
  RR_SOURCES=no
  while [ $# -gt 0 ]; do
    case "$1" in
      --agent-dist | --version | --out)
        [ $# -ge 2 ] || { echo "$1 needs a value" >&2; return 2; }
        case "$1" in
          --agent-dist) RR_AGENT_DIST="$2" ;;
          --version) RR_VERSION="$2" ;;
          --out) RR_OUT="$2" ;;
        esac
        shift
        ;;
      --update-lock) RR_UPDATE_LOCK=yes ;;
      --sources) RR_SOURCES=yes ;;
      -h | --help) return 3 ;;
      *) echo "unknown argument $1" >&2; return 2 ;;
    esac
    shift
  done
  [ -n "$RR_AGENT_DIST" ] || { echo "--agent-dist <dir> is needed (the linux-amd64 folder of the agent build)" >&2; return 2; }
  [ -n "$RR_VERSION" ] || { echo "--version <v> is needed" >&2; return 2; }
  rr_valid_version "$RR_VERSION" || { echo "--version $RR_VERSION is not a release version" >&2; return 2; }
  [ -n "$RR_OUT" ] || { echo "--out <dir> is needed" >&2; return 2; }
  return 0
}
