# Network shares (NFS) as backup storage

This document is for operators. It explains the opt-in **mounter**: a small container
that adds NFS shares to a Restow installation from the web interface (Installation >
Mounts), so that a share can hold a tenant's storage target or the installation
default storage without editing compose files by hand.

Only NFS is supported. SMB was removed from the product; the mounter's request format
carries a `protocol` field so that another protocol can be added later through the
same container, but there is none today.

## What it does

The mounter turns each share into a Docker volume of the `local` driver with NFS
options and mounts it into the `api` and the `worker` containers at
`/mnt/restow/<name>`. It does that through the compose project it runs in:

1. It writes the share into the project's compose override file
   (`docker-compose.override.yml` next to `docker-compose.yml`, or the override that
   is already there): a list under the top-level key `x-restow-mounts`, a named volume
   `restow-nfs-<name>-<hash>` per share, and one `volumes:` entry per share for the
   `api` and the `worker` services. Docker Compose reads the override on every
   `docker compose` command in that directory, so the shares survive restarts,
   updates (also through the opt-in updater) and a manual `docker compose up -d`.
2. It recreates the `api` and the `worker` (`docker compose up -d --no-deps --no-build
   --pull never api worker`) and waits until the api reports healthy and the worker
   runs.

After that, add a storage target of the kind "directory" with the path
`/mnt/restow/<name>` (or a folder below it): the storage form offers the paths of the
mounted shares under its path field. The installation default storage can point there
as well (Installation > Default storage).

Everything else in the override file is left exactly as it is, comments included:
the mounter edits it as a YAML document and only touches `x-restow-mounts`, top-level
volumes whose name starts with `restow-nfs-`, and service volume entries whose source
starts with `restow-nfs-`. Do not edit those by hand; change shares in the web
interface. The volume name carries a hash of the share's settings, so changed settings
make a new volume; volumes no share uses any more are removed after a successful
change. Removing a share never touches the data on the NFS server.

### One change, step by step

| Step | What happens |
| --- | --- |
| Check the settings | Name, server, export path and NFS version are valid; the name is free; nothing in your own override is already mounted at `/mnt/restow/<name>`. |
| Test the share | A temporary volume with the share's settings (a soft mount that gives up quickly) and a short-lived container mount it, write a file, read it back and remove it. A read-only share is only listed. |
| Write the configuration | The new override is written and `docker compose config -q` must accept it. |
| Restart the api and the worker | `docker compose up -d --no-deps --no-build --pull never api worker`. |
| Wait until they are ready | The api reports healthy and the worker runs (default limit 5 minutes). |
| Clean up | Volumes no share uses any more are removed. A volume that cannot be removed is reported, not a failure. |

When a step after "Write the configuration" fails, the mounter puts the previous
override back and, if the services were already recreated, recreates them again and
waits for them. The section shows the operation as "Failed, the previous state was
restored". If that rollback fails as well, the operation says "please check the
server": see "Troubleshooting" below.

The api refuses a change while backups, restores or other jobs are running (the
restart would cut them off; try again when they have finished), and refuses to remove
a share that a storage target of any tenant, a retired target included, or the
installation default still uses.

## Enabling it

The mounter is part of the release's `docker-compose.yml` as the service `mounter` in
the compose profile `mounts`. Nothing runs until you start it, once, in the directory
that holds `docker-compose.yml`:

```sh
docker compose --profile mounts up -d mounter
```

No line in `.env` is needed. It does not need the opt-in updater, and the updater does
not need it.

- **Image.** There is no separate image: the mounter is the application image started
  with `ROLE=mounter`. While `RESTOW_MOUNTER_IMAGE` in `.env` is empty, the service
  starts the image in `RESTOW_IMAGE`; on that first start the mounter writes
  `RESTOW_MOUNTER_IMAGE` into `.env`, pinned by digest to the image it runs, so that a
  later rewrite of `RESTOW_IMAGE` (an update) does not change the image that holds the
  Docker socket. A locally built image has no registry digest and is not pinned. To
  move the mounter to the image of a newer version, empty the line (or set it) and run
  the command above again.
- **Network.** It listens on port 8091 on the compose network only (no published
  port). The api finds it at `http://mounter:8091` (`RESTOW_MOUNTER_URL`).
- **Authentication.** On its first start the mounter writes a random secret into the
  volume `restow-mounter-shared`; the api mounts that volume read-only and sends the
  secret with every request.
- **Volumes.** The Docker socket, the project directory (at `/project`, or at
  `RESTOW_PROJECT_DIR` when that is set, as for the updater), the state volume
  `restow-mounter` (its operation log) and `restow-mounter-shared`.
- **Who may use it.** Every provider admin with all tenants sees the shares. Adding,
  removing and testing a share is for the provider owner; adding and removing also
  need a recent sign-in, like an update. Every change and every test is written to the
  installation's audit log.

The mounter needs Compose to find the override on its own: the project must use one
of the default file names (`docker-compose.yml`, `compose.yaml`, ...) and `.env` must
not set `COMPOSE_FILE`. The section says so when that is not the case.

To switch it off again: `docker compose --profile mounts stop mounter`. The shares
stay mounted (they are in the override file); remove them in the web interface first
if you want them gone.

## Security

The mounter mounts the Docker socket. **Access to the Docker socket is root access to
the host**: anything that can make the container do something can start any container
with any host directory mounted. The same holds for the opt-in updater
(docs/UPDATING.md, "Security note"). What limits the risk:

