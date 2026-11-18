#!/bin/sh
# Starts a second PostgreSQL 16 that offers TLS, for the suite that proves the server probe's
# encrypted path against a real server (packages/core src/databases/probe/postgres.pg.test.ts).
# The CI's service container (postgres:16-alpine) has no certificate; this one gets a throwaway
# self-signed one and runs with ssl = on. It listens on the default port 5432 of its own
# container address (the suite recognises the engine from the host alone, so no other port).
#
#   scripts/ci/start-postgres-tls.sh
#
# Prints RESTOW_TEST_DATABASE_TLS_URL=...; in GitHub Actions the variable is also written to
# $GITHUB_ENV. Fails when the server does not come up or does not offer TLS. The password is the
# same throwaway one as the service container's; the server lives only as long as the job.
set -eu

IMAGE="${POSTGRES_TLS_IMAGE:-postgres:16-alpine}"
NAME="${POSTGRES_TLS_NAME:-restow-postgres-tls}"
PASSWORD=restow-ci
DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/postgres-tls"

mkdir -p "$DIR"
# A certificate for two days, made here: nothing secret leaves the job.
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=restow-ci-postgres" \
  -keyout "$DIR/server.key" -out "$DIR/server.crt" 2>/dev/null

# PostgreSQL refuses a key that its own user does not own or others can read: the container copies
# it into place for the postgres user before the image's entrypoint starts the server.
docker run --detach --name "$NAME" \
  --env POSTGRES_USER=restow --env POSTGRES_PASSWORD="$PASSWORD" --env POSTGRES_DB=postgres \
  --env PGPASSWORD="$PASSWORD" \
  --volume "$DIR:/certs:ro" \
  --entrypoint sh "$IMAGE" -c '
    install -o postgres -g postgres -m 600 /certs/server.key /var/lib/postgresql/server.key &&
    install -o postgres -g postgres -m 644 /certs/server.crt /var/lib/postgresql/server.crt &&
    exec docker-entrypoint.sh postgres -c ssl=on \
      -c ssl_cert_file=/var/lib/postgresql/server.crt \
      -c ssl_key_file=/var/lib/postgresql/server.key' >/dev/null

# Ready over TCP (the entrypoint's first, temporary server listens on the socket only).
tries=0
until docker exec "$NAME" pg_isready --host 127.0.0.1 --username restow --dbname postgres >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "start-postgres-tls: the server did not come up" >&2
    docker logs "$NAME" >&2 || true
    exit 1
  fi
  sleep 1
done

ssl=$(docker exec "$NAME" psql --host 127.0.0.1 --username restow --dbname postgres -tAc "SHOW ssl")
if [ "$ssl" != "on" ]; then
  echo "start-postgres-tls: the server runs without TLS (ssl = $ssl)" >&2
  exit 1
fi

ADDRESS=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$NAME")
if [ -z "$ADDRESS" ]; then
  echo "start-postgres-tls: the container has no address" >&2
  exit 1
fi
URL="postgres://restow:$PASSWORD@$ADDRESS:5432/postgres"
echo "RESTOW_TEST_DATABASE_TLS_URL=$URL"
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "RESTOW_TEST_DATABASE_TLS_URL=$URL" >>"$GITHUB_ENV"
fi
