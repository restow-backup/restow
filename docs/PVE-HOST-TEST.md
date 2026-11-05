# Testing Restow for Proxmox VE on a real node

The automated tests cover everything that can run without Proxmox VE
([PVE.md](PVE.md), "Tests" below). This runbook is the step on a real PVE node
(the maintainer's PVE 9.2 host). It needs about 45 minutes, and another 60 to 90 with
`INTERACTIVE=1` (the steps started in Restow, section 3, step 7). It leaves the test
guests untouched; the guests it restores (also those restored from Restow during the
run) are removed again unless `KEEP=1`.

## 0. What you need

- A Restow instance built from this branch (0.5.0), reachable from the PVE
  node over HTTPS. A 0.2.x instance has no PVE support. Build and run it as
  usual (`docker compose build && docker compose up -d`, or the release image of
  this branch).
- On the PVE node, as root: `curl`, and
  - a small **test VM** (Debian with `qemu-guest-agent` installed and the agent
    option enabled is best), running;
  - a small **unprivileged test container**;
  - a **thin storage** for fleecing (`local-lvm` or `local-zfs`);
  - a storage for the restored guests (the same is fine);
  - optional, for the shapes that broke these paths before (each one is a SKIP
    without it, never a PASS):
    - `CT_RAW_ID`: a container with raw `lxc.*` lines (for example
      `lxc.cgroup2.devices.allow: c 10:200 rwm` and
      `lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file`) and a bind
      mount point (`mp0: /srv/restow-test,mp=/data`);
    - `VM_PT_ID`: a VM with PCI or USB passthrough (`hostpci0` or `usb0`);
    - `PROTECTED_ID`: a guest with `protection: 1`;
    - for step 7i the test container itself running with a static IP (`ip=` in
      its `net0`).
  - For the restore checks of step 7c, 7d and 7f: guests that had no restore
    check in the last 30 days (Restow plans one per guest and month).
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
integrations/pve/build-node-tarball.sh --version 0.5.0-dev
scp integrations/pve/dist/restow-pve-0.5.0-dev-linux-amd64.tar.gz root@<pve>:
# on the node
tar xzf restow-pve-0.5.0-dev-linux-amd64.tar.gz
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
`RESTOW_PVE_LOCAL_DIR=$HOME/restow-pve-0.5.0-dev RESTOW_VERSION=0.5.0-dev RESTOW_ALLOW_UNSIGNED_DEV=1`
(the script takes the installer from that folder). The tarball also carries the
test script as `pve-host-test.sh`; run `sh restow-pve-0.5.0-dev/pve-host-test.sh`
instead of the repository path.

For the bit-for-bit check of a VM restore, shut the test VM down and add
`ORACLE=1` (a running VM's disk changes between backup and comparison). Run it
once running (incremental path) and once stopped with `ORACLE=1`.

With `INTERACTIVE=1` (in a terminal, with the Restow web app open beside it) the
script also walks through what only Restow starts; add the optional guests:

```sh
INTERACTIVE=1 CT_RAW_ID=<ct> VM_PT_ID=<vm> PROTECTED_ID=<guest> \
RESTOW_URL=... VM_ID=... CT_ID=... FLEECING=... TARGET_STORAGE=... \
sh integrations/pve/test/pve-host-test.sh
```

Each such step says what to press in Restow and waits for Enter (or `skip`), then
checks on the node what the step did and left behind and asks what Restow shows;
an answer other than the expected one is a FAIL. `WAIT_MINUTES` (default 30) is
how long one step may take.

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
7. backs up the VM as a PVE backup job with retention would (`--remove 1
   --prune-backups keep-last=1`): the backup must end OK, its log must say
   "restow: retention is managed in Restow; PVE's retention settings are
   ignored", and no restore point may be gone,
8. backs up the VM once more with the token, as restow-pve does on PVE 8.1
   and newer (`notification-mode=legacy-sendmail`, no `mailto`): PVE must take
   the parameter and the backup must end OK,
9. runs the shapes that broke these paths before (section 6 of the script):
   - restarts `restow-pve` five seconds into a backup of the VM: the backup
     must end OK and the service run again (a SKIP when the backup was over
     before the restart);
   - backs the container up twice in **suspend** mode: both must end OK, and
     the second must run through the stable folder (no "restic finds no
     earlier backup of this copy" in its log), so restic finds the first as
     its parent;
   - points the restore folder at a 16 MB tmpfs and restores the container
     with the token: PVE must end the task with an error that names the free
     space, the need and `restow-pve config --restore-tmp`, before restic
     starts (the restore folder is set back afterwards, also when the script
     stops);
   - backs up `CT_RAW_ID`, `VM_PT_ID` and `PROTECTED_ID`;
10. with `INTERACTIVE=1` (section 7 of the script; without it each step is a
    SKIP):
    - **7a** a **boot test** of the VM twice in a row on this node: each time
      the temporary guest `restow-boottest-<vmid>` must come and go,
      `boottest/current.json`, the markers in `/var/lib/restow-pve/tempguests`
      and every temporary guest must be gone, and Restow must rate it green
      (a VM with the guest agent enabled) or yellow (without), never skipped
      as busy the second time;
    - **7b** a **restore** of the VM from Restow: afterwards no restore server
      is left in `/run/restow-pve/restore`, and **Update now** (when the
      instance offers a newer release) installs it within ten minutes: the
      node is not busy after the restore;
    - **7c** **restore checks** (the monthly restore check of a backup job,
      planned within about five minutes for a guest without one): the VM's
      passes (green) and leaves nothing behind; the container's, with the
      16 MB restore folder, fails and must not be green;
    - **7d** the container with raw `lxc.*` lines and a bind mount: its restore
      has neither (only root@pam may set them), the node's log names the
      skipped lines, Restow shows "Restored with warnings" (amber) with what
      to put back; its restore check is yellow; its boot test runs;
    - **7e** the VM with passthrough: restored as root (the node's log says
      so), with the original's devices, and not started although the restore
      asked for the start; its boot test guest has no `hostpciN` or `usbN`;
    - **7f** the protected guest: its restore check removes the protected copy
      (no guest or marker left);
    - **7g** a **restart of restow-pve during a boot test**: the restarted
      service removes the temporary guest, nothing is left, and Restow never
      shows the test green;
    - **7h** a **restart of restow-pve during a backup** started with **Back up
      now**: the backup ends OK, the restarted service waits for it again
      ("waiting again for" in its journal), Restow shows one succeeded run,
      and no PVE notification arrives for it;
    - **7i** a restore of the running container (static IP) from Restow with
      **Start after the restore**: the copy is not started, the node's log
      says why, and Restow shows the restore amber with "the original CT ...
      runs with <IP>";
11. collects `restow-pve status/diagnose --json`, the journals of
    `restow-pve`, `pvedaemon` and `pvestatd`, every task log and the restore
    server logs into **`/root/restow-pve-report-<time>.txt`** (secrets redacted).

It ends with `PASS n, FAIL m, SKIP k`. A SKIP is a step that could not run (a
guest not given, no terminal, a step the tester skipped): it proves nothing.
**Paste the report file back.**

## 4. Also try by hand (5 minutes)

- In Restow, put the test VM into a new backup job and press **Back up now**:
  the run appears on the guest's page; the next scheduled run follows the job.
- On the guest's page: **Restore as a new guest** (target storage, no VMID) and
  **Check now** (the server reads a sample of the restore point back within
  five minutes; the monthly restore check of a job restores on the node, see
  step 7c).
- **Reboot the node** during a boot test and, separately, during a long backup
  (a larger VM): after the reboot no `restow-boottest-*` guest and no marker in
  `/var/lib/restow-pve/tempguests` is left, the boot test is not green in
  Restow, and the backup's run ends failed or is waited for (never a run that
  stays "running").
- Notifications: after steps 5d and 7h, and after a backup from a PVE backup
  job onto the Restow storage, check root@pam's mailbox and every notification
  target: restow-pve's own backups send nothing; a PVE job's backups notify as
  that job says (docs/PVE.md, "Notifications of vzdump").
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
- Notifications on 8.4 and 9.x: after step 8, root@pam's mailbox (and every
  notification target) must have no mail for that backup. If PVE refused
  `notification-mode` (step 8 fails), restow-pve starts its backups without it;
  report the version (docs/PVE.md, "Notifications of vzdump", has a matcher
  that silences successful backups).
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

### Tests of the fixes in 0.5.0

Each fix came with a test that fails without it. Node side (`cd agent && go test
./internal/pve/... ./cmd/restow-pve/...`; the shim with `prove
integrations/pve/plugin/t/`):

| Fix | Tests |
| --- | --- |
| Node idle again after a VM restore | `TestNodeIsIdleAgainAfterAVMRestore`, `TestStaleRestoreFilesDoNotMakeTheNodeBusy`, `TestOpenBackupsMakeTheNodeBusy`, `TestRestoreVolumeInitLeavesNothingBehindWhenItFails` |
| PVE tasks ride out PVE API outages and service restarts | `TestWaitTaskRidesOutAPVEAPIThatDoesNotAnswer`, `TestWaitTaskGivesUpAfterTheOutageWindow`, `TestWaitTaskStopsAtAnAnswerOfPVE`, `TestWaitTaskEndsWhenItsContextEndsDuringTheBackoff`, `TestAHungQmCallIsBounded`, `TestAServiceStopDuringABackupReportsNothingAndTheRestartWaitsAgain` |
| Restore ending "WARNINGS: n" | `TestARestoreEndingWithWarningsSucceedsWithThem`, `TestARestoreEndingWithAnErrorStillFails`, `TestABootTestGoesOnAfterARestoreWithWarnings` |
| New MACs and `onboot 0` for container restores | `TestRestoreGuestGivesAContainerNewMACsAndNoOnboot` |
| One lifecycle for temporary guests (markers, protected guests, DELETE in the query string, VMID taken) | `TestCleanupRemovesAMarkersGuestOnlyWithProof`, `TestCleanupTakesOverTheMarkerOfAnOlderRelease`, `TestDeleteParametersGoIntoTheQueryString`, `TestRestoreCheckRemovesAProtectedGuest`, `TestRestoreCheckSaysWhenItsGuestStays`, `TestRestoreCheckStopsARunningRestoreBeforeItRemovesTheGuest`, `TestARestoreRetriesWhenItsVMIDWasTaken`, `TestTheServiceRemovesLeftoversWhenItStartsWithEverythingOff`, `TestARestoreCheckIsWaitedForAgainAfterARestart`, `TestBootTestRemovesItsGuestWhenTheIsolationFailsAtOnce` |
| Container restores name their mount points | `TestRestoreMounts`, `TestARestoreOfAContainerWithABindMountIntoANewGuest`, `TestAContainerVolumeOfSizeZero` |
| VMs with passthrough restored as root | `TestRootOnlyVMKeys`, `TestAVMWithPassthroughIsRestoredAsRoot`, `TestAPlainVMIsRestoredByTheToken`, `TestABootTestOfAVMWithPassthrough`, `TestARootRestoreWithWarnings`, `TestCLIExit` |
| "Start after the restore" as root, with proof | `TestStartAfterRestoreIsVerified`, `TestStartAfterRestoreIsRefusedWhereTheCopyMayNotRun` |
| Boot test isolation (args, ivshmem, hugepages, NUMA, bridge) | `TestBootTestSkipsAVMWithRawQemuArgs`, `TestBootTestKeepsHarmlessQemuArgs`, `TestBootTestRemovesSharedMemoryHugepagesAndNUMABinding`, `TestBootTestReadBackFindsEveryIsolatedKey`, `TestBootTestSkipsAVMWithAHostDisk`, `TestBootTestSkipsABridgeWithAnUplink`, `TestBootTestStartWithoutNodeMemoryIsSkipped` |
| Boot test space check | `TestReadStorageOptions`, `TestBootTestSpaceCheckCountsWhatTheStorageAllocates`, `TestBootTestSpaceCheckOfAContainer`, `TestBootTestRestoreOutOfSpaceIsSkipped` |
| Boot test green only with proof | `TestContainerBootEvidence`, `TestVMBootEvidence`, `TestBootTestCountsTheZFSARC` |
| Self-update never beside a task | `TestUpdateLoopRetriesSoonAfterABusyNode`, `TestUpdateWhenIdleWaitsForEveryKindOfWork`, `TestNoTaskStartsWhileAnUpdateRuns` |
| Container restore: space check, `--sparse`, `--retry-lock`, own folder | `TestContainerRestoreArgs`, `TestRestoreSpaceCheck`, `TestContainerRestoreRefusedWithoutSpace`, `TestConcurrentContainerRestoresKeepTheirFolders`, `TestContainerRestoreSweepsAbandonedFolders`, `TestContainerRestoreWhileTheRepositoryIsLocked` |
| Restore servers per PVE worker | `TestTwoRestoresOfOneRestorePointKeepTheirServers`, `TestRestoreInitReapsTheServerOfAGoneWorker`, `TestRestoreServerIdleTimeout`, `TestRestoreImageKeepsTwoBatchesInFlight` |
| VM restores ride out a server restart | `TestRestoreCallsRideOutAServerRestart`, `TestRestoreImageFetchesAgainAfterAFailure`, `TestRestoreImageGivesUpOnAPermanentFailure` |
| VM backup stops reading after a failed upload | `TestBackupDiskStopsReadingWhenTheUploadFails` |
| Container backups: lost+found in suspend and stop mode, stable folder for copies, restic cache | `TestContainerBackupLeavesOutLostAndFoundOfMountPointsInSuspendMode`, `TestBackupMountPointsMirrorsTheServer`, `TestContainerBackupRootIsStableForCopies`, `TestContainerBackupOfACopyRunsInTheSameFolderEveryTime`, `TestContainerBackupOfACopyFallsBackWithoutAMountNamespace`, `TestBindPrivateShowsTheCopyToResticOnly`, `TestContainerCacheIsKeptBetweenBackups`, `TestContainerCacheFollowsTheIDMapAndNeverALink`, `TestContainerCacheNeedsSpace`, `TestContainerCachesOfGuestsGoneFromTheNodeAreRemoved` |
| Stopping restic (SIGINT, bounded stderr) and container backups of PVE jobs | `TestStoppingAContainerBackupLetsResticRemoveItsLock`, `TestStoppingAContainerRestoreLetsResticRemoveItsLock`, `TestResticThatIgnoresSIGINTIsKilledAfterTheGrace`, `TestResticErrorsOfAMillionItemsInBoundedMemory`, `TestResticOutputWithAnOverlongLine`, `TestContainerBackupNamesTheFirstUnreadableItemsAndCountsAll`, `TestCancelOrderStopsOnlyAVzdumpTaskOfTheNodesOwn`, `TestCancelOrderLeavesAPVEJobsTaskAndSaysHowTheBackupEnds`, `TestCancelOrderStopsAContainerProviderThroughItsRunFolder`, `TestForgedContainerProviderRecordIsNeverSignalled`, `TestContainerProviderIsKnownByItsRunFolderWhileItRuns` |
| vzdump for a migrated guest, the lock of a PVE backup job, consistency from the log | `TestBackupOfAGuestThatIsNoLongerOnTheNode`, `TestRestoreThatStartsNoTaskFails`, `TestVzdumpLockStateOfRealTaskLogs`, `TestBackupWaitingForThePVEBackupJobsLock`, `TestBackupInitLogsTheLockWait`, `TestVMConsistencyFromVzdumpLogs`, `TestAFailedFreezeIsAWarningOfTheTask`, `TestVMBackupRecordsItsConsistency`, `TestVzdumpGuestLogOfTheRunningBackup` (golden vzdump logs in `agent/internal/pve/testdata`) |
| Prune and notes of a PVE backup job are no-ops | `integrations/pve/plugin/t/shim.t` (prune-backups, notes, protection) |
| No PVE notification for restow-pve's backups | `TestVzdumpFormNotificationModePerPVEVersion`, `TestBackupTaskSendsNoPVENotification`, `TestBackupRunsWhenPVERefusesNotificationMode` |
| Inventory: temporary guests left out, the cluster's guests | `TestInventoryLeavesTheTemporaryGuestsOut`, `TestInventoryCarriesTheClustersGuests`, `TestInventoryIsNotSentWithoutTheClustersGuests` |
| Tasks the node holds, cancels in the queue | `TestHeartbeatListsTheTasksTheNodeHolds`, `TestACancelledQueuedTaskNeverRuns`, `TestACancelledTaskWaitedForAgainStopsItsVzdump` |
| End of a container restore started in PVE | `TestAContainerRestoreStartedInPVEReportsItsEnd`, `TestRestoreEndOfAnExitStatus`, `TestRestoreEndRecordsOfAbandonedAndOldRestores` |
| Restore check checks its target storage | `TestARestoreCheckSkipsATargetStorageThatCannotTakeIt`, `TestARestoreCheckRunsOnAStorageThatTakesIt` |
| VMIDs Restow keeps are not given out | `TestBootTestAvoidsTheVMIDsRestowKeeps`, `TestRestoreAvoidsTheVMIDsRestowKeeps`, `TestVMIDFreeAsksTheCluster` |
| Listing of every page, a guest's Backup tab, `volume_size_info` | `TestListingsReadsEveryPage`, `TestListingsOfAnOlderServer`, `TestListingsFailsRatherThanReturnPartOfIt`, `TestListVolumesOfAGuestAsksTheServer`, `TestVolumeSizeAsksTheServer`, `shim.t` (`volume_size_info` of a restore point outside the listing) |

Server side (`RESTOW_TEST_DATABASE_URL=... pnpm --filter @restow/api test` and `...
--filter @restow/worker test`; `pnpm --filter @restow/web test`):

| Fix | Tests |
| --- | --- |
| A failed restore or restore check is never green; with findings yellow | `apps/api/src/features/pve/pve.pg.test.ts`, `apps/web/src/features/pve/run-status.test.ts` |
| Restores, restore checks and boot tests whose result never comes end failed (boot tests: error) after 48 hours, a delivered one the node no longer holds after ten minutes | `pve.pg.test.ts`, `apps/worker/src/pve/maintenance.pg.test.ts`, `run-status.test.ts` |
| `/restore-points` carries the restore point's size | `pve.pg.test.ts` |
| Boot tests and PVE restores of containers without a phantom run | `pve.pg.test.ts`, `maintenance.pg.test.ts` |
| Monthly restore check only where the node can run it | `pve.pg.test.ts`, `maintenance.pg.test.ts`, `packages/core/src/pve/boot-test.test.ts` |
| Guest list not green when the newest boot test is red; skipped boot tests repeated; a temporary guest left over shows | `pve.pg.test.ts`, `apps/web/src/features/pve/guest-status.test.ts`, `apps/worker/src/pve/boot-tests.pg.test.ts`, `apps/api/src/features/pve/boot-tests.pg.test.ts`, `boot-test.test.ts` |
| Container repositories: restic access for the whole run, checks confirm the snapshot, reconcile with the restore points | `pve.pg.test.ts`, `maintenance.pg.test.ts`, `packages/core/src/endpoints/repository-storage.test.ts` |
| Guests in `restow-restore` do not count for jobs of all guests; a guest on a node without restow-pve stays visible; a reused VMID does not take over a deleted guest | `apps/api/src/features/pve/protection.pg.test.ts`, `packages/core/src/pve/protection.test.ts`, `pve.pg.test.ts`, `guest-status.test.ts` |
| A backup stopped or failing after its commit ends succeeded | `apps/api/src/features/pve/cancel.pg.test.ts` |
| Job options PVE jobs do not support are refused | `pve.pg.test.ts`, `apps/api/src/features/pve/routes.jobs.test.ts` |
| Listing per VMID and in pages | `apps/api/src/features/pve/listing.pg.test.ts` |
| Privileged containers decided by the restore point | `apps/api/src/features/pve/privileged.pg.test.ts`, `maintenance.pg.test.ts`, `boot-test.test.ts` |
