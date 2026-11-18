#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# The source code of the MySQL and MariaDB client programs in the application images
# (GPL-2.0, docs/DATABASES.md 16 "D4"), as one tar file and a list of name, version and URL; both
# become attachments of the release, like the sources of the recovery lab and the recovery ISO.
#
#   - MySQL: the source archive of exactly the release in /opt/mysql (/opt/mysql/VERSION, written
#     by the mysql-tools stage), from Oracle with its signature, checked against the key the
#     Dockerfile checks the binaries with (scripts/docker/mysql-A8D3785C.asc).
#   - MariaDB: the source of exactly the installed version of the packages built from the source
#     package mariadb (dpkg's status of the image). A Debian version comes as Debian's source
#     package (apt-get source, checked by apt against the archive's signature); a version from
#     MariaDB's archive (deb.mariadb.org, "+maria~" in the version), which publishes no source
#     packages, as MariaDB's source archive of that release with its signature, checked against
#     scripts/docker/mariadb-C74CD1D8.asc.
#
# Every --image is read without running it (docker create and docker cp), so the images of both
# architectures can be read on one host; what they name together is collected once.
#
#   scripts/docker/db-client-sources.sh --image <image> [--image <image> ...] --version <v> --out <dir>
#   scripts/docker/db-client-sources.sh --mariadb-versions <dpkg status file>   (what it reads there)
set -eu

HERE=$(cd "$(dirname "$0")" && pwd -P)
MYSQL_KEY="$HERE/mysql-A8D3785C.asc"
MYSQL_FINGERPRINT=BCA43417C3B485DD128EC6D4B7B3B788A8D3785C
MARIADB_KEY="$HERE/mariadb-C74CD1D8.asc"
MARIADB_FINGERPRINT=177F4010FE56CA3336300305F1656F24C74CD1D8
# GitHub takes no release attachment of 2 GiB or more.
MAX_BYTES=2147483647

# The source package mariadb's version of every installed package built from it, one per line,
# from a dpkg status file ("Source: name (version)" when it differs from the package's own).
mariadb_versions() {
  awk '
    /^Package: / { pkg = $2; src = ""; srcver = ""; ver = ""; ok = 0 }
    /^Status: / { ok = ($0 ~ / installed$/) }
    /^Version: / { ver = $2 }
    /^Source: / { src = $2; if ($3 != "") { srcver = $3; gsub(/[()]/, "", srcver) } }
    /^$/ { if (ok && (src == "mariadb" || (src == "" && pkg == "mariadb"))) print (srcver != "" ? srcver : ver); ok = 0 }
    END { if (ok && (src == "mariadb" || (src == "" && pkg == "mariadb"))) print (srcver != "" ? srcver : ver) }
  ' "$1"
}

images=''
version=''
out=''
while [ $# -gt 0 ]; do
  case "$1" in
    --image) images="$images $2"; shift ;;
    --version) version="$2"; shift ;;
    --out) out="$2"; shift ;;
    --mariadb-versions) mariadb_versions "$2"; exit 0 ;;
    -h | --help) awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
if [ -z "$images" ] || [ -z "$out" ]; then
  echo "--image and --out are needed" >&2
  exit 2
fi
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || { echo "--version <v> is needed" >&2; exit 2; }

mkdir -p "$out"
out=$(cd "$out" && pwd -P)
work="$out/db-client-sources"
rm -rf "$work"
mkdir -p "$work/src" "$work/images"

# What one image holds: /opt/mysql/VERSION, the Debian codename and the mariadb versions.
n=0
for image in $images; do
  n=$((n + 1))
  dir="$work/images/$n"
  mkdir -p "$dir"
  docker image inspect "$image" >/dev/null 2>&1 || docker pull --quiet "$image" >/dev/null
  platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
  container=$(docker create --platform "$platform" "$image")
  docker cp "$container:/opt/mysql/VERSION" "$dir/mysql-version"
  docker cp "$container:/var/lib/dpkg/status" "$dir/status"
  docker cp -L "$container:/etc/os-release" "$dir/os-release"
  docker rm "$container" >/dev/null
  mysql=$(cat "$dir/mysql-version")
  printf '%s' "$mysql" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "$image: /opt/mysql/VERSION is not a version" >&2; exit 1; }
  echo "$mysql" >>"$work/mysql.txt"
  codename=$(sed -n 's/^VERSION_CODENAME=//p' "$dir/os-release" | tr -d '"')
  [ -n "$codename" ] || { echo "$image names no Debian codename" >&2; exit 1; }
  mariadb_versions "$dir/status" >"$dir/mariadb.txt"
  [ -s "$dir/mariadb.txt" ] || { echo "$image has no package of the source package mariadb" >&2; exit 1; }
  sed "s/^/$codename /" "$dir/mariadb.txt" >>"$work/mariadb.txt"
done
LC_ALL=C sort -u -o "$work/mysql.txt" "$work/mysql.txt"
LC_ALL=C sort -u -o "$work/mariadb.txt" "$work/mariadb.txt"

