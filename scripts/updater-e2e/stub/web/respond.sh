#!/bin/sh
read -r _request_line
body="edge ${STUB_VERSION}"
printf 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' "${#body}" "$body"
