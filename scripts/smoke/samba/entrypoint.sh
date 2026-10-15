#!/bin/sh
# Make the smoke's one SMB account, then run smbd in the foreground (logs on stdout).
set -eu
# The account smb.conf names (valid users); only its password comes from the environment.
user=smoke
password=${SMOKE_SMB_PASSWORD:?SMOKE_SMB_PASSWORD is not set}
if ! id "$user" >/dev/null 2>&1; then
  adduser -D -H -s /sbin/nologin "$user"
fi
mkdir -p /srv/samba/data /srv/samba/copy
chown "$user:$user" /srv/samba/data /srv/samba/copy
printf '%s\n%s\n' "$password" "$password" | smbpasswd -a -s "$user" >/dev/null
exec smbd --foreground --no-process-group --debug-stdout
