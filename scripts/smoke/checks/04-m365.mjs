import { waitFor } from "../lib/exec.mjs";
import {
  compareHashes,
  driveHashes,
  folderByName,
  graphToken,
  mimeHashes,
  originalFolders,
} from "../lib/graph.mjs";
/**
 * Check 4: Microsoft 365 backup and restore against the dev tenant. It runs
 * only when the dev tenant's credentials are configured (the M365_TEST_*
 * environment variables, the repository secrets of the same names in CI);
 * without them the report says "skipped: no dev tenant credentials", never a
 * pass. Live tests run against the dev tenant only (docs/TESTING.md), never
 * against customer data.
 *
 * One mailbox (mail, calendar, contacts) and its OneDrive are backed up, a
 * second run (delta) follows, both are restored into a second test account,
 * and what arrived is compared by hash with what was there.
 *
 * NOTE for the maintainer: the interactive step of the admin consent (a
 * Microsoft sign-in by a human) cannot run in CI. The check records the dev
 * tenant's id on the source directly in the database, as the consent callback
 * would after the sign-in, and then lets the product verify the permissions for
 * real (token, permission diff, first Graph call).
 */
import { Skip } from "../lib/report.mjs";
import {
  backUpNow,
  restoreToOriginal,
  tenantForCheck,
  waitForJob,
  waitForSnapshot,
} from "../lib/restow.mjs";

const REQUIRED = [
  "M365_TEST_TENANT_ID",
  "M365_TEST_CLIENT_ID",
  "M365_TEST_CLIENT_SECRET",
  "M365_TEST_MAILBOX",
  "M365_TEST_RESTORE_MAILBOX",
];

/** The dev tenant's settings from the environment, or the names of the missing variables. */
export function m365Config(env) {
  const missing = REQUIRED.filter((name) => !env[name] || env[name].trim() === "");
  if (missing.length > 0) {
    return { missing };
  }
  return {
    missing: [],
    tenantId: env.M365_TEST_TENANT_ID.trim(),
    clientId: env.M365_TEST_CLIENT_ID.trim(),
    clientSecret: env.M365_TEST_CLIENT_SECRET.trim(),
    mailbox: env.M365_TEST_MAILBOX.trim().toLowerCase(),
    restoreMailbox: env.M365_TEST_RESTORE_MAILBOX.trim().toLowerCase(),
  };
}

