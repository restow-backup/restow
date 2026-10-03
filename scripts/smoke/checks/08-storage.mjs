/**
 * Check 8: storage targets. S3 (Garage in a container), a local path, and a
 * bind-mounted directory that stands in for an NFS share each take
 * writes, serve reads and pass a scrub. Every target belongs to its own
 * tenant: a mailbox is backed up to it (write), the restore check reads the
 * data back (read) and a scrub job verifies the packs (scrub).
 */
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildCorpus } from "../lib/corpus.mjs";
import { waitFor } from "../lib/exec.mjs";
import { ImapClient } from "../lib/imap-lite.mjs";
import {
  addImapMailbox,
  addStorageTarget,
  createTenant,
  latestVerification,
  verifyUntilGreen,
  waitForJob,
  waitForSnapshot,
} from "../lib/restow.mjs";

const BUCKET = "restow-smoke";

function countFiles(directory) {
  let count = 0;
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    count += statSync(full).isDirectory() ? countFiles(full) : 1;
  }
  return count;
}

/** One-node Garage: layout, bucket and an access key; returns the key pair. */
async function prepareGarage(stack) {
  const garage = (args) => stack.exec("garage", ["/garage", ...args]);
  const status = await waitFor("Garage to answer", () => garage(["status"]), {
    timeoutMs: 60_000,
    intervalMs: 2000,
  });
  const node = /^([0-9a-f]{16})\s/mu.exec(status.stdout)?.[1];
  if (!node) {
    throw new Error(`no Garage node id in: ${status.stdout}`);
  }
  await garage(["layout", "assign", "--zone", "dc1", "--capacity", "1G", node]);
  await garage(["layout", "apply", "--version", "1"]);
  await waitFor("the bucket to be created", () => garage(["bucket", "create", BUCKET]), {
    timeoutMs: 60_000,
    intervalMs: 2000,
  });
  await garage(["key", "create", "restow-smoke-key"]);
  await garage([
    "bucket",
    "allow",
    "--read",
    "--write",
    "--owner",
    BUCKET,
    "--key",
    "restow-smoke-key",
  ]);
  const info = (await garage(["key", "info", "restow-smoke-key", "--show-secret"])).stdout;
  const accessKeyId = /Key ID:\s+(\S+)/u.exec(info)?.[1];
  const secretAccessKey = /Secret key:\s+(\S+)/u.exec(info)?.[1];
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("could not read the Garage access key");
  }
  return { accessKeyId, secretAccessKey };
}

async function garageObjects(stack) {
  const info = (await stack.exec("garage", ["/garage", "bucket", "info", BUCKET])).stdout;
  return Number(/Objects:\s+(\d+)/u.exec(info)?.[1] ?? 0);
}

export async function storageTargets(ctx, check) {
  const { stack, api } = ctx;

  const garageKey = await check.step(
    "prepare the S3 service (Garage): layout, bucket, access key",
    () => prepareGarage(stack),
  );

  const targets = [
    {
      key: "s3",
      title: "S3 (Garage)",
      login: "s3box@smoke.test",
      body: () => ({
        kind: "s3",
        name: "Garage",
        config: {
          bucket: BUCKET,
          endpoint: "http://garage:3900",
          region: "garage",
          forcePathStyle: true,
          prefix: "smoke-s3/",
        },
        credentials: garageKey,
      }),
      written: () => garageObjects(stack),
    },
    {
      key: "local",
      title: "local path",
      login: "localbox@smoke.test",
      // A directory must exist before it can be a target, as it does for an operator.
      prepare: () => stack.exec("api", ["mkdir", "-p", "/data/targets/local-smoke"]),
      body: () => ({
        kind: "local",
        name: "Local path",
        config: { basePath: "/data/targets/local-smoke" },
      }),
      written: async () =>
        Number(
          (
            await stack.exec("api", ["sh", "-c", "find /data/targets/local-smoke -type f | wc -l"])
          ).stdout.trim(),
        ),
    },
    {
      key: "nfs",
      title: "mounted directory (NFS stand-in)",
      login: "nfsbox@smoke.test",
      prepare: () => mkdirSync(join(stack.nfsDir, "restow"), { recursive: true }),
      body: () => ({
        kind: "local",
        name: "Mounted share",
        config: { basePath: "/mnt/nfs-sim/restow" },
      }),
      written: async () => countFiles(stack.nfsDir),
    },
  ];

  for (const target of targets) {
    const name = target.title;
    const imap = await ImapClient.connect({
      host: "127.0.0.1",
      port: stack.ports.imap,
      user: target.login,
      password: stack.imapPassword,
    });
    try {
      for (const message of buildCorpus({
        seed: 40 + targets.indexOf(target),
        mailbox: target.login,
        count: 8,
        folders: { INBOX: 1 },
      })) {
        await imap.append("INBOX", message.bytes);
      }
    } finally {
      await imap.logout();
    }

    const tenant = await check.step(
      `${name}: create a tenant and attach the target as its primary storage`,
      async () => {
        await target.prepare?.();
        const created = await createTenant(
          api,
          `Smoke Storage ${target.key}`,
          `smoke-storage-${target.key}`,
        );
        const { probe } = await addStorageTarget(api, created.id, target.body());
        if (!probe?.ok) {
          throw new Error(`the target probe failed: ${JSON.stringify(probe)}`);
        }
        const steps = (probe.steps ?? [])
          .map((step) => `${step.step}:${step.ok ? "ok" : "failed"}`)
          .join(" ");
        created.probeSteps = steps;
        return created;
      },
    );
    const tenantId = tenant.id;

    await check.step(`${name}: write — a backup lands on the target`, async () => {
      const { objectId } = await addImapMailbox(api, tenantId, {
        stack,
        login: target.login,
        name: target.key,
      });
      const snapshot = await waitForSnapshot(api, tenantId, objectId);
      const written = await target.written();
      if (written < 2) {
        throw new Error(`the target holds ${written} files after the backup`);
      }
      tenant.objectId = objectId;
      return `probe ${tenant.probeSteps}; snapshot of ${snapshot.itemCount} items; ${written} objects on the target`;
    });

    await check.step(
      `${name}: read — the restore check reads everything back and is green`,
      async () => {
        await verifyUntilGreen(api, tenantId, tenant.objectId);
        return "green";
      },
    );

    await check.step(`${name}: scrub — the packs verify`, async () => {
      const queued = await api.post("/api/v1/verify/scrub", {}, { tenantId });
      await waitForJob(api, tenantId, queued.jobId, { what: "the scrub" });
      const latest = await latestVerification(api, tenantId);
      const storage = latest.storage;
      const scrub = storage?.latest;
      if (storage?.state !== "ok" || !scrub || scrub.ok < 1 || (scrub.corrupt ?? []).length > 0) {
        throw new Error(`scrub result: ${JSON.stringify(storage)}`);
      }
      return `${scrub.packsChecked} packs checked, ${scrub.ok} ok, none corrupt`;
    });
  }
}
