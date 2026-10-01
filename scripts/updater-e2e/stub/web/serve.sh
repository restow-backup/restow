#!/bin/sh
echo "edge ${STUB_VERSION} listening on 8080"
exec nc -ll -p 8080 -e /opt/edge/respond.sh