export async function m365(ctx, check) {
  const config = m365Config(process.env);
  if (config.missing.length > 0) {
    throw new Skip(
      "skipped: no dev tenant credentials (set M365_TEST_TENANT_ID, M365_TEST_CLIENT_ID, M365_TEST_CLIENT_SECRET, M365_TEST_MAILBOX and M365_TEST_RESTORE_MAILBOX)",
    );
  }
  const { stack, api } = ctx;
  const folderName = `Restow smoke ${new Date().toISOString().slice(0, 16).replace(/[:T]/gu, "-")}`;

  await check.step(
    "configure the dev tenant's app registration and restart api and worker",
    async () => {
      stack.addEnv({ ENTRA_CLIENT_ID: config.clientId, ENTRA_CLIENT_SECRET: config.clientSecret });
      await stack.up(["api", "worker"], { forceRecreate: true });
      await stack.waitForApi();
      return "app registration from the environment";
    },
  );

  const tenant = await check.step(
    "connect the dev tenant as a source and verify its permissions",
    async () => {
      const created = await tenantForCheck(ctx, "Smoke M365 Tenant", "smoke-m365");
      const source = await api.post(
        "/api/v1/sources",
        { kind: "m365", name: "Dev tenant", entraTenantHint: config.tenantId },
        { tenantId: created.id },
      );
      await stack.sql(
        `update sources set entra_tenant_id = '${config.tenantId.toLowerCase()}', consent_granted_at = now(), consent_by = 'release smoke (consent granted in the dev tenant beforehand)' where id = '${source.id}'`,
      );
      const verified = await api.post(`/api/v1/sources/${source.id}/verify`, undefined, {
        tenantId: created.id,
      });
      created.sourceId = source.id;
      return { ...created, verification: verified };
    },
  );
  const tenantId = tenant.id;

  const objects = await check.step(
    "directory sync finds the test mailbox and its OneDrive",
    async () => {
      await api.post(
        `/api/v1/directory/sources/${tenant.sourceId}/sync`,
        { full: true },
        { tenantId },
      );
      return waitFor(
        "the test user in the directory",
        async () => {
          const listed = await api.get(
            `/api/v1/directory/objects?sourceId=${tenant.sourceId}&search=${encodeURIComponent(config.mailbox)}&pageSize=50`,
            { tenantId },
          );
          const items = (listed.items ?? []).filter((item) =>
            [item.upn, item.email, item.externalId].some(
              (value) => value?.toLowerCase() === config.mailbox,
            ),
          );
          const mailbox = items.find((item) => item.kind === "mailbox");
          const onedrive = items.find((item) => item.kind === "onedrive");
          return mailbox && onedrive ? { mailbox, onedrive } : null;
        },
        { timeoutMs: 180_000, intervalMs: 5000 },
      );
    },
  );

  const snapshots = await check.step(
    "protect both, back up the mailbox and the OneDrive",
    async () => {
      const result = {};
      for (const [kind, object] of Object.entries(objects)) {
        await api.post(
          `/api/v1/directory/objects/${object.id}/protection`,
          { action: "include", reason: "release smoke" },
          { tenantId },
        );
        result[kind] = await waitForSnapshot(api, tenantId, object.id, { timeoutMs: 900_000 });
      }
      return result;
    },
  );

  await check.step("delta run: a second backup of each completes", async () => {
    for (const [kind, object] of Object.entries(objects)) {
      const [jobId] = await backUpNow(api, tenantId, object.id);
      await waitForJob(api, tenantId, jobId, { timeoutMs: 900_000, what: `the ${kind} delta run` });
      await waitForSnapshot(api, tenantId, object.id, { afterSequence: snapshots[kind].sequence });
    }
  });

  await check.step("restore the mailbox and the OneDrive into the test account", async () => {
    await restoreToOriginal(api, tenantId, (await latest(api, tenantId, objects.mailbox.id)).id, {
      folderName,
      reason: "release smoke check 4",
      target: { type: "other", accountId: config.restoreMailbox },
    });
    await restoreToOriginal(api, tenantId, (await latest(api, tenantId, objects.onedrive.id)).id, {
      folderName,
      reason: "release smoke check 4",
      target: { type: "other", accountId: `${config.restoreMailbox}:/${folderName}` },
    });
  });

  await check.step("every restored mail has the SHA-256 of the original MIME", async () => {
    const token = await graphToken(config);
    const originals = new Map();
    for (const folder of await originalFolders(token, config.mailbox)) {
      for (const [id, hash] of await mimeHashes(token, config.mailbox, folder)) {
        originals.set(id, hash);
      }
    }
    const folderId = await folderByName(token, config.restoreMailbox, folderName);
    if (!folderId) {
      throw new Error(`the folder "${folderName}" does not exist in ${config.restoreMailbox}`);
    }
    const restored = await mimeHashes(token, config.restoreMailbox, folderId);
    const { missing, different } = compareHashes(originals, restored);
    if (missing.length > 0 || different.length > 0) {
      throw new Error(
        `${missing.length} messages missing and ${different.length} different of ${originals.size}`,
      );
    }
    return `${originals.size} messages equal by SHA-256`;
  });

  await check.step("every restored file has the SHA-256 of the original", async () => {
    const token = await graphToken(config);
    const originals = await driveHashes(token, config.mailbox);
    const restored = await driveHashes(token, config.restoreMailbox, folderName);
    const { missing, different } = compareHashes(originals, restored);
    if (missing.length > 0 || different.length > 0) {
      throw new Error(
        `${missing.length} files missing and ${different.length} different of ${originals.size}`,
      );
    }
    return `${originals.size} files equal by SHA-256`;
  });
}

async function latest(api, tenantId, objectId) {
  const list = await api.get("/api/v1/jobs/objects", { tenantId });
  return list.items.find((entry) => entry.id === objectId).lastSnapshot;
}
