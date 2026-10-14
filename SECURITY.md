# Security policy

## Supported versions

Restow is in beta. Security fixes go into the latest release only. Please
update to the newest 0.x version before reporting.

## Reporting a vulnerability

Please report security problems privately through GitHub's private
vulnerability reporting: open https://github.com/restow-backup/restow/security and
choose **Report a vulnerability**. If you cannot use GitHub, write to
info@it-flores.de with "Security" in the subject. Please do not open a
public issue.

Include what you found, how to reproduce it, the affected version and, if
you have one, a suggested fix. Restow has a single maintainer, so please
allow a few business days for an answer. Once a fix is released, the
release notes name the problem, the affected versions and, if you like, you.

## Scope

In scope: the code in this repository, the official container images
(`ghcr.io/restow-backup/restow`, `restow-web`, `restow-community` and
`restow-web-community`) and the endpoint agent releases. Out of scope: your own deployment and its configuration, third-party
services (Microsoft 365, IMAP providers, S3 providers) and denial of service
through excessive load.

Please do not access data that is not yours, and stop testing once you have
shown a problem exists.

## Database isolation

Tenant isolation is enforced by PostgreSQL Row Level Security, on roles that
cannot bypass it (docs/ARCHITECTURE.md, "Datenbankrollen";
packages/db/src/roles.ts):

- the **application role** (`DATABASE_URL`) serves every tenant-scoped
  request inside a transaction pinned to one tenant. It reaches tenant data
  only: of the sign-in tables nothing but a user's name and e-mail address,
  no installation table (settings, license, providers, service heartbeats,
  provider team), and in the job queue it may enqueue a job and nothing else.
  A flaw in tenant-scoped code therefore cannot read sessions, password
  hashes, TOTP secrets, passkeys or verification tokens, nor another
  tenant's queued jobs;
- the **auth role** (`DATABASE_AUTH_URL`, optional; derived from the other
  two logins when unset) is the only one besides the installation role that
  reaches better-auth's tables. better-auth and Restow's sign-in, account and
  membership code run on it, also under Row Level Security;
- the **installation role** (`DATABASE_PROVIDER_URL`, BYPASSRLS) is kept for
  installation-level data, the lookups made before a tenant is known and
  the cross-tenant background work.

Every table is classified for these roles, and the tests fail on a table
that is not. The processes refuse to start on pools whose roles could
bypass Row Level Security.

## Verifying releases

Every release image is signed with cosign (keyless, by the release workflow of
this repository) and carries an SBOM; every agent release is signed by the
maintainer with an Ed25519 key in the OpenSSH signature format. How to check
both: [deploy/release/README.md](deploy/release/README.md) for the images and
[agent/README.md](agent/README.md) ("Checking a release by hand") for the agent.
