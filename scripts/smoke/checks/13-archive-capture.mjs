/**
 * Check 13: archive capture from an IMAP account and forwarded copies (0.4.4), against
 * the Dovecot of check 5 and the receiver of check 6.
 *
 * A mail job with archive on and both IMAP ways (sync and forwarded copy) takes an account
 * that already holds mail. The capture service activates the account, the backfill takes
 * over the mail that was there (flagged captured late), and IDLE brings new mail into the
 * archive as `imap_sync` within seconds. The account's archive address is issued through
 * the API; the same mail forwarded to it at transport becomes the stronger item that
 * supersedes the synced one. A copy sent to the account's address and the tenant's
 * journal address in one transaction is one item plus one capture row. The hash chain
 * verifies over all of it.
 *
 * Business edition (the capture ways and the receiver): the full build only. The Graph way
 * and its notification hook are checked by the Microsoft 365 checks.
 */
import { buildMessage } from "../lib/corpus.mjs";
import { waitFor } from "../lib/exec.mjs";
import { ImapClient } from "../lib/imap-lite.mjs";
import { addImapMailbox, createTenant } from "../lib/restow.mjs";
import { sendMail } from "../lib/smtp-lite.mjs";
import { JOURNAL_HOST } from "../lib/stack.mjs";

const LOGIN = "capture@smoke.test";
export const CAPTURE_SEED = 13;
/** Reconcile runs every 2 minutes, then activation, IDLE takes up accounts every minute. */
const CAPTURE_TIMEOUT_MS = 6 * 60_000;

