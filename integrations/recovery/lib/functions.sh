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

# A rebuild number of the ISO (docs/BAREMETAL.md 26.13): 1 to 999, no leading zero.
rr_valid_rebuild() {
  printf '%s\n' "$1" | grep -Eq '^[1-9][0-9]{0,2}$'
}

# The version in the ISO's file names: <v> for the release's own ISO, <v>.<n> for rebuild n.
#   rr_iso_version <version> [<rebuild>]
rr_iso_version() {
  if [ -n "${2:-}" ]; then
    printf '%s.%s\n' "$1" "$2"
  else
    printf '%s\n' "$1"
  fi
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

# Every .deb in the given folders as "<package> <version> <architecture> <sha256>",
# read from the package itself (debootstrap and apt name their files differently:
# no epoch, or the epoch as %3a).
#   rr_deb_sums <dir>...
rr_deb_sums() {
  for folder in "$@"; do
    for deb in "$folder"/*.deb; do
      [ -f "$deb" ] || continue
      # shellcheck disable=SC2016 # a dpkg-deb format, not a shell expansion
      fields=$(dpkg-deb --show --showformat='${Package} ${Version} ${Architecture}' "$deb") || return 1
      printf '%s %s\n' "$fields" "$(sha256sum "$deb" | cut -d ' ' -f 1)"
    done
  done
}

# The installed packages ("<package> <version> <architecture>" per line) with the
# SHA-256 of their .deb from rr_deb_sums output: "<package> <version> <sha256>",
# "-" when no .deb of exactly that version and architecture is there.
#   rr_with_sums <installed> <sums>
rr_with_sums() {
  awk '
    FNR == NR { sum[$1 " " $2 " " $3] = $4; next }
    NF >= 3 { key = $1 " " $2 " " $3; print $1, $2, ((key in sum) ? sum[key] : "-") }
  ' "$2" "$1"
}

# A lock written by --update-lock must name the SHA-256 of every package: prints
# each entry without one and fails when there is one (or a malformed line).
#   rr_lock_complete <lock>
rr_lock_complete() {
  awk '
    /^[[:space:]]*(#|$)/ { next }
    NF != 3 { print "packages.lock line " NR " is not \"<package> <version> <sha256>\": " $0; bad = 1; next }
    $3 !~ /^[0-9a-f]{64}$/ { print "no .deb to hash: " $1 " " $2; bad = 1 }
    END { exit bad }
  ' "$1"
}

# The installed packages of dpkg-query -W -f '${db:Status-Status} ${Package}\n' output:
# dpkg-query also lists names it only knows from other packages' fields (Provides,
# Recommends, Conflicts) with the status not-installed.
#   rr_installed_names <file>
rr_installed_names() {
  awk '$1 == "installed" && NF >= 2 { print $2 }' "$1" | LC_ALL=C sort -u
}

# A keyboard layout of the boot menu compiles in the image: ckbcomp writes a keymap
# with keycodes, and loadkeys parses it as on the Unicode console of the live system.
# --bkeymap keeps loadkeys away from the console (it has none in a chroot); --parse
# writes nothing. Runs inside the image (check-image.sh: a chroot without /dev, so no
# /dev/null either), or with stand-ins (unit.sh).
#   rr_keymap_compiles <layout>
rr_keymap_compiles() {
  keymap=$(mktemp) || return 1
  if ckbcomp "$1" >"$keymap" && grep -q '^keycode' "$keymap" &&
    loadkeys --unicode --parse --bkeymap - <"$keymap" >"$keymap.out"; then
    rm -f "$keymap" "$keymap.out"
    return 0
  fi
  rm -f "$keymap" "$keymap.out"
  return 1
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

# The apt configuration of the build: for apt in the build container
# (/etc/apt/apt.conf.d) and, as config/apt/apt.conf, for apt in live-build's
# chroot in the chroot and the binary stage (lb chroot_apt copies exactly that
# file to chroot/etc/apt/apt.conf and takes it away again before the image is
# packed). The snapshot's Release files are old, so apt needs
# Check-Valid-Until=false, and only under rr_valid_until_allowed; signatures are
# checked either way.
#   rr_apt_conf <packages.lock> <update-lock yes|no>
rr_apt_conf() {
  if rr_valid_until_allowed "$1" "$2"; then
    printf 'Acquire::Check-Valid-Until "false";\n'
  fi
  printf 'Acquire::Retries "5";\n'
  printf 'APT::Install-Recommends "false";\n'
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

# A file is an ELF program or library.
rr_is_elf() {
  [ "$(head -c 4 "$1" 2>/dev/null | od -An -c | tr -d ' \n')" = '177ELF' ]
}

# A private key in PEM form: the BEGIN line, at least one line of base64 (or the
# headers of an encrypted key) and the END line, one after the other; also written
# on one line with escaped line breaks (JSON, YAML). The header text alone is no key:
# OpenSSH, GLib and others carry it as a format string. NULs count as line ends,
# carriage returns are left out. (No open intervals such as {40,} in these awk
# programs: mawk, the awk of Debian and Ubuntu, does not know them.)
#   rr_has_pem_key <file>
rr_has_pem_key() {
  tr '\000' '\n' <"$1" | tr -d '\r' | awk '
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(\\r)?\\n[A-Za-z0-9+\/=]{40}/ { found = 1; exit }
    /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----$/ { state = 1; headers = 0; long = 0; next }
    state == 1 && long == 0 && /^(Proc-Type|DEK-Info):/ { headers = 1; next }
    state == 1 && long == 0 && headers == 1 && /^$/ { next }
    state == 1 && /^[A-Za-z0-9+\/=]+$/ && length($0) >= 40 { long++; next }
    state == 1 && long > 0 && /^[A-Za-z0-9+\/=]+$/ { next }
    state == 1 && long > 0 && /^-----END [A-Z0-9 ]*PRIVATE KEY-----$/ { found = 1; exit }
    { state = 0 }
    END { exit !found }
  '
}

# The scan for secrets and instance data in an unpacked image (README,
# "Nothing instance-specific"). Prints every finding and fails when there is one.
#   - private keys: real PEM blocks (rr_has_pem_key), in every file;
#   - rebind tokens (rset_...) and recovery codes (RC-...): in every file but ELF
#     programs and libraries. Instance data reaches an image only as
#     a file (answers, configuration); the programs are built from the repository, and
#     their read-only data runs strings together (a Go binary holds "rset_" next to
#     other text and the placeholder RC-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX), which would
#     look like a token. The placeholder is no code in any file;
#   - instance addresses: in every file outside the recovery program's folder and the
#     documentation;
#   - SSH host keys: by name.
#   rr_no_secrets <dir>
rr_no_secrets() {
  dir="$1"
  [ -d "$dir" ] || { echo "no such directory: $dir" >&2; return 2; }
  bad=0
  found=$(mktemp)
  grep -rlaE -- '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----' "$dir" 2>/dev/null | while read -r file; do
    if rr_has_pem_key "$file"; then printf '%s\n' "$file"; fi
  done >"$found"
  if [ -s "$found" ]; then
    printf 'private key in:\n%s\n' "$(cat "$found")"
    bad=1
  fi
  for pattern in \
    '(^|[^A-Za-z0-9_])rset_[A-Za-z0-9]{20,}' \
    'RC-[0-9A-Z]{5}(-[0-9A-Z]{5}){4}'; do
    grep -rlaE -- "$pattern" "$dir" 2>/dev/null | while read -r file; do
      rr_is_elf "$file" && continue
      # The placeholder of the format is no code.
      grep -oaE -- "$pattern" "$file" | grep -vqxE 'RC-X{5}(-X{5}){4}' && printf '%s\n' "$file"
    done >"$found"
    if [ -s "$found" ]; then
      printf 'secret pattern %s in:\n%s\n' "$pattern" "$(cat "$found")"
      bad=1
    fi
  done
  # Addresses of an instance; the programs of the image itself name only their project.
  rm -f "$found"
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

# What package scripts and live-build leave in the chroot after the 9900 hook and that
# differs per build or names the build host: the contents of /run (the build's DNS),
# systemd-resolved's copy of the build's resolv.conf, the NVMe host identity nvme-cli
# makes at install (one per machine, never one for every machine started from the ISO)
# and apt's caches from live-build's last apt-get update. live-build also leaves
# /etc/resolv.conf as an empty file where systemd-resolved had its link to the stub
# resolver; empty, glibc and Go ask 127.0.0.1:53, where nobody answers, and
# systemd-resolved's tmpfiles rule (L!) does not replace a file that exists.
RR_RESOLV_LINK=../run/systemd/resolve/stub-resolv.conf
RR_LEFTOVER_FILES="etc/.resolv.conf.systemd-resolved.bak etc/nvme/hostnqn etc/nvme/hostid var/cache/apt/pkgcache.bin var/cache/apt/srcpkgcache.bin"

# rr_clean_build_leftovers <root>: removes them and links /etc/resolv.conf to the stub
# resolver again, before lb binary packs the image.
rr_clean_build_leftovers() {
  root="$1"
  [ -d "$root" ] || { echo "no such directory: $root" >&2; return 2; }
  for file in $RR_LEFTOVER_FILES; do rm -f "$root/$file"; done
  if [ -d "$root/run" ]; then find "$root/run" -mindepth 1 -delete; fi
  mkdir -p "$root/etc"
  rm -f "$root/etc/resolv.conf"
  ln -s "$RR_RESOLV_LINK" "$root/etc/resolv.conf"
}

# rr_build_leftovers <root>: names every one still in the image; fails if there is one.
rr_build_leftovers() {
  root="$1"
  [ -d "$root" ] || { echo "no such directory: $root" >&2; return 2; }
  found=0
  for file in $RR_LEFTOVER_FILES; do
    if [ -e "$root/$file" ] || [ -L "$root/$file" ]; then echo "/$file"; found=1; fi
  done
  if [ -d "$root/run" ] && [ -n "$(find "$root/run" -mindepth 1 -print | head -n 1)" ]; then
    find "$root/run" -mindepth 1 -print | sed "s#^$root##"
    found=1
  fi
  if [ "$(readlink "$root/etc/resolv.conf" 2>/dev/null)" != "$RR_RESOLV_LINK" ]; then
    echo "/etc/resolv.conf (not the link to $RR_RESOLV_LINK)"
    found=1
  fi
  [ "$found" -eq 0 ]
}

# Arguments of build.sh. Sets RR_AGENT_DIST, RR_VERSION, RR_OUT, RR_REBUILD, RR_UPDATE_LOCK
# (yes|no) and RR_SOURCES (yes|no); prints the problem and fails otherwise.
# shellcheck disable=SC2034 # the variables are the result, read by the caller
rr_parse_build_args() {
  RR_AGENT_DIST=''
  RR_VERSION=''
  RR_OUT=''
  RR_UPDATE_LOCK=no
  RR_SOURCES=no
  RR_REBUILD=''
  while [ $# -gt 0 ]; do
    case "$1" in
      --agent-dist | --version | --out | --rebuild)
        [ $# -ge 2 ] || { echo "$1 needs a value" >&2; return 2; }
        case "$1" in
          --agent-dist) RR_AGENT_DIST="$2" ;;
          --version) RR_VERSION="$2" ;;
          --out) RR_OUT="$2" ;;
          --rebuild) RR_REBUILD="$2" ;;
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
  if [ -n "$RR_REBUILD" ]; then
    rr_valid_rebuild "$RR_REBUILD" || { echo "--rebuild $RR_REBUILD is not a rebuild number (1 to 999)" >&2; return 2; }
    [ "$RR_UPDATE_LOCK" = no ] || { echo "--rebuild builds from a committed lock; --update-lock is not allowed with it" >&2; return 2; }
  fi
  return 0
}
