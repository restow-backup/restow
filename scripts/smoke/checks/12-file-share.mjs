/**
 * Check 12: file share backup against Samba (docs/FILESHARES.md 16.4). File shares are core, so
 * both builds run it (the Community build in its one tenant).
 *
 * The mounter is started with the compose profile `mounts`, as the installer does by default
 * for a new installation, and a Samba server (scripts/smoke/samba: SMB 3, NT ACLs as extended
 * attributes) next to it. The share is added through the api as the provider admin, with the
 * Samba container's address (a private address, which a provider admin may use). Then: the
 * test, a share job with one excluded file type, a backup (one file the account may not read
 * makes it end "with warnings", the rest is backed up), the restore point with its permissions
 * sidecar, browsing, the catalog search, a ZIP download compared by SHA-256, the restore check,
 * a second backup after a change and a deletion, a restore of one folder into a new folder with
 * its permissions (content by SHA-256, the explicit ACL entry by smbcacls), a "keep both"
 * restore to the original location, the runs in History and the dashboard, a mirror copy job
 * into a folder of a second share (and refused into a share root), a wrong password
 * (`share.auth_failed`), the empty-source guard (`share.empty_source`, earlier restore points
 * untouched), and finally that the api and the worker were never restarted.
 *
 * Not covered here, and why: a tenant admin refused a private address until "Tenants may use
 * private networks" is on (the smoke signs in as the provider admin only; the rule is pinned by
 * apps/api/src/features/file-shares/tenant.pg.test.ts), NFS (a kernel NFS server needs a
 * privileged container CI runners do not provide reliably; the pg suites and the host checks of
 * 16.3 cover it), and a file locked by an open handle (needs a Windows client holding the
 * handle; the denied file stands in for the per-file warning path).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ApiError } from "../lib/api.mjs";
import { run, waitFor } from "../lib/exec.mjs";
import {
  ACL_FILE,
  ACL_SID,
  DENIED_FILE,
  EXCLUDED_EXTENSION,
  EXCLUDED_FILE,
  NON_ASCII_FILE,
  compareHashes,
  describeDifference,
  expectedInBackup,
  hasAclEntry,
  hashesOf,
  isRestoredCopyOf,
  parseFindSums,
  restartedServices,
  runEnded,
  sha256,
  shareCorpus,
  userSidOf,
  zipHashes,
} from "../lib/fileshares.mjs";
import { Skip } from "../lib/report.mjs";
import { tenantForCheck, tenantStep } from "../lib/restow.mjs";
import { readZip } from "../lib/zip.mjs";

const DATA = "/srv/samba/data";
const COPY = "/srv/samba/copy";
const MIRROR = "Mirror";
const COPY_MARKER = ".restow-copy.json";
/** The services that must never restart while file shares are added, backed up and restored. */
const NEVER_RESTARTED = ["api", "worker"];

const base = (shareId) => `/api/v1/file-shares/${shareId}`;

/** `{ path -> sha256 }` of every file below `folder` in the Samba container. */
async function sumsIn(stack, folder) {
  const result = await stack.exec(
    "samba",
    ["sh", "-c", `cd "${folder}" && find . -type f -exec sha256sum {} +`],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    throw new Error(`could not list ${folder}: ${result.stderr.trim()}`);
  }
  return parseFindSums(result.stdout);
}

