# Release smoke, check 12 (file shares, docs/FILESHARES.md 16.4): a minimal Samba server with
# NT ACLs stored as extended attributes (vfs_acl_xattr), the way a NAS keeps them. Two shares,
# `data` (backed up) and `copy` (the target of a copy job); one account, `smoke`, whose password is set at
# container start from SMOKE_SMB_PASSWORD, never baked into the image. SMB 3 only (no SMB1),
# on the project's own Docker network: the Docker daemon mounts it from the host by the
# container's address, nothing publishes port 445.
FROM alpine:3.22

RUN apk add --no-cache samba samba-client samba-common-tools attr \
    && mkdir -p /srv/samba/data /srv/samba/copy

COPY smb.conf /etc/samba/smb.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 445

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