export async function archiveCapture(ctx, check) {
  const { stack, api } = ctx;
  const trust = { ca: stack.journalCertificate.certPem, servername: JOURNAL_HOST };
  const smtp = (to, message, from = "bob@sender.smoke.test") =>
    sendMail({
      host: "127.0.0.1",
      port: stack.ports.journal,
      from,
      to,
      tls: trust,
      message: message.toString("latin1"),
    });
  /** The Message-ID of a built message, as the archive compares it. */
  const keyOf = (bytes) =>
    /^Message-ID:\s*<([^>]+)>/imu.exec(bytes.toString("latin1"))?.[1].toLowerCase() ?? "";
  const rows = async (statement) =>
    (await stack.sql(statement))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

  const imap = await ImapClient.connect({
    host: "127.0.0.1",
    port: stack.ports.imap,
    user: LOGIN,
    password: stack.imapPassword,
  });
  try {
    const old = [1, 2].map((index) => buildMessage({ seed: CAPTURE_SEED, index, mailbox: LOGIN }));
    await check.step("seed the account with two mails that exist before the archive", async () => {
      for (const bytes of old) {
        await imap.append("INBOX", bytes, { date: new Date("2025-06-01T08:00:00Z") });
      }
      return `${old.length} mails in INBOX`;
    });

    const tenant = await check.step("create a tenant with the IMAP account", async () =>
      createTenant(api, "Smoke Archive Capture", "smoke-archive-capture"),
    );
    const tenantId = tenant.id;
    const { objectId } = await addImapMailbox(api, tenantId, {
      stack,
      login: LOGIN,
      name: "Capture",
    });
    const archived = (where) =>
      rows(
        `select captured_via || ' ' || coalesce(supersedes_item_id::text, '-') || ' ' || coalesce(flags ? 'captured-late', false)::text || ' ' || id from archive_items where tenant_id = '${tenantId}' and ${where} order by created_at`,
      );

    await check.step(
      "a mail job with archive on, IMAP sync and forwarded copy, takes the account",
      async () => {
        const job = await api.post(
          "/api/v1/backup-jobs",
          {
            kind: "mail",
            name: "Smoke archive capture",
            archive: true,
            archiveCapture: { imap: { sync: true, forward: true } },
            scope: { mode: "selected", members: [{ id: objectId }] },
          },
          { tenantId },
        );
        return `job "${job.name}"`;
      },
    );

    await check.step(
      "the capture service activates the account and the backfill takes over the old mail, flagged captured late",
      async () => {
        const items = await waitFor(
          "the backfilled mail",
          async () => {
            const found = await archived(`protected_object_id = '${objectId}'`);
            return found.length >= old.length ? found : null;
          },
          { timeoutMs: CAPTURE_TIMEOUT_MS, intervalMs: 3_000 },
        );
        const late = items.filter((line) => line.startsWith("imap_sync - true"));
        if (late.length !== old.length) {
          throw new Error(`archived: ${items.join("; ")}`);
        }
        return `${late.length} items, imap_sync, captured late`;
      },
    );

    const fresh = buildMessage({ seed: CAPTURE_SEED, index: 3, mailbox: LOGIN });
    let syncedId = "";
    await check.step("new mail reaches the archive as imap_sync, live (IDLE)", async () => {
      // IDLE takes the account up within a minute of its activation.
      await waitFor(
        "the account to be watched with IDLE",
        async () => {
          const [mode] = await rows(
            `select coalesce(state->>'_mode', '') from archive_capture_streams where protected_object_id = '${objectId}'`,
          );
          return mode === "notifications" ? mode : null;
        },
        { timeoutMs: 3 * 60_000, intervalMs: 3_000 },
      );
      const started = Date.now();
      await imap.append("INBOX", fresh);
      const items = await waitFor(
        "the new mail in the archive",
        async () => {
          const found = await archived(`protected_object_id = '${objectId}'`);
          return found.length > old.length ? found : null;
        },
        { timeoutMs: 2 * 60_000, intervalMs: 1_000 },
      );
      const line = items[items.length - 1];
      if (!line.startsWith("imap_sync - false")) {
        throw new Error(`the new item is ${line}`);
      }
      syncedId = line.split(" ")[3];
      return `archived after ${Math.round((Date.now() - started) / 1000)} s`;
    });

    let accountAddress = "";
    await check.step("the API issues the account's archive address once", async () => {
      const page = await api.get("/api/v1/archive/forwarding", { tenantId });
      const account = page.accounts.find((entry) => entry.objectId === objectId);
      if (!account?.forwardWanted || account.address !== null) {
        throw new Error(`the account is listed as ${JSON.stringify(account)}`);
      }
      const issued = await api.post(`/api/v1/archive/forwarding/${objectId}/address`, undefined, {
        tenantId,
      });
      const again = await api.post(`/api/v1/archive/forwarding/${objectId}/address`, undefined, {
        tenantId,
      });
      const host = JOURNAL_HOST.replaceAll(".", "\\.");
      if (
        !new RegExp(`^archive\\+[a-z2-7]{32}@${host}$`, "u").test(issued.address ?? "") ||
        again.address !== issued.address
      ) {
        throw new Error(`issued ${issued.address}, then ${again.address}`);
      }
      accountAddress = issued.address;
      return `archive+<32 character token>@${JOURNAL_HOST}`;
    });

    await check.step(
      "the same mail forwarded at transport supersedes the synced item",
      async () => {
        const result = await smtp(accountAddress, fresh);
        if (!result.accepted) {
          throw new Error(`the receiver answered ${JSON.stringify(result.final)}`);
        }
        const forwarded = await archived(`captured_via = 'smtp_forward'`);
        if (forwarded.length !== 1 || forwarded[0].split(" ")[1] !== syncedId) {
          throw new Error(`forwarded items: ${forwarded.join("; ")}`);
        }
        return "smtp_forward item names the imap_sync item it supersedes";
      },
    );

    await check.step(
      "a copy to the account and the tenant address in one transaction is one item and a capture row",
      async () => {
        const setup = await api.get("/api/v1/archive/journal", { tenantId });
        const copy = buildMessage({ seed: CAPTURE_SEED, index: 4, mailbox: LOGIN });
        const result = await smtp([accountAddress, setup.address], copy);
        if (!result.accepted) {
          throw new Error(`the receiver answered ${JSON.stringify(result.final)}`);
        }
        const key = keyOf(copy);
        const items = await rows(
          `select id from archive_items where tenant_id = '${tenantId}' and lower(btrim(message_id, '<> ')) = '${key}'`,
        );
        const captures = await rows(
          `select c.captured_via || ' ' || coalesce(c.protected_object_id::text, 'tenant') from archive_item_captures c join archive_items i on i.id = c.archive_item_id where i.tenant_id = '${tenantId}' and lower(btrim(i.message_id, '<> ')) = '${key}'`,
        );
        if (items.length !== 1 || captures.length !== 1 || captures[0] !== "smtp_forward tenant") {
          throw new Error(`${items.length} items, captures ${JSON.stringify(captures)}`);
        }
        const page = await api.get("/api/v1/archive/forwarding", { tenantId });
        const account = page.accounts.find((entry) => entry.objectId === objectId);
        if (account?.status !== "receiving" || account.activity.last24Hours !== 2) {
          throw new Error(`the forwarding page shows ${JSON.stringify(account)}`);
        }
        return "1 item, 1 capture row; the account is receiving";
      },
    );

    await check.step("the hash chain verifies over every captured item", async () => {
      const chain = await api.get("/api/v1/archive/chain/verify", { tenantId });
      const [count] = await rows(
        `select count(*) from archive_items where tenant_id = '${tenantId}'`,
      );
      if (chain.ok !== true || chain.brokenAt !== null || String(chain.checked) !== count) {
        throw new Error(`chain verification: ${JSON.stringify(chain)}, ${count} items`);
      }
      return `${chain.checked} items checked`;
    });
  } finally {
    await imap.logout();
  }
}