/** Run a shell script in the Samba container as root. */
async function onSamba(stack, script) {
  const result = await stack.exec("samba", ["sh", "-c", script], { allowFailure: true });
  if (result.code !== 0) {
    throw new Error(`${script.split("\n")[0]}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

/** When each service's container started (a restart changes it). */
async function startTimes(stack, services) {
  const containers = await stack.containers();
  const times = {};
  for (const service of services) {
    const name = containers[service]?.name;
    if (!name) continue;
    const inspected = await run("docker", ["inspect", "--format", "{{.State.StartedAt}}", name]);
    times[service] = inspected.stdout.trim();
  }
  return times;
}

/** Wait for a run of a share to end; returns the run with its items. */
async function finishedRun(api, tenantId, shareId, runId, { timeoutMs = 300_000 } = {}) {
  return waitFor(
    `run ${runId.slice(0, 8)} to end`,
    async () => {
      const current = await api.get(`${base(shareId)}/runs/${runId}?limit=200`, { tenantId });
      return runEnded(current.status) ? current : null;
    },
    { timeoutMs, intervalMs: 2000 },
  );
}

/** Back up now and wait for the run; returns it. */
async function backUp(api, tenantId, shareId) {
  const queued = await api.post(`${base(shareId)}/backup`, {}, { tenantId });
  return finishedRun(api, tenantId, shareId, queued.run.id);
}

function describeRun(current) {
  const failure = current.failure?.code ?? current.errorMessage ?? "";
  return `${current.status}${failure ? ` (${failure})` : ""}`;
}

/** Restore check now, and wait until the newest restore point has a rating that is not red. */
async function checkNewest(api, tenantId, shareId) {
  await api.post(`${base(shareId)}/verify`, {}, { tenantId });
  return waitFor(
    "the restore check of the newest restore point",
    async () => {
      const points = await api.get(`${base(shareId)}/snapshots`, { tenantId });
      const newest = points.items[0];
      if (newest?.verification.state === "red") {
        throw new Error(`the restore check of restore point ${newest.sequence} is red`);
      }
      return newest && ["green", "yellow"].includes(newest.verification.state) ? newest : null;
    },
    { timeoutMs: 240_000, intervalMs: 3000 },
  );
}

/** The newest run of a copy job (a restore run of the source share that names the job). */
async function newestCopyRun(api, tenantId, sourceId, jobId, after) {
  return waitFor(
    "the copy run",
    async () => {
      const runs = await api.get(`${base(sourceId)}/runs?kind=restore&limit=20`, { tenantId });
      const found = (runs.items ?? runs).find(
        (entry) => entry.backupJobId === jobId && entry.id !== after,
      );
      return found && runEnded(found.status) ? found : null;
    },
    { timeoutMs: 300_000, intervalMs: 2000 },
  );
}

export async function fileShare(ctx, check) {
  const { stack, api } = ctx;
  const probe = await api.request("GET", "/api/v1/file-shares/installation-settings");
  if (probe.status === 404) {
    throw new Skip("skipped: this build has no file share backup (no /api/v1/file-shares route)");
  }

  const before = await check.step(
    "start the mounter (profile mounts, the installer's default) and a Samba server",
    async () => {
      const times = await startTimes(stack, NEVER_RESTARTED);
      const kernel = await run(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--entrypoint",
          "cat",
          ctx.images.client,
          "/proc/filesystems",
        ],
        { allowFailure: true },
      );
      ctx.cifsLoaded = /\bcifs\b/u.test(kernel.stdout);
      await stack.up(["samba"]);
      await stack.compose(["--profile", "mounts", "up", "--detach", "--quiet-pull", "mounter"], {
        timeoutMs: 300_000,
      });
      await waitFor(
        "the mounter's runner to be ready",
        async () => {
          const settings = await api.get("/api/v1/file-shares/installation-settings");
          if (settings.runner.available && !settings.runner.ready && settings.runner.blockers) {
            ctx.runnerBlockers = settings.runner.blockers;
          }
          return settings.runner.available && settings.runner.ready;
        },
        { timeoutMs: 180_000, intervalMs: 3000 },
      ).catch((error) => {
        throw new Error(
          `${error.message}${ctx.runnerBlockers ? `; blockers: ${JSON.stringify(ctx.runnerBlockers)}` : ""}`,
        );
      });
      const mounts = await api.get("/api/v1/mounts");
      if (!mounts.available) {
        throw new Error("Installation > Network shares does not see the mounter");
      }
      return {
        times,
        note: `mounter ready; cifs ${ctx.cifsLoaded ? "loaded" : "not listed in /proc/filesystems (loaded on the first mount if the module exists)"}`,
      };
    },
  );

  const tenant = await check.step(tenantStep(ctx, "for the file shares"), () =>
    tenantForCheck(ctx, "Smoke File Share Tenant", "smoke-fileshare"),
  );
  const tenantId = tenant.id;
  const corpus = shareCorpus();
  const backedUp = expectedInBackup(corpus);
  const created = [];

  try {
    const samba = await check.step(
      "fill the share: files in folders, a non-ASCII name, an explicit ACL, a denied file",
      async () => {
        const local = join(ctx.workDir, "fileshare-corpus");
        rmSync(local, { recursive: true, force: true });
        for (const file of corpus) {
          mkdirSync(dirname(join(local, file.path)), { recursive: true });
          writeFileSync(join(local, file.path), file.bytes);
        }
        await stack.compose(["cp", `${local}/.`, `samba:${DATA}/`]);
        await onSamba(stack, `chown -R smoke:smoke ${DATA} ${COPY}`);
        const credentials = `smoke%${stack.smbPassword}`;
        const userSid = userSidOf(await onSamba(stack, "pdbedit -L -v -u smoke"));
        if (!userSid) throw new Error("pdbedit names no SID for the account");
        await onSamba(
          stack,
          `smbcacls //127.0.0.1/data '${ACL_FILE}' -U '${credentials}' -a 'ACL:${ACL_SID}:ALLOWED/0x0/READ'`,
        );
        await onSamba(
          stack,
          `smbcacls //127.0.0.1/data '${DENIED_FILE}' -U '${credentials}' -a 'ACL:${userSid}:DENIED/0x0/READ'`,
        );
        const acl = await onSamba(
          stack,
          `smbcacls --numeric //127.0.0.1/data '${ACL_FILE}' -U '${credentials}'`,
        );
        if (!hasAclEntry(acl, ACL_SID)) {
          throw new Error(`the explicit ACL entry did not stick: ${acl.trim()}`);
        }
        const sums = await sumsIn(stack, DATA);
        const difference = compareHashes(hashesOf(corpus), sums);
        if (!difference.same) {
          throw new Error(`the share does not hold the corpus: ${describeDifference(difference)}`);
        }
        const containers = await stack.containers();
        const inspected = await run("docker", [
          "inspect",
          "--format",
          "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
          containers.samba.name,
        ]);
        const address = inspected.stdout.trim().split(/\s+/u)[0];
        if (!address) throw new Error("the Samba container has no address");
        return { address, credentials };
      },
    );

    const smb = (name, share) => ({
      protocol: "smb",
      name,
      server: samba.address,
      share,
      subfolder: "",
      account: "smoke",
      password: stack.smbPassword,
      smbVersion: "3.1.1",
      seal: false,
      allowRestore: true,
      permissionsMode: "auto",
      rereadPermissions: false,
    });

    await check.step("the connection test reads the share and its permissions", async () => {
      const {
        name: _name,
        allowRestore: _a,
        permissionsMode: _p,
        rereadPermissions: _r,
        ...connection
      } = smb("Test", "data");
      const result = await api.post("/api/v1/file-shares/test", connection, { tenantId });
      if (!result.ok) {
        throw new Error(`the test failed: ${result.code} ${result.detail ?? ""}`);
      }
      const names = result.entries.map((entry) => entry.name);
      for (const folder of ["Finance", "Reports", "Private"]) {
        if (!names.includes(folder)) throw new Error(`the top level lacks ${folder}: ${names}`);
      }
      return `fs ${result.fsType}, permissions ${result.permissions?.xattr ?? "not readable"}, ${names.length} entries`;
    });

    const share = await check.step(
      "add the share (private address, provider admin) and a second one for copies",
      async () => {
        const data = await api.post("/api/v1/file-shares", smb("Smoke data", "data"), { tenantId });
        created.push(data.id);
        const copy = await api.post("/api/v1/file-shares", smb("Smoke copies", "copy"), {
          tenantId,
        });
        created.push(copy.id);
        if (data.hasPassword !== true || JSON.stringify(data).includes(stack.smbPassword)) {
          throw new Error("the answer carries the password or none was kept");
        }
        return { id: data.id, copyId: copy.id };
      },
    );

    await check.step("a share job with a schedule and one excluded file type", async () => {
      const job = await api.post(
        "/api/v1/backup-jobs",
        {
          kind: "share",
          name: "Smoke shares",
          schedule: { kind: "daily", timeOfDay: "03:00", timeZone: "UTC" },
          settings: { fileTypes: { exclude: [EXCLUDED_EXTENSION] } },
          scope: { mode: "selected", members: [{ id: share.id }] },
        },
        { tenantId },
      );
      share.jobId = job.id;
      return `job "${job.name}"`;
    });

    const first = await check.step(
      "back up now: everything but the denied file, which is a per-file warning",
      async () => {
        const result = await backUp(api, tenantId, share.id);
        if (result.status !== "warning") {
          throw new Error(`the backup ended ${describeRun(result)}, expected "warning"`);
        }
        const denied = result.items.find((item) => item.path.endsWith("denied.txt"));
        if (!denied) {
          throw new Error(`no item names the denied file: ${JSON.stringify(result.itemCounts)}`);
        }
        const points = await api.get(`${base(share.id)}/snapshots`, { tenantId });
        const point = points.items[0];
        if (!point || points.items.length !== 1) {
          throw new Error(`${points.items.length} restore points after the first backup`);
        }
        if (point.files < backedUp.length) {
          throw new Error(
            `the restore point has ${point.files} files, expected ${backedUp.length}`,
          );
        }
        if (!point.permissions || point.permissions.descriptors < 1) {
          throw new Error(`no permissions sidecar: ${JSON.stringify(point.permissions)}`);
        }
        return {
          run: result,
          point,
          note: `${point.files} files, permissions ${point.permissions.mode}/${point.permissions.xattr}, ${point.permissions.descriptors} descriptors; ${denied.code} for ${denied.path}`,
        };
      },
    );

    await check.step(
      "browse the restore point: folders, the non-ASCII name, no /.restow",
      async () => {
        const root = await api.get(
          `${base(share.id)}/browse?snapshot=${first.point.id}&path=${encodeURIComponent("/")}`,
          { tenantId },
        );
        const names = root.entries.map((entry) => entry.name);
        if (names.includes(".restow")) throw new Error("the sidecar folder is listed");
        for (const folder of ["Finance", "Projects", "Reports", "Scans"]) {
          if (!names.includes(folder)) throw new Error(`the root lacks ${folder}: ${names}`);
        }
        const reports = await api.get(
          `${base(share.id)}/browse?snapshot=${first.point.id}&path=${encodeURIComponent("/Reports")}`,
          { tenantId },
        );
        const wanted = NON_ASCII_FILE.split("/").pop();
        if (!reports.entries.some((entry) => entry.name.normalize("NFC") === wanted)) {
          throw new Error(`/Reports lacks ${wanted}`);
        }
        const scans = await api.get(
          `${base(share.id)}/browse?snapshot=${first.point.id}&path=${encodeURIComponent("/Scans")}`,
          { tenantId },
        );
        if (scans.entries.some((entry) => entry.name === EXCLUDED_FILE.split("/").pop())) {
          throw new Error(`the excluded ${EXCLUDED_FILE} was backed up`);
        }
        return `${names.length} entries at the root; ${reports.entries.length} in /Reports`;
      },
    );

    await check.step("search the catalog for a file", async () => {
      const hits = await waitFor(
        "the catalog of the restore point",
        async () => {
          const found = await api.get(`${base(share.id)}/search?q=budget`, { tenantId });
          return found.items.length > 0 ? found.items : null;
        },
        { timeoutMs: 120_000, intervalMs: 3000 },
      );
      if (!hits.some((hit) => hit.path.endsWith(ACL_FILE))) {
        throw new Error(`the hits name no ${ACL_FILE}: ${hits.map((hit) => hit.path)}`);
      }
      return `${hits.length} hits`;
    });

    await check.step("a ZIP download of two folders, every file equal by SHA-256", async () => {
      const prepared = await api.post(
        `${base(share.id)}/downloads`,
        { snapshotId: first.point.id, paths: ["/Finance", "/Reports"] },
        { tenantId },
      );
      const zip = await api.download(
        `${base(share.id)}/downloads/${prepared.id}?tenant=${tenantId}`,
        { tenantId },
      );
      const entries = readZip(zip);
      if (entries.some((entry) => entry.name.includes(".restow"))) {
        throw new Error("the ZIP holds the permissions sidecar");
      }
      const expected = new Map(
        [...hashesOf(backedUp)].filter(
          ([path]) => path.startsWith("Finance/") || path.startsWith("Reports/"),
        ),
      );
      const actual = new Map(
        [...zipHashes(entries)].map(([path, hash]) => [path.normalize("NFC"), hash]),
      );
      const difference = compareHashes(expected, actual);
      if (!difference.same) {
        throw new Error(`the ZIP differs: ${describeDifference(difference)}`);
      }
      return `${expected.size} files, ${zip.length} bytes`;
    });

    await check.step("the restore check of the restore point", async () => {
      const point = await checkNewest(api, tenantId, share.id);
      return `restore point ${point.sequence}: ${point.verification.state}`;
    });

    const changed = await check.step(
      "change and delete a file on the share, back up again",
      async () => {
        await onSamba(
          stack,
          [
            "set -e",
            `printf 'changed by the smoke\\n' >> '${DATA}/Reports/doc-001.bin'`,
            `rm '${DATA}/Projects/Beta/doc-010.bin'`,
          ].join("\n"),
        );
        const result = await backUp(api, tenantId, share.id);
        if (!["succeeded", "warning"].includes(result.status)) {
          throw new Error(`the second backup ended ${describeRun(result)}`);
        }
        const points = await api.get(`${base(share.id)}/snapshots`, { tenantId });
        if (points.items.length !== 2) {
          throw new Error(`${points.items.length} restore points after the second backup`);
        }
        const sums = await sumsIn(stack, DATA);
        return { changedHash: sums.get("Reports/doc-001.bin"), points: points.items };
      },
    );

    await check.step(
      "restore one folder into a new folder with its permissions, equal by SHA-256 and ACL",
      async () => {
        const restore = await api.post(
          `${base(share.id)}/restores`,
          {
            snapshotId: first.point.id,
            paths: ["/Finance"],
            destination: "new_folder",
            restorePermissions: true,
          },
          { tenantId },
        );
        const result = await finishedRun(api, tenantId, share.id, restore.id);
        if (!["succeeded", "warning"].includes(result.status)) {
          throw new Error(`the restore ended ${describeRun(result)}`);
        }
        const listed = await onSamba(stack, `ls -1 '${DATA}'`);
        const folder = listed
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.startsWith("Restow-Restore-"));
        if (!folder) throw new Error(`no Restow-Restore-* folder: ${listed.trim()}`);
        const restored = await sumsIn(stack, `${DATA}/${folder}`);
        const expected = new Map(
          [...hashesOf(backedUp)].filter(([path]) => path.startsWith("Finance/")),
        );
        const difference = compareHashes(expected, restored);
        if (!difference.same) {
          throw new Error(`the restored folder differs: ${describeDifference(difference)}`);
        }
        const acl = await onSamba(
          stack,
          `smbcacls --numeric //127.0.0.1/data '${folder}/${ACL_FILE}' -U '${samba.credentials}'`,
        );
        if (!hasAclEntry(acl, ACL_SID)) {
          throw new Error(
            `the restored ${ACL_FILE} lacks the ACL entry of ${ACL_SID}: ${acl.trim()}`,
          );
        }
        await onSamba(stack, `rm -rf '${DATA}/${folder}'`);
        return `${expected.size} files and the explicit ACL entry in ${folder} (${result.status})`;
      },
    );

    await check.step(
      'restore a changed file to its original location with "keep both"',
      async () => {
        const restore = await api.post(
          `${base(share.id)}/restores`,
          {
            snapshotId: first.point.id,
            paths: ["/Reports/doc-001.bin"],
            destination: "original",
            conflict: "keep_both",
          },
          { tenantId },
        );
        const result = await finishedRun(api, tenantId, share.id, restore.id);
        if (!["succeeded", "warning"].includes(result.status)) {
          throw new Error(`the restore ended ${describeRun(result)}`);
        }
        const sums = await sumsIn(stack, DATA);
        if (sums.get("Reports/doc-001.bin") !== changed.changedHash) {
          throw new Error("the changed file was overwritten");
        }
        const original = hashesOf(corpus).get("Reports/doc-001.bin");
        const copies = [...sums.keys()].filter((path) =>
          isRestoredCopyOf("Reports/doc-001.bin", path),
        );
        if (copies.length !== 1 || sums.get(copies[0]) !== original) {
          throw new Error(`restored copies next to it: ${copies.join(", ") || "none"}`);
        }
        await onSamba(stack, `rm -f '${DATA}/${copies[0]}'`);
        return `kept the changed file, restored the original as "${copies[0].split("/").pop()}"`;
      },
    );

    await check.step("History and the dashboard count the share and its runs", async () => {
      const history = await api.get("/api/v1/history?limit=100", { tenantId });
      const runs = history.items.filter((entry) => entry.source === "file_share");
      if (
        !runs.some((entry) => entry.kind === "backup") ||
        !runs.some((entry) => entry.kind === "restore")
      ) {
        throw new Error(
          `History lists ${runs.length} share runs: ${runs.map((entry) => entry.kind)}`,
        );
      }
      const detail = await api.get(`/api/v1/history/${first.run.id}`, { tenantId });
      if (detail.subject?.kind !== "file_share" || detail.errorCount < 1) {
        throw new Error(
          `the run's page: ${JSON.stringify({ subject: detail.subject, errors: detail.errorCount })}`,
        );
      }
      const dashboard = await api.get("/api/v1/dashboard?widgets=protectedObjects,readiness", {
        tenantId,
      });
      const objects = dashboard.widgets.protectedObjects;
      if (objects?.state !== "ok" || objects.data.fileShares?.protected < 1) {
        throw new Error(`the dashboard counts no protected share: ${JSON.stringify(objects)}`);
      }
      return `${runs.length} share runs in History; ${objects.data.fileShares.protected} protected on the dashboard`;
    });

    await check.step(
      "a mirror copy job into a folder of the second share; a deletion reaches it, nothing outside",
      async () => {
        await onSamba(
          stack,
          `printf 'outside\\n' > '${COPY}/outside.txt' && chown smoke:smoke '${COPY}/outside.txt'`,
        );
        // The newest restore point must be verified before a copy takes it.
        await checkNewest(api, tenantId, share.id);
        const job = await api.post(
          "/api/v1/backup-jobs",
          {
            kind: "copy",
            name: "Smoke mirror",
            schedule: { kind: "daily", timeOfDay: "04:00", timeZone: "UTC" },
            sourceFileShareId: share.id,
            targetFileShareId: share.copyId,
            settings: { mode: "mirror", targetFolder: MIRROR },
          },
          { tenantId },
        );
        await api.post(`/api/v1/backup-jobs/${job.id}/run`, {}, { tenantId });
        const firstCopy = await newestCopyRun(api, tenantId, share.id, job.id, null);
        if (!["succeeded", "warning"].includes(firstCopy.status)) {
          throw new Error(`the first copy ended ${describeRun(firstCopy)}`);
        }
        const withoutMarker = (sums) => new Map([...sums].filter(([path]) => path !== COPY_MARKER));
        const source = await sumsIn(stack, DATA);
        const expected = new Map(
          [...source].filter(([path]) => path !== DENIED_FILE && path !== EXCLUDED_FILE),
        );
        let difference = compareHashes(
          expected,
          withoutMarker(await sumsIn(stack, `${COPY}/${MIRROR}`)),
        );
        if (!difference.same) {
          throw new Error(`the mirror differs from the source: ${describeDifference(difference)}`);
        }
        // Delete on the source, back up, check, copy again.
        await onSamba(stack, `rm '${DATA}/Scans/doc-005.bin'`);
        const backup = await backUp(api, tenantId, share.id);
        if (!["succeeded", "warning"].includes(backup.status)) {
          throw new Error(`the third backup ended ${describeRun(backup)}`);
        }
        await checkNewest(api, tenantId, share.id);
        await api.post(`/api/v1/backup-jobs/${job.id}/run`, {}, { tenantId });
        const secondCopy = await newestCopyRun(api, tenantId, share.id, job.id, firstCopy.id);
        if (!["succeeded", "warning"].includes(secondCopy.status)) {
          throw new Error(`the second copy ended ${describeRun(secondCopy)}`);
        }
        expected.delete("Scans/doc-005.bin");
        difference = compareHashes(
          expected,
          withoutMarker(await sumsIn(stack, `${COPY}/${MIRROR}`)),
        );
        if (!difference.same) {
          throw new Error(
            `after the deletion the mirror differs: ${describeDifference(difference)}`,
          );
        }
        const outside = await sumsIn(stack, COPY);
        if (outside.get("outside.txt") !== sha256(Buffer.from("outside\n"))) {
          throw new Error("the file outside the mirror folder changed");
        }
        return `${expected.size} files mirrored; the deleted one is gone; outside.txt untouched`;
      },
    );

    await check.step("a mirror into a share root is refused", async () => {
      const refused = await api.request("POST", "/api/v1/backup-jobs", {
        tenantId,
        body: {
          kind: "copy",
          name: "Smoke mirror root",
          schedule: { kind: "daily", timeOfDay: "05:00", timeZone: "UTC" },
          sourceFileShareId: share.id,
          targetFileShareId: share.copyId,
          settings: { mode: "mirror", targetFolder: "" },
        },
      });
      if (
        refused.status !== 422 ||
        !String(refused.body?.type).endsWith("file-share-copy-unsafe-target")
      ) {
        throw new ApiError("POST", "/api/v1/backup-jobs", refused.status, refused.body);
      }
      return `422 ${refused.body.type}`;
    });

    await check.step("a wrong password: share.auth_failed and the credential warning", async () => {
      await api.patch(base(share.id), { password: "not-the-password-1" }, { tenantId });
      const result = await api.post(`${base(share.id)}/test`, {}, { tenantId });
      if (result.ok || result.cause !== "share.auth_failed") {
        throw new Error(
          `the test answered ${JSON.stringify({ ok: result.ok, code: result.code, cause: result.cause })}`,
        );
      }
      const current = await api.get(base(share.id), { tenantId });
      if (!current.credentialFailedAt) {
        throw new Error("the share shows no credential warning");
      }
      await api.patch(base(share.id), { password: stack.smbPassword }, { tenantId });
      const again = await api.post(`${base(share.id)}/test`, {}, { tenantId });
      if (!again.ok) throw new Error(`the right password fails: ${again.code}`);
      return `${result.code} (${result.cause}); the right password works again`;
    });

    await check.step(
      "an emptied share is not backed up as empty (share.empty_source), its restore points stay",
      async () => {
        const before = await api.get(`${base(share.id)}/snapshots`, { tenantId });
        await onSamba(stack, `find '${DATA}' -mindepth 1 -delete`);
        const result = await backUp(api, tenantId, share.id);
        if (result.status !== "failed" || result.failure?.code !== "share.empty_source") {
          throw new Error(`the backup of the empty share ended ${describeRun(result)}`);
        }
        const after = await api.get(`${base(share.id)}/snapshots`, { tenantId });
        if (after.items.length !== before.items.length) {
          throw new Error(
            `${before.items.length} restore points before, ${after.items.length} after`,
          );
        }
        return `${after.items.length} restore points untouched`;
      },
    );

    await check.step("the api and the worker were not restarted", async () => {
      const after = await startTimes(stack, NEVER_RESTARTED);
      const restarted = restartedServices(before.times, after);
      if (restarted.length > 0) {
        throw new Error(`restarted: ${restarted.join(", ")}`);
      }
      return `${NEVER_RESTARTED.join(" and ")} started ${Object.values(after)[0]} and still run (${before.note})`;
    });
  } finally {
    // Runner containers and the shares' restic caches outlive the project's `down`.
    for (const shareId of created) {
      const volumes = await run(
        "docker",
        ["volume", "ls", "-q", "--filter", `label=com.restow.mounter.runner.cache=${shareId}`],
        { allowFailure: true },
      );
      for (const volume of volumes.stdout.split("\n").filter(Boolean)) {
        await run("docker", ["volume", "rm", "-f", volume], { allowFailure: true });
      }
    }
  }
}
