#!/bin/sh
# Installs the client programs of the D4 runs on a CI runner (x86_64 Linux) for the suites that
# run them (apps/worker src/databases/mysql-runs.pg.test.ts): MySQL 8.4's mysqldump, mysql and
# mysqlbinlog into /opt/mysql, from the very archive the Dockerfile pins (stage
# mysql-tools-amd64: its URL and SHA-256 are read from there, the signature is checked against
# scripts/docker/mysql-A8D3785C.asc), and the MariaDB client from the runner's distribution.
# Runs with sudo where it is not root. A mismatch fails the script.
#
#   scripts/ci/install-mysql-tools.sh
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SUDO=""
[ "$(id -u)" = 0 ] || SUDO=sudo
FINGERPRINT=BCA43417C3B485DD128EC6D4B7B3B788A8D3785C

# The two ADD lines of the amd64 stage: the archive and its signature.
pins=$(awk '/^FROM base AS mysql-tools-amd64/ { on = 1; next } /^FROM / { on = 0 }
  on && /--checksum=sha256:/ { sub(/.*--checksum=sha256:/, ""); sum = $1; next }
  on && sum != "" && /https:/ { print sum, $1; sum = "" }' "$ROOT/Dockerfile")
if [ "$(echo "$pins" | wc -l)" != 2 ]; then
  echo "install-mysql-tools: the Dockerfile pins no MySQL archive and signature for amd64" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
echo "$pins" | while read -r sum url; do
  file="$work/$(basename "$url")"
  curl --fail --silent --show-error --location --retry 5 --retry-delay 3 --output "$file" "$url"
  echo "$sum  $file" | sha256sum -c - >/dev/null
done
archive=$(ls "$work"/*.tar.xz)
gpg --dearmor <"$ROOT/scripts/docker/mysql-A8D3785C.asc" >"$work/mysql.gpg"
gpgv --keyring "$work/mysql.gpg" --status-fd 1 "$archive.asc" "$archive" >"$work/status" 2>/dev/null
test "$(awk '$2 == "VALIDSIG" { print $NF }' "$work/status")" = "$FINGERPRINT"

mkdir "$work/mysql"
tar -xJf "$archive" -C "$work/mysql" --strip-components=1 --wildcards \
  '*/bin/mysql' '*/bin/mysqldump' '*/bin/mysqlbinlog' \
  '*/lib/private/libssl.so.3' '*/lib/private/libcrypto.so.3'
$SUDO install -d -o root -g root -m 0755 /opt/mysql/bin /opt/mysql/lib/private
$SUDO install -o root -g root -m 0755 "$work/mysql/bin/mysql" "$work/mysql/bin/mysqldump" \
  "$work/mysql/bin/mysqlbinlog" /opt/mysql/bin/
$SUDO install -o root -g root -m 0644 "$work/mysql/lib/private/libssl.so.3" \
  "$work/mysql/lib/private/libcrypto.so.3" /opt/mysql/lib/private/
/opt/mysql/bin/mysqldump --version

if ! command -v mariadb-dump >/dev/null 2>&1; then
  $SUDO apt-get update -qq
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends mariadb-client >/dev/null
fi
mariadb-dump --version