- It is opt-in and off by default; it runs only after you start it.
- It is reachable only on the internal compose network and only with the shared
  secret, which only the api can read. The api forwards only owner requests with a
  recent sign-in.
- It holds none of the application's credentials: no `env_file`, no database URL, no
  master key. A test (`apps/api/src/mounter/boundary.test.ts`) keeps its code free of
  the application's database and secret modules.
- Every value a request carries is checked against strict patterns before it reaches
  Docker: the share name (`a-z`, `0-9`, `-`, at most 32 characters), the server (a
  host name, an IPv4 or an IPv6 address; no commas, `=`, spaces or `%`, so nothing can
  add a mount option) and the export path (absolute, no `..`, commas, `=`, `:` or
  spaces). Docker commands are argument vectors, never shell strings.
- The helper and test containers it starts run without a network and with
  `no-new-privileges`, from the Docker CLI image pinned by digest.

Run it only on a host where you would also run the updater, and stop it when you do
not need to change shares.

## NFS requirements

- **The host kernel needs NFS client support.** Docker's `local` volume driver mounts
  the share with the host kernel's NFS client (the `nfs` and, for NFSv4, `nfsv4`
  modules), not with tools inside a container. The `nfs-common` / `nfs-utils` packages
  are not required for the mount itself, but most distributions load the modules with
  them; on a minimal host install `nfs-common` (Debian, Ubuntu) or `nfs-utils` (RHEL
  family) if a test fails with "unknown filesystem type 'nfs'".
- **The export must allow this host.** The server must export the path to the Docker
  host's address (the containers' traffic leaves through the host).
- **Root squash.** Restow writes as root inside its containers. Most NFS servers map
  root to an unprivileged user (`root_squash`, the default on Linux, "Map root to
  admin/guest" on Synology and QNAP). Then the exported directory must be writable for
  that user (`nobody` / `nfsnobody`, uid 65534 on most systems), or use `all_squash`
  with `anonuid`/`anongid` of a user that owns the directory, or `no_root_squash` on
  a network you trust. The test step reports "mounted but not writable" when this is
  wrong.
- **NFS version.** 3, 4, 4.1 (the default) and 4.2. NFSv3 needs the server's
  `rpcbind`/portmapper and `mountd` to be reachable as well; NFSv4 needs only TCP 2049.
- **Mount options.** The services mount with `hard,noatime`: when the server goes
  away, writes wait until it is back instead of failing half-way. The test uses a soft
  mount (`soft,timeo=50,retrans=1`) so that it gives up quickly.
- **No credentials.** NFS here authenticates by host (AUTH_SYS). Kerberos (`sec=krb5`)
  is not supported.

## Troubleshooting

**The section says "The mounter is not running".** Start it with the command shown
there. If it runs (`docker compose --profile mounts ps mounter`), look at its log
(`docker compose logs mounter`): it refuses to start when it cannot find the project
directory (set `RESTOW_PROJECT_DIR` in `.env`) or its configuration is invalid.

**"The share could not be mounted".** The detail line carries Docker's message:
"access denied by server" (the export does not allow this host), "No such file or
directory" (wrong export path), "Protocol not supported" (wrong NFS version; try 3 or
4), "Connection timed out" / "No route to host" (server address or firewall), or
"unknown filesystem type 'nfs'" (the host kernel has no NFS client, see above).

**"Mounted but not writable".** See root squash above. The test writes a file
`.restow-probe-<random>` into the share's root and removes it.

**"Docker Compose did not accept the new configuration".** The override file next to
`docker-compose.yml` holds something Compose refuses together with the new share; the
detail line has Compose's message. The previous file was restored.

**"API or worker did not become ready".** The previous override was restored and the
services were recreated with it. Look at `docker compose logs api worker` around the
time of the change.

**"Failed, please check the server" (needs attention).** The rollback failed too, or
the mounter itself stopped while a change ran. Check the override file in the project
directory (`docker-compose.override.yml`): the shares listed under `x-restow-mounts`
must match the `restow-nfs-*` volumes and the service entries. Then run
`docker compose up -d` in the project directory and look at the api's log. The web
interface shows the shares as the override describes them.

**A volume could not be removed (a note after a successful change).** Another
container still uses it. Remove it later with `docker volume rm <name>`; list the
mounter's volumes with `docker volume ls --filter label=com.restow.mounter.mount`.

**Leftover test volumes or containers** (`restow-mounter-probe-*`) are removed when
the mounter starts.

## Settings

All optional, in the mounter's own environment (the compose file sets the first one
from `RESTOW_PROJECT_DIR`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `RESTOW_MOUNTER_PROJECT_DIR` | empty | Absolute host path of the project; empty: read from the `/project` mount. |
| `RESTOW_MOUNTER_HEALTH_TIMEOUT_SECONDS` | 300 | How long to wait for the api and the worker after a change. |
| `RESTOW_MOUNTER_PROBE_TIMEOUT_SECONDS` | 60 | How long the share test may take. |
| `RESTOW_MOUNTER_CLI_IMAGE` | `docker:27-cli@sha256:...` | Image of the helper and test containers; must be pinned by digest. |
| `RESTOW_MOUNTER_PORT` | 8091 | Port inside the compose network. |

In the api's environment: `RESTOW_MOUNTER_URL` (default `http://mounter:8091`) and
`RESTOW_MOUNTER_SECRET_FILE` (default `/mounter-shared/secret`).
