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

## Verifying releases

Every release image is signed with cosign (keyless, by the release workflow of
this repository) and carries an SBOM; every agent release is signed by the
maintainer with an Ed25519 key in the OpenSSH signature format. How to check
both: [deploy/release/README.md](deploy/release/README.md) for the images and
[agent/README.md](agent/README.md) ("Checking a release by hand") for the agent.
