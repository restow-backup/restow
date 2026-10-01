#!/bin/sh
# Restow public demo — provisions the synthetic Dovecot accounts from the
# environment at every container start (never baked into the image; the
# users file is regenerated, not committed) and starts Dovecot in the
# foreground. See deploy/demo/README.md and dovecot.conf.
set -eu

: "${RESTOW_DEMO_IMAP_PASSWORD:?RESTOW_DEMO_IMAP_PASSWORD must be set}"
: "${RESTOW_DEMO_MAILBOXES:?RESTOW_DEMO_MAILBOXES must be set (comma-separated logins)}"

users_file=/etc/dovecot/users
: > "$users_file"

# uid/gid must be given explicitly (matching the Dockerfile's `vmail`
# user/group, uid/gid 1000): a bare "user:password" line resolves fine
# against this same file as passdb (password check), but Dovecot's userdb
# passwd-file lookup — needed by every session to pick a home directory —
# reports the user as not existing at all unless uid and gid are present in
# the line; dovecot.conf's userdb `default_fields` does still supply `home`
# from %d/%n once uid/gid make the line resolve. Verified against the exact
# image built here (Alpine 3.20's dovecot package).
old_ifs=$IFS
IFS=,
for login in $RESTOW_DEMO_MAILBOXES; do
  echo "${login}:${RESTOW_DEMO_IMAP_PASSWORD}:1000:1000" >> "$users_file"
done
IFS=$old_ifs

chmod 600 "$users_file"

mkdir -p /var/mail/vhosts
chown -R vmail:vmail /var/mail/vhosts

echo "restow-demo-dovecot: provisioned $(wc -l < "$users_file") mailbox(es)" >&2
exec dovecot -F
