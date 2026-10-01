# A stand-in for the Restow api/worker/scheduler image, only for scripts/updater-e2e.
# It answers /healthz and /readyz like the api (the version and the ready state only for a
# caller that presents the updater's shared secret), can "migrate" by inserting a row into
# drizzle.__drizzle_migrations, can refuse to become ready and can crash on start.
FROM postgres:16-alpine
ARG STUB_VERSION
ARG STUB_MODE=ready
ARG STUB_MIGRATE=0
ENV RESTOW_VERSION=${STUB_VERSION} \
    STUB_MODE=${STUB_MODE} \
    STUB_MIGRATE=${STUB_MIGRATE}
# The postgres base image stops with SIGINT; the stub (like the real image) stops on SIGTERM.
STOPSIGNAL SIGTERM
COPY entrypoint.sh handle.sh /opt/stub/
RUN chmod 0755 /opt/stub/entrypoint.sh /opt/stub/handle.sh
ENTRYPOINT ["/opt/stub/entrypoint.sh"]
