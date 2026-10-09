# Testing Restow for Proxmox VE on a real node

The automated tests cover everything that can run without Proxmox VE
([PVE.md](PVE.md), "Tests" below). This runbook is the step on a real PVE node
(the maintainer's PVE 9.2 host). It needs about 30 minutes and leaves the test
guests untouched; the guests it restores are removed again unless `KEEP=1`.

## 0. What you need

- A Restow instance built from this branch (0.3.0 work), reachable from the PVE
  node over HTTPS. A 0.2.x instance has no PVE support. Build and run it as
  usual (`docker compose build && docker compose up -d`, or the release image of
  this branch).
- On the PVE node, as root: `curl`, and
  - a small **test VM** (Debian with `qemu-guest-agent` installed and the agent
    option enabled is best), running;
  - a small **unprivileged test container**;
  - a **thin storage** for fleecing (`local-lvm` or `local-zfs`);
  - a storage for the restored guests (the same is fine).
- The node must be allowed to reach the instance; nothing reaches the node
  from outside.

## 1. Get the node side onto the node

Either from the instance (the image ships restow-pve when it was built from
this branch):

```sh
curl -fsSL https://<instance>/install/pve.sh -o pve.sh
```

or as a tarball built on a development machine (no signing key needed for a
`-dev` version):

```sh
# on the development machine, in the repository
integrations/pve/build-node-tarball.sh --version 0.3.0-dev
scp integrations/pve/dist/restow-pve-0.3.0-dev-linux-amd64.tar.gz root@<pve>:
# on the node
tar xzf restow-pve-0.3.0-dev-linux-amd64.tar.gz
```

## 2. Create the enrollment token

In Restow: **Servers & clients > VMs & containers > Connect Proxmox VE >
Create enrollment token**. Put the token into a file on the node:

```sh
install -m 600 /dev/null /root/restow.token && nano /root/restow.token
```

## 3. Run the test

```sh
cd <the folder with integrations/pve/test/pve-host-test.sh, or copy the script over>
RESTOW_URL=https://<instance> \
RESTOW_TOKEN_FILE=/root/restow.token \
VM_ID=<test vm> CT_ID=<test ct> FLEECING=local-lvm TARGET_STORAGE=local-lvm \
sh integrations/pve/test/pve-host-test.sh
```

With the tarball instead of the instance's installer add
`RESTOW_PVE_LOCAL_DIR=$HOME/restow-pve-0.3.0-dev RESTOW_VERSION=0.3.0-dev RESTOW_ALLOW_UNSIGNED_DEV=1`
(the script takes the installer from that folder). The tarball also carries the
test script as `pve-host-test.sh`; run `sh restow-pve-0.3.0-dev/pve-host-test.sh`
instead of the repository path.

For the bit-for-bit check of a VM restore, shut the test VM down and add
`ORACLE=1` (a running VM's disk changes between backup and comparison). Run it
once running (incremental path) and once stopped with `ORACLE=1`.

The script

1. records `pveversion -v`, storages and the test guests' configuration,
2. installs restow-pve (the installer sets up user `restow@pve`, roles,
   pool `restow-restore` and the node's own API token `restow@pve!<node>`,
   and checks the token's privileges), checks that the plugin loads
   in PVE's Perl, runs `restow-pve diagnose` and `test`, checks that storage
   `restow` is active and waits one heartbeat,
3. backs up the VM twice with `vzdump --storage restow --mode snapshot
   --fleecing enabled=1,storage=$FLEECING`: the first backup must read the whole
   disk, the second (after writing 16 MiB in the guest through the guest agent)
   must be incremental (`bitmap mode reuse` in the task log),
4. backs up the container,
5. restores both as new VMIDs into `restow-restore` with restow-pve's API
   token (the same call restow-pve makes for a restore from Restow), and with
   `ORACLE=1` compares the restored VM disk with the original bit for bit,
6. checks that the token cannot delete the original VM (403) and that
   `pvesm free` of a restore point is refused,
7. collects `restow-pve status/diagnose --json`, the journals of
   `restow-pve`, `pvedaemon` and `pvestatd`, every task log and the restore
   server logs into **`/root/restow-pve-report-<time>.txt`** (secrets redacted).

It ends with `PASS n, FAIL m`. **Paste the report file back.**

## 4. Also try by hand (5 minutes)

- In Restow, put the test VM into a new backup job and press **Back up now**:
  the run appears on the guest's page; the next scheduled run follows the job.
- On the guest's page: **Restore as a new guest** (target storage, no VMID) and
  **Check now** (the restore check runs within five minutes).
- In the PVE UI: storage `restow` > Backups shows the restore points; **Show
  configuration** and **Restore** work; **Remove** is refused ("retention is
  managed in Restow").
- `qm stop <vm>; qm start <vm>`, back up again: the run reads the whole disk
  ("Full read" in the guest list), uploads almost nothing.

## 5. Things to watch and report (open questions of the design)

- Whether PVE passes `nbd-path` per device and the NBD export name equals the
  device name (`drive-scsi0`); `restow-pve` uses the device name unless the
  request names an export (PROXMOX.md 1.4, R4).
- `qemu-img convert` from `nbd+unix:///<device>?socket=...` during restore (R4).
- Container backup as uid 100000: network access and the run folder (R5).
- PVE's restore dialog: whether `subtype`/`format` of the listing are enough to
  offer the right restore (VM vs CT).
- Privilege names on 9.2 (R9): `restow-pve diagnose` lists missing ones.
- Uninstall: `sh pve.sh --uninstall` removes everything; remove the storage with
  `pvesm remove restow` on the last node.

## Tests that run without PVE

| What | Command |
| --- | --- |
| Go: NBD client/server against qemu-nbd and qemu-img, block pipeline, provider (commit idempotency, die on unknown, journal), restore image, golden formats | `cd agent && go test ./...` |
| Perl shim: `perl -c` against stub base classes, a mock vzdump driver | `prove integrations/pve/plugin/t/` |
| Server: formats, block maps (base + delta = full), manifests | `pnpm --filter @restow/core test` |
| Server against Postgres: enrollment, ingest, authz matrix, commit, restore stream | `RESTOW_TEST_DATABASE_URL=... pnpm --filter @restow/api test` |
| Worker against Postgres: jobs, retention with reference release, verify, stale runs | `RESTOW_TEST_DATABASE_URL=... pnpm --filter @restow/worker test` |
| Standalone restore of a VM restore point to a raw image | `pnpm --filter @restow/cli test` |
| End to end: real restow-pve + real API + qemu-nbd + qemu-img + restic (by hand) | see the header of `apps/api/src/features/pve/testing/helper-e2e.ts` |
| Licensing boundary of the shim | `node scripts/ci/check-separate-works.mjs` |
