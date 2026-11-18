#!/bin/sh
# Starts the MySQL and MariaDB servers with TLS for the suites of the D4 runs (docs/DATABASES.md
# 16 "D4", CI): MySQL 8.4 and 8.0, MariaDB 11.8 and 10.6, each in its own container with a
# throwaway self-signed certificate, listening on port 3306 of its own container address. The
# suites (apps/worker src/databases/mysql-runs.pg.test.ts, agent internal/dbrun
# mysql_run_pg_test.go) sign in as root, which may set definers.
#
#   scripts/ci/start-mysql-tls.sh [mysql84] [mysql80] [mariadb118] [mariadb106]
#
# Without arguments all four. Prints one line VARIABLE=URL per server (RESTOW_TEST_MYSQL_URL,
# RESTOW_TEST_MYSQL80_URL, RESTOW_TEST_MARIADB_URL, RESTOW_TEST_MARIADB106_URL); in GitHub Actions
# they are also written to $GITHUB_ENV. Fails when a server does not come up or a connection that
# requires TLS does not get it. The password is a throwaway one; the servers live only as long as
# the job.
set -eu

PASSWORD=restow-ci
DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mysql-tls"
mkdir -p "$DIR"
# One certificate for two days, made here: nothing secret leaves the job.
if [ ! -f "$DIR/server.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=restow-ci-mysql" \
    -keyout "$DIR/server.key" -out "$DIR/server.crt" 2>/dev/null
fi

start() {
  key=$1 image=$2 variable=$3 family=$4
  name="restow-$key-tls"
  if [ "$family" = mysql ]; then
    server=mysqld client=mysql tls="--ssl-mode=REQUIRED"
    env="--env MYSQL_ROOT_PASSWORD=$PASSWORD --env MYSQL_ROOT_HOST=%"
  else
    server=mariadbd client=mariadb tls="--ssl --skip-ssl-verify-server-cert"
    env="--env MARIADB_ROOT_PASSWORD=$PASSWORD --env MARIADB_ROOT_HOST=%"
  fi
  # The server reads its key as the mysql user: the container copies it into place first.
  # shellcheck disable=SC2086 # $env holds two options
  docker run --detach --name "$name" $env --volume "$DIR:/certs:ro" \
    --entrypoint sh "$image" -c "
      install -d -o mysql -g mysql -m 700 /etc/restow-tls &&
      install -o mysql -g mysql -m 600 /certs/server.key /etc/restow-tls/server.key &&
      install -o mysql -g mysql -m 644 /certs/server.crt /etc/restow-tls/server.crt &&
      exec docker-entrypoint.sh $server --ssl-cert=/etc/restow-tls/server.crt \
        --ssl-key=/etc/restow-tls/server.key" >/dev/null
  echo "$name $client $variable $tls"
}

wait_ready() {
  name=$1 client=$2 variable=$3
  shift 3
  tries=0
  # Over TCP with TLS required (the entrypoint's first, temporary server has no network).
  until cipher=$(docker exec --env MYSQL_PWD="$PASSWORD" "$name" "$client" "$@" \
    --host=127.0.0.1 --user=root --batch --skip-column-names \
    --execute "SHOW SESSION STATUS LIKE 'Ssl_cipher'" 2>/dev/null); do
    tries=$((tries + 1))
    if [ "$tries" -ge 120 ]; then
      echo "start-mysql-tls: $name did not come up" >&2
      docker logs "$name" >&2 || true
      exit 1
    fi
    sleep 1
  done
  case "$cipher" in
    *[A-Z]*) ;;
    *)
      echo "start-mysql-tls: $name runs without TLS ($cipher)" >&2
      exit 1
      ;;
  esac
  address=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name")
  if [ -z "$address" ]; then
    echo "start-mysql-tls: $name has no address" >&2
    exit 1
  fi
  url="mysql://root:$PASSWORD@$address:3306"
  echo "$variable=$url"
  if [ -n "${GITHUB_ENV:-}" ]; then
    echo "$variable=$url" >>"$GITHUB_ENV"
  fi
}

[ "$#" -gt 0 ] || set -- mysql84 mysql80 mariadb118 mariadb106
started=""
for server in "$@"; do
  case "$server" in
    mysql84) line=$(start mysql84 "${MYSQL84_IMAGE:-mysql:8.4}" RESTOW_TEST_MYSQL_URL mysql) ;;
    mysql80) line=$(start mysql80 "${MYSQL80_IMAGE:-mysql:8.0}" RESTOW_TEST_MYSQL80_URL mysql) ;;
    mariadb118) line=$(start mariadb118 "${MARIADB118_IMAGE:-mariadb:11.8}" RESTOW_TEST_MARIADB_URL mariadb) ;;
    mariadb106) line=$(start mariadb106 "${MARIADB106_IMAGE:-mariadb:10.6}" RESTOW_TEST_MARIADB106_URL mariadb) ;;
    *)
      echo "start-mysql-tls: unknown server $server" >&2
      exit 2
      ;;
  esac
  started="$started$line
"
done
# All containers start at once; then each is waited for.
echo "$started" | while read -r name client variable tls; do
  [ -n "$name" ] || continue
  # shellcheck disable=SC2086 # $tls holds the client's TLS options
  wait_ready "$name" "$client" "$variable" $tls
done
