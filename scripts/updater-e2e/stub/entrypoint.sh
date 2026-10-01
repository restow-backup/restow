#!/bin/sh
# Stand-in entrypoint: ROLE=api serves HTTP on 3000, the other roles idle.
set -eu

if [ "${ROLE:-api}" != "api" ]; then
  echo "stub ${ROLE} ${RESTOW_VERSION} idle"
  trap 'exit 0' TERM INT
  while true; do
    sleep 3600 &
    wait $!
  done
fi

if [ "${STUB_MODE}" = "crash" ]; then
  echo "stub api ${RESTOW_VERSION}: crashing on purpose" >&2
  exit 1
fi

if [ "${STUB_MIGRATE}" = "1" ]; then
  echo "stub api ${RESTOW_VERSION}: applying its migration (idempotent, like drizzle)"
  PGPASSWORD="${POSTGRES_PASSWORD}" psql -h postgres -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
    -v ON_ERROR_STOP=1 \
    -c "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) SELECT 'stub-${RESTOW_VERSION}', 0 WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = 'stub-${RESTOW_VERSION}')"
fi

echo "stub api ${RESTOW_VERSION}: listening on 3000 (mode ${STUB_MODE})"
exec nc -ll -p 3000 -e /opt/stub/handle.sh
