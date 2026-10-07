# Restow for Proxmox VE: node side

- `plugin/` is the storage plugin shim that PVE loads (Perl). It is a **separate
  work under AGPL-3.0-or-later** (see `plugin/LICENSE`), because it derives from
  AGPL-3+ classes of pve-storage. It only receives PVE's calls and runs
  `restow-pve provider <verb>` with JSON on stdin and stdout
  (docs/PVE-PROTOCOL.md). Do not add Restow logic here, and do not copy its
  code anywhere else: `scripts/ci/check-separate-works.mjs` enforces both.
  Tests: `prove integrations/pve/plugin/t/`.
- `build-node-tarball.sh` builds `restow-pve`, the pinned restic and the shim
  into one tarball for a node that installs from a local folder.
- `test/pve-host-test.sh` is the test run on a real PVE node
  (docs/PVE-HOST-TEST.md).

`restow-pve` itself (Go, Apache-2.0) lives in `agent/cmd/restow-pve`; the
installer is `agent/install/pve.sh`. Overview: docs/PVE.md.

Proxmox is a trademark of Proxmox Server Solutions GmbH; Restow is not
affiliated with or endorsed by it.
