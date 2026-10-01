# Additional sites on the Restow edge

The repository root `Caddyfile` ends with

```caddyfile
import /etc/caddy/sites/*.caddy
```

and `docker-compose.yml` mounts this directory read-only at `/etc/caddy/sites` in
the `caddy` service. Every `*.caddy` file here becomes one more site of the same
Caddy, with its own hostname and automatic HTTPS. This lets one host serve Restow
and something next to it, such as the public demo, behind a single edge on ports
80 and 443.

## Nothing is active by default

This directory ships with no `*.caddy` file, only this README and `*.example`
templates, which the glob does not match. An import glob that matches nothing is
valid: Caddy logs `No files matching import glob pattern` as a warning and serves
exactly what it served before (checked with `caddy validate` on the `caddy:2-alpine`
image, both with this directory mounted but empty and with no directory mounted at
all, which is the case in the demo's own web container). An installation that
never touches this directory behaves as it did without it.

Active `*.caddy` files are host-specific and are ignored by git (`.gitignore`), so
enabling a site on one host never ends up in a commit.

**Validating the Caddyfile standalone** (outside `docker compose`, for example a
future CI smoke check) needs `RESTOW_APP_DOMAIN` set to *something* — it has no
`:default` fallback in the root `Caddyfile`, unlike `RESTOW_EDGE_TRUSTED_PROXIES`
a few lines above it, so an unset value collapses the site block's key to empty
and `caddy validate` fails with "server block without any key is global
configuration, and if used, it must be first". Compose always supplies the
variable (its `${RESTOW_APP_DOMAIN:?…}` form refuses to start otherwise), so this
only bites a standalone `caddy validate`, e.g.
`docker run --rm -e RESTOW_APP_DOMAIN=example.test -v "$PWD/../..":/srv -w /srv
caddy:2-alpine caddy validate --config Caddyfile --adapter caddyfile`.

## Enabling a site

1. Copy the template to a `.caddy` file in this directory, for example
   `cp demo.caddy.example demo.caddy`, and adjust hostname and upstream.
2. Check the whole configuration before applying it:

   ```sh
   docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

3. Apply it without a restart:

   ```sh
   docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

To disable the site again, delete its `.caddy` file and reload.

The hostname must resolve to this host (A/AAAA record) before the reload, so
Caddy can obtain its certificate.

## Reaching services outside this compose project

The `caddy` service has `extra_hosts: host.docker.internal:host-gateway`, so a site
file can proxy to a port that another compose project on the same host publishes on
the Docker bridge gateway (`172.17.0.1` on a standard Linux Docker host), without a
shared Docker network between the two projects. The public demo uses exactly this;
see `demo.caddy.example` and `deploy/demo/README.md`, "Option B: co-hosted".

## Templates

| File | Site |
| --- | --- |
| `demo.caddy.example` | The public demo (`deploy/demo`), proxied to the demo's web container on `host.docker.internal:8081`. |