# Checks a detached signature with the one key of a key file, the way the Dockerfile does:
# exactly one primary key, the pinned one, no subkey that can sign.
check_signature() { # <key file> <fingerprint> <signature> <file>
  gpg --show-keys --with-colons "$1" >"$work/key.colons" 2>/dev/null
  test "$(grep -c '^pub:' "$work/key.colons")" = 1
  test "$(awk -F: '$1 == "sub" && $12 ~ /[sS]/' "$work/key.colons" | wc -l)" = 0
  test "$(awk -F: '$1 == "fpr" { print $10; exit }' "$work/key.colons")" = "$2"
  gpg --dearmor <"$1" >"$work/key.gpg"
  gpgv --keyring "$work/key.gpg" --status-fd 1 "$3" "$4" >"$work/verify.status" 2>/dev/null || true
  grep -Eq '^\[GNUPG:\] (GOODSIG|EXPKEYSIG) ' "$work/verify.status" &&
    test "$(awk '$2 == "VALIDSIG" { print $NF }' "$work/verify.status")" = "$2" || {
    echo "$4: the signature does not check against $1" >&2
    exit 1
  }
  rm -f "$work/key.colons" "$work/key.gpg" "$work/verify.status"
}

# The first of the URLs that answers, printed; Oracle moves older releases to its archives.
# (POSIX sh has no local variables: the names are the function's own.)
fetch() { # <file> <url> [<url> ...]
  fetch_file=$1
  shift
  for fetch_url in "$@"; do
    if curl --fail --silent --show-error --location --retry 3 --output "$fetch_file" "$fetch_url" 2>/dev/null; then
      echo "$fetch_url"
      return 0
    fi
  done
  echo "none of $* answers" >&2
  return 1
}

: >"$work/sources.txt"
while read -r mysql; do
  series=$(printf '%s' "$mysql" | cut -d. -f1-2)
  name="mysql-$mysql.tar.gz"
  url=$(fetch "$work/src/$name" \
    "https://cdn.mysql.com/Downloads/MySQL-$series/$name" \
    "https://cdn.mysql.com/archives/mysql-$series/$name")
  fetch "$work/src/$name.asc" "$url.asc" >/dev/null
  check_signature "$MYSQL_KEY" "$MYSQL_FINGERPRINT" "$work/src/$name.asc" "$work/src/$name"
  printf 'mysql %s %s\n' "$mysql" "$url" >>"$work/sources.txt"
done <"$work/mysql.txt"

while read -r codename mariadb; do
  case "$mariadb" in
    *+maria~*)
      upstream=$(printf '%s' "$mariadb" | sed 's/^[0-9]*://; s/+maria~.*//')
      printf '%s' "$upstream" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "no MariaDB release in $mariadb" >&2; exit 1; }
      name="mariadb-$upstream.tar.gz"
      url="https://archive.mariadb.org/mariadb-$upstream/source/$name"
      fetch "$work/src/$name" "$url" >/dev/null
      fetch "$work/src/$name.asc" "$url.asc" >/dev/null
      check_signature "$MARIADB_KEY" "$MARIADB_FINGERPRINT" "$work/src/$name.asc" "$work/src/$name"
      printf 'mariadb %s %s\n' "$mariadb" "$url" >>"$work/sources.txt"
      ;;
    *)
      # Debian's source package, fetched by apt in a container of the same Debian release.
      cat >"$work/inner.sh" <<'INNER'
set -eu
cat >/etc/apt/sources.list <<SOURCES
deb-src http://deb.debian.org/debian $CODENAME main
deb-src http://deb.debian.org/debian $CODENAME-updates main
deb-src http://deb.debian.org/debian-security $CODENAME-security main
SOURCES
rm -f /etc/apt/sources.list.d/debian.sources
apt-get update >/dev/null
cd /work/src
apt-get source --download-only "mariadb=$MARIADB" >/dev/null
# The container runs as root: hand the files back to the caller, who removes them afterwards.
chown -R "$OWNER" /work/src
INNER
      printf 'CODENAME=%s\nMARIADB=%s\nOWNER=%s:%s\n' "$codename" "$mariadb" "$(id -u)" "$(id -g)" >"$work/env"
      docker run --rm --env-file "$work/env" --volume "$work:/work" "debian:$codename" sh /work/inner.sh
      printf 'mariadb %s http://snapshot.debian.org/package/mariadb/%s/\n' "$mariadb" "$(printf '%s' "$mariadb" | sed 's/:/%3A/')" >>"$work/sources.txt"
      ;;
  esac
done <"$work/mariadb.txt"

name="restow-db-clients_${version}_sources.tar"
(cd "$work/src" && LC_ALL=C find . -type f | LC_ALL=C sort |
  tar --create --file "$out/$name" --no-recursion --owner 0 --group 0 --numeric-owner --files-from -)
size=$(wc -c <"$out/$name" | tr -d ' ')
if [ "$size" -gt "$MAX_BYTES" ]; then
  echo "$name has $size bytes, more than a release attachment may have" >&2
  exit 1
fi
cp "$work/sources.txt" "$out/restow-db-clients_${version}_sources.txt"
rm -rf "$work"
echo "Wrote $name and restow-db-clients_${version}_sources.txt"
