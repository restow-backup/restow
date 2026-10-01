/**
 * Check 11: mail file import and export. EML
 * files in the server-side import folder and an MBOX file uploaded in segments
 * become one imported mailbox; it is exported as an EML ZIP and as MBOX files,
 * and what comes out is compared with what went in by SHA-256 and Message-ID.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMessage, sha256 } from "../lib/corpus.mjs";
import { waitFor } from "../lib/exec.mjs";
import { checkChecksummedZip, exportToEntries } from "../lib/exports.mjs";
import { tenantForCheck, tenantStep } from "../lib/restow.mjs";

const SLUG = "smoke-import";

const lf = (bytes) => bytes.toString("latin1").replace(/\r\n/gu, "\n");

function mboxOf(messages) {
  return Buffer.from(
    messages.map((bytes) => `From MAILER-DAEMON Thu Jan  1 00:00:00 2026\n${lf(bytes)}\n`).join(""),
    "latin1",
  );
}

const messageIdOf = (bytes) => /^Message-ID:\s*(<[^>]+>)/imu.exec(bytes.toString("latin1"))?.[1];

async function finishedImport(api, tenantId, id) {
  return waitFor(
    "the import to finish",
    async () => {
      const current = await api.get(`/api/v1/imports/${id}`, { tenantId });
      return ["completed", "failed", "cancelled"].includes(current.status) ? current : null;
    },
    { timeoutMs: 180_000, intervalMs: 2000 },
  );
}

export async function importExport(ctx, check) {
  const { stack, api } = ctx;
  const folderMessages = [1, 2, 3, 4].map((index) =>
    buildMessage({ seed: 61, index, mailbox: "x@smoke.test" }),
  );
  const folderMbox = [1, 2, 3].map((index) =>
    buildMessage({ seed: 63, index, mailbox: "z@smoke.test" }),
  );
  const uploaded = [1, 2].map((index) =>
    buildMessage({ seed: 62, index, mailbox: "y@smoke.test" }),
  );

  const tenant = await check.step(tenantStep(ctx, "put files in its import folder"), async () => {
    const created = await tenantForCheck(ctx, "Smoke Import Tenant", SLUG);
    // Each tenant reads its own subfolder of the import folder, named by its slug.
    const directory = join(stack.dir, "import", created.slug ?? SLUG);
    mkdirSync(join(directory, "mails"), { recursive: true });
    folderMessages.forEach((bytes, at) =>
      writeFileSync(join(directory, "mails", `m${at + 1}.eml`), bytes),
    );
    writeFileSync(join(directory, "box.mbox"), mboxOf(folderMbox));
    const folder = await api.get("/api/v1/imports/folder?path=", { tenantId: created.id });
    if (!folder.enabled || !folder.exists || folder.entries.length !== 2) {
      throw new Error(`the import folder shows ${JSON.stringify(folder)}`);
    }
    return created;
  });
  const tenantId = tenant.id;

  const imported = await check.step(
    "import the folder entries: 4 EML files and an MBOX of 3 messages",
    async () => {
      const queued = await api.post(
        "/api/v1/imports",
        {
          name: "Smoke import",
          files: [
            { origin: "folder", path: "mails" },
            { origin: "folder", path: "box.mbox" },
          ],
        },
        { tenantId },
      );
      const done = await finishedImport(api, tenantId, queued.id);
      if (done.status !== "completed" || done.messages !== 7 || done.failed !== 0) {
        throw new Error(
          `the import ${done.status}: ${done.messages} messages, ${done.failed} failed`,
        );
      }
      return { objectId: queued.objectId, messages: done.messages };
    },
  );

  await check.step(
    "upload an MBOX in segments (each with its SHA-256), detect it by content and import it",
    async () => {
      const bytes = mboxOf(uploaded);
      const upload = await api.post(
        "/api/v1/imports/uploads",
        { fileName: "uploaded.mbox", size: bytes.length, segmentSize: 1024 },
        { tenantId },
      );
      const segmentSize = upload.segmentSize;
      for (let index = 0, offset = 0; offset < bytes.length; index += 1, offset += segmentSize) {
        const segment = bytes.subarray(offset, offset + segmentSize);
        const response = await fetch(
          `${stack.apiUrl}/api/v1/imports/uploads/${upload.id}/segments/${index}`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/octet-stream",
              "x-segment-sha256": createHash("sha256").update(segment).digest("hex"),
              "x-restow-tenant": tenantId,
              cookie: api.cookieHeader(),
              origin: stack.publicUrl,
            },
            body: segment,
          },
        );
        if (!response.ok) {
          throw new Error(`segment ${index} answered ${response.status}: ${await response.text()}`);
        }
      }
      const ready = await api.post(
        `/api/v1/imports/uploads/${upload.id}/complete`,
        {},
        { tenantId },
      );
      if (ready.detectedFormat !== "mbox") {
        throw new Error(`the upload was detected as ${ready.detectedFormat}, not mbox`);
      }
      const queued = await api.post(
        "/api/v1/imports",
        { objectId: imported.objectId, files: [{ origin: "upload", uploadId: upload.id }] },
        { tenantId },
      );
      const done = await finishedImport(api, tenantId, queued.id);
      if (done.status !== "completed" || done.messages !== uploaded.length || done.failed !== 0) {
        throw new Error(
          `the import ${done.status}: ${done.messages} messages, ${done.failed} failed`,
        );
      }
      return `${ready.segmentCount} segments, ${done.messages} messages`;
    },
  );

  const snapshot = await check.step(
    "the imported mailbox has a snapshot with all 9 messages",
    async () => {
      const snapshots = await api.get(`/api/v1/snapshots?objectId=${imported.objectId}`, {
        tenantId,
      });
      const latest = snapshots.items[0];
      if (!latest || snapshots.items.length < 2) {
        throw new Error(`${snapshots.items.length} snapshots: each import writes a new one`);
      }
      return latest;
    },
  );

  await check.step(
    "export as an EML ZIP: every message equal by SHA-256, the checksum list consistent",
    async () => {
      const { entries } = await exportToEntries(api, tenantId, {
        origin: "snapshot",
        snapshotId: snapshot.id,
        selection: [{ path: "" }],
        format: "eml_zip",
        reason: "release smoke check 11",
      });
      const files = checkChecksummedZip(entries, { extension: ".eml" });
      if (files.length !== 9) {
        throw new Error(`${files.length} messages exported, 9 were imported`);
      }
      // The loose EML files come back byte for byte; MBOX messages by Message-ID.
      const exported = new Set(files.map((file) => file.sha256));
      const missing = folderMessages.filter((bytes) => !exported.has(sha256(bytes))).length;
      if (missing > 0) {
        throw new Error(`${missing} of the 4 EML files did not come back byte for byte`);
      }
      const ids = new Set(files.map((file) => messageIdOf(file.data)));
      const lost = [...folderMbox, ...uploaded].filter(
        (bytes) => !ids.has(messageIdOf(bytes)),
      ).length;
      if (lost > 0) {
        throw new Error(`${lost} of the 5 MBOX messages are not in the export`);
      }
      return "9 messages; 4 EML files byte-exact, 5 MBOX messages by Message-ID";
    },
  );

  await check.step("export as MBOX: all messages in .mbox files with a checksum list", async () => {
    const { entries } = await exportToEntries(api, tenantId, {
      origin: "snapshot",
      snapshotId: snapshot.id,
      selection: [{ path: "" }],
      format: "mbox",
      reason: "release smoke check 11",
    });
    const files = checkChecksummedZip(entries, { extension: ".mbox" });
    const count = files.reduce(
      (sum, file) => sum + (file.data.toString("latin1").match(/^Message-ID:/gimu) ?? []).length,
      0,
    );
    if (count !== 9) {
      throw new Error(`${count} messages in ${files.length} mbox files, 9 were imported`);
    }
    return `${count} messages in ${files.length} mbox files`;
  });
}
