#!/bin/sh
# One HTTP request on stdin/stdout (busybox nc -e).
read -r request_line || exit 0
request_line=$(printf '%s' "$request_line" | tr -d '\r')
path=$(printf '%s' "$request_line" | cut -d' ' -f2)
auth=""
while IFS= read -r header; do
  header=$(printf '%s' "$header" | tr -d '\r')
  [ -z "$header" ] && break
  case "$header" in
    [Aa]uthorization:*) auth=${header#*: } ;;
  esac
done

respond() {
  printf 'HTTP/1.1 %s\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' "$1" "${#2}" "$2"
}

case "$path" in
  /healthz)
    respond "200 OK" '{"status":"ok"}'
    ;;
  /readyz)
    if [ "${STUB_MODE}" = "never" ]; then
      respond "503 Service Unavailable" '{"status":"not_ready"}'
      exit 0
    fi
    secret=$(cat /updater-shared/secret 2>/dev/null || true)
    if [ -n "$secret" ] && [ "$auth" = "Bearer $secret" ]; then
      respond "200 OK" "{\"status\":\"ready\",\"version\":\"${RESTOW_VERSION}\"}"
    else
      respond "200 OK" '{"status":"ready"}'
    fi
    ;;
  *)
    respond "404 Not Found" '{"error":"not_found"}'
    ;;
esac
