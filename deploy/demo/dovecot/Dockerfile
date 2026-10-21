# Restow public demo — a minimal Dovecot IMAP server holding only the
# synthetic demo mailboxes (deploy/demo/README.md). Plain IMAP on the
# internal demo network only (no TLS, no internet route, never exposed);
# accounts are provisioned at container start from RESTOW_DEMO_MAILBOXES /
# RESTOW_DEMO_IMAP_PASSWORD (deploy/demo/docker-compose.yml), never baked
# into the image.
FROM alpine:3.20

RUN apk add --no-cache dovecot \
    && addgroup -g 1000 vmail \
    && adduser -D -H -u 1000 -G vmail vmail \
    && mkdir -p /var/mail/vhosts \
    && chown -R vmail:vmail /var/mail/vhosts

COPY dovecot.conf /etc/dovecot/dovecot.conf
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 143

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# The release workflow publishes this image as ghcr.io/restow-backup/restow-demo-dovecot
# with the tags of the product images; deploy/demo/reset.sh in follow mode checks the
# version label against the other demo images (deploy/demo/README.md).
ARG RESTOW_VERSION=
ARG RESTOW_REVISION=
ARG RESTOW_CREATED=
LABEL org.opencontainers.image.title="Restow demo Dovecot" \
      org.opencontainers.image.description="IMAP server with the synthetic mailboxes of the Restow public demo (deploy/demo); not part of an installation" \
      org.opencontainers.image.vendor="IT Systeme Flores UG (haftungsbeschraenkt)" \
      org.opencontainers.image.source="https://github.com/restow-backup/restow" \
      org.opencontainers.image.documentation="https://github.com/restow-backup/restow/blob/main/deploy/demo/README.md" \
      org.opencontainers.image.version="${RESTOW_VERSION}" \
      org.opencontainers.image.revision="${RESTOW_REVISION}" \
      org.opencontainers.image.created="${RESTOW_CREATED}"
