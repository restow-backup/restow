/**
 * Check 5: IMAP backup and restore against a real IMAP server (Dovecot in a
 * container), compared by hash.
 *
 * A mailbox with messages in two folders is backed up. New messages arrive, a
 * second (incremental) backup picks them up. The latest snapshot is restored
 * into the same mailbox next to the originals; every restored message must
 * hash to the same SHA-256 as the message that was appended, folder by
 * folder. The restore check ("Verify now") must come back green.
 */
import { buildCorpus, buildMessage, sha256 } from "../lib/corpus.mjs";
import { ImapClient } from "../lib/imap-lite.mjs";
import {
  addImapMailbox,
  backUpNow,
  restoreToOriginal,
  tenantForCheck,
  tenantStep,
  verifyUntilGreen,
  waitForJob,
  waitForSnapshot,
} from "../lib/restow.mjs";

const LOGIN = "alice@smoke.test";
const RESTORE_FOLDER = "Restow restore";
export const IMAP_SEED = 11;
const FOLDERS = ["INBOX", "Archive 2026"];

/** Hashes of the messages in `mailbox`, sorted. */
async function hashesOf(imap, mailbox) {
  return (await imap.messages(mailbox)).map((message) => sha256(message.bytes)).sort();
}

export async function imapBackup(ctx, check) {
  const { stack, api } = ctx;
  const imap = await ImapClient.connect({
    host: "127.0.0.1",
    port: stack.ports.imap,
    user: LOGIN,
    password: stack.imapPassword,
  });
  try {
    const corpus = buildCorpus({ seed: IMAP_SEED, mailbox: LOGIN, count: 24 });
    const extra = [1, 2, 3].map((n) => ({
      folder: "INBOX",
      bytes: buildMessage({ seed: IMAP_SEED + 100, index: n, mailbox: LOGIN }),
    }));
    const expected = { INBOX: [], "Archive 2026": [] };

    await check.step("seed the mailbox: 24 messages in INBOX and Archive 2026", async () => {
      await imap.create("Archive 2026");
      for (const message of corpus) {
        await imap.append(message.folder, message.bytes);
        expected[message.folder].push(message.sha256);
      }
      const inbox = await hashesOf(imap, "INBOX");
      if (inbox.length !== expected.INBOX.length) {
        throw new Error(
          `the server holds ${inbox.length} INBOX messages, ${expected.INBOX.length} were appended`,
        );
      }
      return `${expected.INBOX.length} in INBOX, ${expected["Archive 2026"].length} in Archive 2026`;
    });

    const tenant = await check.step(tenantStep(ctx, "connect the mailbox"), async () => {
      const created = await tenantForCheck(ctx, "Smoke IMAP Tenant", "smoke-imap");
      const { objectId } = await addImapMailbox(api, created.id, {
        stack,
        login: LOGIN,
        name: "Alice",
      });
      ctx.imap = { tenantId: created.id, objectId, login: LOGIN };
      return created;
    });
    const tenantId = tenant.id;
    const { objectId } = ctx.imap;

    const first = await check.step("first backup completes", async () => {
      const snapshot = await waitForSnapshot(api, tenantId, objectId);
      // 24 messages plus the folders.
      if (snapshot.itemCount < 24) {
        throw new Error(
          `the snapshot holds ${snapshot.itemCount} items, at least 24 were expected`,
        );
      }
      return snapshot;
    });

    await check.step("new mail arrives and the incremental backup picks it up", async () => {
      for (const message of extra) {
        await imap.append(message.folder, message.bytes);
        expected.INBOX.push(sha256(message.bytes));
      }
      // The schedule may have taken a snapshot in between: wait for one newer than the first.
      let sequence = first.sequence;
      const [jobId] = await backUpNow(api, tenantId, objectId);
      await waitForJob(api, tenantId, jobId, { what: "the incremental backup" });
      const snapshot = await waitForSnapshot(api, tenantId, objectId, { afterSequence: sequence });
      sequence = snapshot.sequence;
      if (snapshot.itemCount < first.itemCount + extra.length) {
        throw new Error(
          `the incremental snapshot holds ${snapshot.itemCount} items, the first ${first.itemCount} and ${extra.length} were added`,
        );
      }
      ctx.imap.snapshot = snapshot;
      return `snapshot ${snapshot.sequence}: ${snapshot.itemCount} items (${first.itemCount} before)`;
    });

    await check.step("restore the latest snapshot next to the originals", async () => {
      const restore = await restoreToOriginal(api, tenantId, ctx.imap.snapshot.id, {
        folderName: RESTORE_FOLDER,
        reason: "release smoke check 5",
      });
      return `restore ${restore.id} completed`;
    });

    await check.step(
      "every restored message has the SHA-256 of the message that was written",
      async () => {
        const folders = await imap.list();
        const restoredRoots = folders.filter(
          (name) => name === RESTORE_FOLDER || name.startsWith(`${RESTORE_FOLDER}.`),
        );
        if (restoredRoots.length === 0) {
          throw new Error(
            `no folder "${RESTORE_FOLDER}" exists after the restore (folders: ${folders.join(", ")})`,
          );
        }
        let total = 0;
        for (const folder of FOLDERS) {
          const restored = await hashesOf(imap, `${RESTORE_FOLDER}.${folder}`);
          const want = [...expected[folder]].sort();
          if (JSON.stringify(restored) !== JSON.stringify(want)) {
            const missing = want.filter((hash) => !restored.includes(hash)).length;
            const unexpected = restored.filter((hash) => !want.includes(hash)).length;
            throw new Error(
              `${folder}: ${restored.length} restored, ${want.length} expected, ${missing} missing, ${unexpected} unexpected`,
            );
          }
          total += restored.length;
        }
        // The originals are untouched: a restore never replaces what is there.
        for (const folder of FOLDERS) {
          const original = await hashesOf(imap, folder);
          if (JSON.stringify(original) !== JSON.stringify([...expected[folder]].sort())) {
            throw new Error(`the original folder ${folder} changed during the restore`);
          }
        }
        ctx.imap.expected = expected;
        return `${total} messages compared by SHA-256, originals untouched`;
      },
    );

    await check.step("the restore check (Verify now) turns green", async () => {
      const entry = await verifyUntilGreen(api, tenantId, objectId);
      return `green, ${entry.report?.verified ?? entry.readiness ?? "ok"}`;
    });
  } finally {
    await imap.logout();
  }
}
