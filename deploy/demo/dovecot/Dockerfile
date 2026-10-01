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
