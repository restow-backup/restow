# A stand-in for the web edge image (Caddy), only for scripts/updater-e2e.
FROM alpine:3
ARG STUB_VERSION
LABEL org.opencontainers.image.version=${STUB_VERSION}
ENV STUB_VERSION=${STUB_VERSION}
COPY serve.sh respond.sh /opt/edge/
RUN chmod 0755 /opt/edge/serve.sh /opt/edge/respond.sh
CMD ["/opt/edge/serve.sh"]
