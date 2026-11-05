import { describe, expect, it } from "vitest";
import { type FakeFolder, FakeImapServer } from "../backup/imap/testing/fake-imap.js";
import type { ImapAccountConfig, ImapFolderInfo, ImapSession } from "../backup/imap/types.js";
import {
  GAP_ATTEMPT_SPACING_MS,
  GAP_OPEN_AFTER_ATTEMPTS,
  GAP_RETRY_AFTER_MS,
  MemoryCaptureGaps,
} from "./capture-gaps.js";
import { type HeldMails, holdMail, messageKey } from "./identity.js";
import {
  activateImapCapture,
  backfillImapCapture,
  captureFolderPlan,
  catchUpImapCapture,
  type ImapCaptureSink,
  type ImapCaptureState,
  imapCaptureActivated,
  MAX_UNDELIVERED_ATTEMPTS,
  parseImapExternalRef,
  readImapBackfillCursor,
  readImapCaptureState,
} from "./imap-capture.js";

const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return silent;
  },
};

const account: ImapAccountConfig = {
  host: "imap.example.net",
  port: 993,
  security: "tls",
  username: "alice@example.net",
  authKind: "password",
  secretId: "s",
};

function mail(id: string, body = `Body of ${id}`): string {
  return `Message-ID: <${id}>\r\nFrom: bob@example.net\r\nTo: alice@example.net\r\nSubject: ${id}\r\n\r\n${body}\r\n`;
}

/** Add a mail whose ENVELOPE Message-ID is the header's (the fake's default is a counter). */
function put(folder: FakeFolder, id: string, flags: string[] = []): void {
  folder.add(mail(id), { messageId: `<${id}>`, flags });
}

async function connect(server: FakeImapServer): Promise<ImapSession> {
  return server.connect(
    account,
    { kind: "password", password: "pw" },
    {
      logger: silent,
      signal: new AbortController().signal,
    },
  );
}

/** An archive of refs and Message-IDs (with the size of each mail), like the worker's lookup. */
function memorySink() {
  const refs = new Set<string>();
  const held: HeldMails = new Map();
  const appended: { ref: string; messageId: string | null }[] = [];
  const sink: ImapCaptureSink = {
    signal: new AbortController().signal,
    async alreadyCaptured(query) {
      const messages: HeldMails = new Map();
      for (const id of query.messageIds) {
        const key = messageKey(id);
        const found = key === null ? undefined : held.get(key);
        if (key !== null && found) {
          messages.set(key, [...found]);
        }
      }
      return {
        externalRefs: new Set(query.externalRefs.filter((ref) => refs.has(ref))),
        messages,
      };
    },
    async append(item) {
      refs.add(item.externalRef);
      const id = /Message-ID: <([^>]+)>/i.exec(item.original.toString())?.[1] ?? null;
      holdMail(held, id, { sizeBytes: item.original.length, sentAt: null });
      appended.push({ ref: item.externalRef, messageId: id });
    },
  };
  return { sink, appended, held };
}

function folderList(
  folders: readonly { path: string; specialUse?: string; selectable?: boolean }[],
): ImapFolderInfo[] {
  return folders.map((folder) => ({
    path: folder.path,
    name: folder.path.split("/").pop() as string,
    parent: folder.path.split("/").slice(0, -1),
    delimiter: "/",
    selectable: folder.selectable ?? true,
    ...(folder.specialUse ? { specialUse: folder.specialUse } : {}),
  }));
}

describe("captureFolderPlan", () => {
  it("reads every selectable folder but Drafts, INBOX first and watched", () => {
    const server = new FakeImapServer();
    server.addFolder("Sent", { specialUse: "\\Sent" });
    server.addFolder("INBOX");
    server.addFolder("Drafts", { specialUse: "\\Drafts" });
    server.addFolder("Entwürfe");
    server.addFolder("Trash", { specialUse: "\\Trash" });
    server.addFolder("Junk", { specialUse: "\\Junk" });
    server.addFolder("Archive", { selectable: false });
    const listed = [...server.folders.values()].map((folder) => ({
      path: folder.path,
      name: folder.name,
      parent: folder.parent,
      delimiter: folder.delimiter,
      selectable: folder.selectable,
      ...(folder.specialUse ? { specialUse: folder.specialUse } : {}),
    }));
    const plan = captureFolderPlan(listed);
    // "Entwürfe" without \\Drafts is not the Drafts folder when another one is marked; its
    // drafts are still skipped by the \\Draft flag.
    expect(plan.folders.map((folder) => folder.path)).toEqual([
      "INBOX",
      "Entwürfe",
      "Junk",
      "Sent",
      "Trash",
    ]);
    expect(plan.idleFolder).toBe("INBOX");
    expect(plan.gmail).toBe(false);
  });

  it("captures folders named like Drafts below the top level and only skips the marked one", () => {
    const listed = folderList([
      { path: "INBOX", specialUse: "\\Inbox" },
      { path: "Entwürfe", specialUse: "\\Drafts" },
      { path: "Drafts" },
      { path: "Kunden", selectable: false },
      { path: "Kunden/Bozze" },
      { path: "Archiv/Concepten" },
      { path: "Projekte/Acme/Drafts" },
    ]);
    expect(captureFolderPlan(listed).folders.map((folder) => folder.path)).toEqual([
      "INBOX",
      "Archiv/Concepten",
      "Drafts",
      "Kunden/Bozze",
      "Projekte/Acme/Drafts",
    ]);
  });

  it("skips a Drafts folder by name only at the top level or under INBOX when none is marked", () => {
    const listed = folderList([
      { path: "INBOX", specialUse: "\\Inbox" },
      { path: "Drafts" },
      { path: "INBOX/Entwürfe" },
      { path: "Kunden/Bozze" },
    ]);
    expect(captureFolderPlan(listed).folders.map((folder) => folder.path)).toEqual([
      "INBOX",
      "Kunden/Bozze",
    ]);
  });

  it("reads only All Mail, Spam and Trash of a Gmail account and watches All Mail", () => {
    const listed = [
      { path: "INBOX", specialUse: "\\Inbox" },
      { path: "[Gmail]", selectable: false },
      { path: "[Gmail]/All Mail", specialUse: "\\All" },
      { path: "[Gmail]/Sent Mail", specialUse: "\\Sent" },
      { path: "[Gmail]/Drafts", specialUse: "\\Drafts" },
      { path: "[Gmail]/Spam", specialUse: "\\Junk" },
      { path: "[Gmail]/Trash", specialUse: "\\Trash" },
      { path: "Work" },
    ].map((folder) => ({
      path: folder.path,
      name: folder.path.split("/").pop() as string,
      parent: folder.path.split("/").slice(0, -1),
      delimiter: "/",
      selectable: folder.selectable ?? true,
      ...(folder.specialUse ? { specialUse: folder.specialUse } : {}),
    }));
    const plan = captureFolderPlan(listed);
    expect(plan.gmail).toBe(true);
    expect(plan.folders.map((folder) => folder.path)).toEqual([
      "[Gmail]/All Mail",
      "[Gmail]/Spam",
      "[Gmail]/Trash",
    ]);
    expect(plan.idleFolder).toBe("[Gmail]/All Mail");
  });
});

describe("IMAP archive capture", () => {
  it("activates at the current UIDs, captures only new mail live and the rest by backfill", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const sent = server.addFolder("Sent", { specialUse: "\\Sent" });
    put(server.addFolder("Drafts", { specialUse: "\\Drafts" }), "draft@x");
    put(inbox, "old-1@x");
    put(inbox, "old-2@x");
    put(sent, "old-sent@x");
    const session = await connect(server);
    const { sink, appended } = memorySink();

    const state = await activateImapCapture(session, { logger: silent });
    expect(imapCaptureActivated(state)).toBe(true);
    expect(state.folders.INBOX).toMatchObject({ lastUid: 2, backfillUpTo: 2 });
    expect(state.folders.Drafts).toBeUndefined();
    expect(state.idle).toEqual({ folder: "INBOX", supported: true });

    // Nothing new: STATUS only, no folder selected, nothing fetched.
    const opensBefore = server.stats.opens;
    const quiet = await catchUpImapCapture(session, state, sink);
    expect(quiet.captured).toBe(0);
    expect(quiet.foldersRead).toBe(0);
    expect(server.stats.opens).toBe(opensBefore);

    put(inbox, "new-1@x");
    put(inbox, "a-draft@x", ["\\Draft"]);
    const live = await catchUpImapCapture(session, quiet.state, sink);
    expect(live.captured).toBe(1);
    expect(appended.map((item) => item.messageId)).toEqual(["new-1@x"]);
    expect(live.state.folders.INBOX?.lastUid).toBe(4);

    const backfill = await backfillImapCapture(
      session,
      live.state,
      readImapBackfillCursor(null),
      sink,
      {
        saveCursor: async () => undefined,
      },
    );
    expect(backfill.completed).toBe(true);
    expect(backfill.captured).toBe(3);
    expect(appended.map((item) => item.messageId).sort()).toEqual([
      "new-1@x",
      "old-1@x",
      "old-2@x",
      "old-sent@x",
    ]);
    expect(appended.map((item) => item.ref)).toContain("INBOX;1000;1");
  });

  it("skips mail the archive already holds for the mailbox, by Message-ID and size", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const session = await connect(server);
    const { sink, appended, held } = memorySink();
    const state = await activateImapCapture(session);
    holdMail(held, "forwarded@x", {
      sizeBytes: Buffer.byteLength(mail("forwarded@x")),
      sentAt: null,
    });
    put(inbox, "forwarded@x");
    put(inbox, "fresh@x");
    const result = await catchUpImapCapture(session, state, sink);
    expect(result.captured).toBe(1);
    expect(result.skipped).toBe(1);
    expect(appended.map((item) => item.messageId)).toEqual(["fresh@x"]);
    expect(server.stats.sourcesDelivered).toEqual(["INBOX:2"]);
  });

  it("downloads a mail whose Message-ID the archive holds with other content", async () => {
    // A ticket system resending edited content, or a sender reusing an archived mail's
    // Message-ID: another mail, not a duplicate (the append keeps both, flagged).
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const session = await connect(server);
    const { sink, appended } = memorySink();
    let state = await activateImapCapture(session);
    inbox.add(mail("ticket-7@x", "Status: open"), { messageId: "<ticket-7@x>" });
    state = (await catchUpImapCapture(session, state, sink)).state;
    inbox.add(mail("ticket-7@x", "Status: closed, the refund was paid"), {
      messageId: "<ticket-7@x>",
    });
    const result = await catchUpImapCapture(session, state, sink);
    expect(result).toMatchObject({ captured: 1, skipped: 0 });
    expect(appended.map((item) => item.ref)).toEqual(["INBOX;1000;1", "INBOX;1000;2"]);
  });

  it("reads a folder again after a UIDVALIDITY change without archiving anything twice", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const session = await connect(server);
    const { sink, appended } = memorySink();
    let state = await activateImapCapture(session);
    put(inbox, "one@x");
    put(inbox, "two@x");
    state = (await catchUpImapCapture(session, state, sink)).state;
    expect(appended).toHaveLength(2);

    inbox.resetUidValidity();
    put(inbox, "three@x");
    const delivered = server.stats.sourcesDelivered.length;
    const after = await catchUpImapCapture(session, state, sink);
    expect(after.state.folders.INBOX?.uidValidity).toBe("1001");
    expect(after.captured).toBe(1);
    expect(after.skipped).toBe(2);
    // Message-ID and size skip the two known mails before any download: only the new one.
    expect(server.stats.sourcesDelivered.slice(delivered)).toHaveLength(1);
    expect(appended.map((item) => item.messageId)).toEqual(["one@x", "two@x", "three@x"]);
  });

  it("retries a message the server listed but did not deliver", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const session = await connect(server);
    const { sink, appended } = memorySink();
    const state = await activateImapCapture(session);
    put(inbox, "a@x");
    put(inbox, "b@x");
    put(inbox, "c@x");
    server.faults.omitSource.add("INBOX:2");
    const first = await catchUpImapCapture(session, state, sink);
    expect(first.state.folders.INBOX?.lastUid).toBe(1);
    server.faults.omitSource.clear();
    const second = await catchUpImapCapture(session, first.state, sink);
    expect(second.state.folders.INBOX?.lastUid).toBe(3);
    expect(appended.map((item) => item.messageId)).toEqual(["a@x", "c@x", "b@x"]);
  });

  it("captures the UIDs after an undelivered one and holds only the checkpoint before it", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const session = await connect(server);
    const { sink, appended } = memorySink();
    const state = await activateImapCapture(session);
    for (let i = 1; i <= 5; i++) {
      put(inbox, `m${i}@x`);
    }
    server.faults.omitSource.add("INBOX:2");
    const limits = { metaBatch: 2, maxBatchBytes: 1024 * 1024, maxBatchMessages: 10 };
    const first = await catchUpImapCapture(session, state, sink, { limits });
    // The later groups (3-4, 5) were still read; the position stays before UID 2.
    expect(appended.map((item) => item.messageId)).toEqual(["m1@x", "m3@x", "m4@x", "m5@x"]);
    expect(first.state.folders.INBOX).toMatchObject({ lastUid: 1, stuck: { uid: 2, attempts: 1 } });
  });

  it("backfills every folder past a message the server listed but did not deliver", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    for (let i = 1; i <= 5; i++) {
      put(inbox, `old-${i}@x`);
    }
    const session = await connect(server);
    const { sink, appended } = memorySink();
    const state = await activateImapCapture(session);
    server.faults.omitSource.add("INBOX:1");
    const warnings: { message: string; fields: unknown }[] = [];
    const result = await backfillImapCapture(session, state, readImapBackfillCursor(null), sink, {
      limits: { metaBatch: 2, maxBatchBytes: 1024 * 1024, maxBatchMessages: 10 },
      logger: {
        ...silent,
        warn: (message: string, fields?: unknown) => warnings.push({ message, fields }),
      },
      saveCursor: async () => undefined,
    });
    expect(result.completed).toBe(true);
    expect(appended.map((item) => item.messageId)).toEqual([
      "old-2@x",
      "old-3@x",
      "old-4@x",
      "old-5@x",
    ]);
    expect(warnings.map((warning) => warning.message)).toEqual([
      "imap archive backfill: messages listed but not delivered",
    ]);
  });

  it("gives up on a message the server keeps listing without delivering it", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const session = await connect(server);
    const { sink, appended } = memorySink();
    let state = await activateImapCapture(session);
    put(inbox, "a@x");
    put(inbox, "never@x");
    put(inbox, "c@x");
    server.faults.omitSource.add("INBOX:2");
    for (let pass = 1; pass < MAX_UNDELIVERED_ATTEMPTS; pass++) {
      const result = await catchUpImapCapture(session, state, sink);
      state = result.state;
      expect(result.undeliverable).toBe(0);
      expect(state.folders.INBOX).toMatchObject({ lastUid: 1, stuck: { uid: 2, attempts: pass } });
    }
    const last = await catchUpImapCapture(session, state, sink);
    expect(last.undeliverable).toBe(1);
    expect(last.state.folders.INBOX?.lastUid).toBe(3);
    expect(last.state.folders.INBOX?.stuck).toBeUndefined();
    // Caught up now: the next pass selects nothing.
    const opens = server.stats.opens;
    await catchUpImapCapture(session, last.state, sink);
    expect(server.stats.opens).toBe(opens);
    expect(appended.map((item) => item.messageId)).toEqual(["a@x", "c@x"]);
    // The counter survives the round trip through the stream's state JSON.
    expect(readImapCaptureState(JSON.parse(JSON.stringify(state))).folders.INBOX?.stuck).toEqual({
      uid: 2,
      attempts: MAX_UNDELIVERED_ATTEMPTS - 1,
    });
  });

  it("captures the rest of a FETCH batch when the server refuses one message in it", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const session = await connect(server);
    const { sink, appended } = memorySink();
    const state = await activateImapCapture(session);
    put(inbox, "a@x");
    put(inbox, "corrupt@x");
    put(inbox, "c@x");
    server.faults.refuseSource.add("INBOX:2");
    const result = await catchUpImapCapture(session, state, sink, { logger: silent });
    expect(appended.map((item) => item.messageId)).toEqual(["a@x", "c@x"]);
    expect(result.state.folders.INBOX?.lastUid).toBe(1);
  });

  it("reads the folders after one whose FETCH the server refuses", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const sent = server.addFolder("Sent", { specialUse: "\\Sent" });
    const session = await connect(server);
    const { sink, appended } = memorySink();
    const state = await activateImapCapture(session);
    put(inbox, "in@x");
    put(sent, "out@x");
    server.faults.refuseMeta.add("INBOX");
    const result = await catchUpImapCapture(session, state, sink, { logger: silent });
    expect(appended.map((item) => item.messageId)).toEqual(["out@x"]);
    // INBOX keeps where it stood, so the next pass reads it again.
    expect(result.state.folders.INBOX).toEqual(state.folders.INBOX);
    server.faults.refuseMeta.clear();
    await catchUpImapCapture(session, result.state, sink);
    expect(appended.map((item) => item.messageId)).toEqual(["out@x", "in@x"]);
  });

  it("holds the checkpoint on a download cap instead of giving messages up", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const sent = server.addFolder("Sent", { specialUse: "\\Sent" });
    const session = await connect(server);
    const { sink, appended } = memorySink();
    let state = await activateImapCapture(session);
    const before = state.folders.INBOX;
    put(inbox, "a@x");
    put(inbox, "b@x");
    put(sent, "out@x");
    server.faults.refuseSource.add("INBOX:1");
    server.faults.refuseSource.add("INBOX:2");
    server.faults.refuseSourceCode = "OVERQUOTA";
    for (let pass = 1; pass <= MAX_UNDELIVERED_ATTEMPTS + 1; pass++) {
      const result = await catchUpImapCapture(session, state, sink, { logger: silent });
      state = result.state;
      expect(result.undeliverable).toBe(0);
      // Not the messages' fault: no attempt is counted, the position does not move.
      expect(state.folders.INBOX?.lastUid).toBe(before?.lastUid);
      expect(state.folders.INBOX?.stuck).toBeUndefined();
    }
    // The cap is the account's: the folders after INBOX were not tried against it.
    expect(appended).toEqual([]);
    server.faults.refuseSource.clear();
    await catchUpImapCapture(session, state, sink);
    expect(appended.map((item) => item.messageId)).toEqual(["a@x", "b@x", "out@x"]);
  });

  it("fails a backfill on a download cap and resumes it from the cursor", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    for (let i = 1; i <= 4; i++) {
      put(inbox, `old-${i}@x`);
    }
    const session = await connect(server);
    const { sink, appended } = memorySink();
    const state = await activateImapCapture(session);
    server.faults.refuseSource.add("INBOX:3");
    server.faults.refuseSource.add("INBOX:4");
    server.faults.refuseSourceCode = "OVERQUOTA";
    let saved = readImapBackfillCursor(null);
    const run = () =>
      backfillImapCapture(session, state, saved, sink, {
        limits: { metaBatch: 2, maxBatchBytes: 1024 * 1024, maxBatchMessages: 10 },
        logger: silent,
        saveCursor: async (cursor) => {
          saved = cursor;
        },
      });
    await expect(run()).rejects.toThrow(/download limits/);
    expect(saved.completed).not.toContain("INBOX");
    expect(saved.active.INBOX?.lastUid).toBe(2);
    server.faults.refuseSource.clear();
    const result = await run();
    expect(result.completed).toBe(true);
    expect(appended.map((item) => item.messageId)).toEqual([
      "old-1@x",
      "old-2@x",
      "old-3@x",
      "old-4@x",
    ]);
  });

  it("keeps the folders a pass has not reached yet in every mid-pass checkpoint", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const sent = server.addFolder("Sent", { specialUse: "\\Sent" });
    put(sent, "before@x");
    const session = await connect(server);
    const { sink } = memorySink();
    const state = await activateImapCapture(session);
    put(inbox, "in@x");
    put(sent, "out@x");
    const checkpoints: ImapCaptureState[] = [];
    await catchUpImapCapture(session, state, sink, {
      checkpoint: async (snapshot) => {
        checkpoints.push(snapshot);
      },
    });
    // The first checkpoint is taken in INBOX: Sent still has its lastUid and backfillUpTo.
    expect(checkpoints[0]?.folders.Sent).toEqual(state.folders.Sent);
    expect(checkpoints[0]?.folders.Sent?.backfillUpTo).toBe(1);
  });

  it("resumes a backfill from its cursor and stops at the deadline", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const sent = server.addFolder("Sent");
    for (let i = 0; i < 5; i++) {
      put(inbox, `in-${i}@x`);
      put(sent, `out-${i}@x`);
    }
    const session = await connect(server);
    const { sink, appended } = memorySink();
    const state = await activateImapCapture(session);
    let saved = readImapBackfillCursor(null);
    let clock = 0;
    const first = await backfillImapCapture(session, state, saved, sink, {
      limits: { metaBatch: 2, maxBatchBytes: 1024 * 1024, maxBatchMessages: 10 },
      saveCursor: async (cursor) => {
        saved = cursor;
        clock++;
      },
      deadline: 3,
      now: () => clock,
    });
    expect(first.completed).toBe(false);
    expect(saved.completed).toEqual(["INBOX"]);
    const second = await backfillImapCapture(session, state, readImapBackfillCursor(saved), sink, {
      saveCursor: async (cursor) => {
        saved = cursor;
      },
    });
    expect(second.completed).toBe(true);
    expect(appended).toHaveLength(10);
    expect(new Set(appended.map((item) => item.ref)).size).toBe(10);
  });

  it("keeps a folder the server throttles on EXAMINE pending and takes it over on the next job", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const projects = server.addFolder("Projekte");
    put(inbox, "in@x");
    put(projects, "p-1@x");
    put(projects, "p-2@x");
    const session = await connect(server);
    const { sink, appended } = memorySink();
    const gaps = new MemoryCaptureGaps({ spacingMs: 0 });
    const state = await activateImapCapture(session);
    // Gmail's and Exchange's answer to too many commands: NO [OVERQUOTA] on EXAMINE.
    server.faults.refuseOpen.set("Projekte", { code: "OVERQUOTA", remaining: 1 });
    let saved = readImapBackfillCursor(null);
    const run = () =>
      backfillImapCapture(session, state, saved, sink, {
        logger: silent,
        gaps,
        saveCursor: async (cursor) => {
          saved = cursor;
        },
      });
    const first = await run();
    expect(first).toMatchObject({ completed: false, retryLater: true });
    expect(saved.completed).not.toContain("Projekte");
    // A server limit is the account's, not the folder's: no attempt against the folder.
    expect(gaps.gaps.size).toBe(0);
    const second = await run();
    expect(second.completed).toBe(true);
    expect(appended.map((item) => item.messageId).sort()).toEqual(["in@x", "p-1@x", "p-2@x"]);
  });

  it("retries a folder refused with a NO over three jobs, then records it as a gap", async () => {
    const server = new FakeImapServer();
    server.addFolder("INBOX");
    const broken = server.addFolder("Broken");
    put(broken, "lost@x");
    const session = await connect(server);
    const { sink } = memorySink();
    const gaps = new MemoryCaptureGaps({ spacingMs: 0 });
    const state = await activateImapCapture(session);
    server.faults.refuseOpen.set("Broken", { code: null, remaining: Number.POSITIVE_INFINITY });
    let saved = readImapBackfillCursor(null);
    const results = [];
    for (let job = 1; job <= GAP_OPEN_AFTER_ATTEMPTS; job++) {
      results.push(
        await backfillImapCapture(session, state, saved, sink, {
          logger: silent,
          gaps,
          saveCursor: async (cursor) => {
            saved = cursor;
          },
        }),
      );
    }
    expect(results.map((result) => result.completed)).toEqual([false, false, true]);
    expect(results.at(-1)?.gaveUp).toBe(1);
    expect(gaps.open()).toEqual(["backfill_folder:Broken"]);
  });

  describe("live capture and backfill on one gap sink", () => {
    /** One live catch-up and one backfill job per pass, as the capture service runs them. */
    async function interleave(
      server: FakeImapServer,
      passes: number,
      between?: (pass: number) => void,
    ) {
      const session = await connect(server);
      const { sink, appended } = memorySink();
      const gaps = new MemoryCaptureGaps({ spacingMs: 0 });
      let state = await activateImapCapture(session);
      const activated = state;
      let saved = readImapBackfillCursor(null);
      let backfillDone = false;
      const pass = async (n: number) => {
        between?.(n);
        state = (await catchUpImapCapture(session, state, sink, { logger: silent, gaps })).state;
        if (!backfillDone) {
          const result = await backfillImapCapture(session, activated, saved, sink, {
            logger: silent,
            gaps,
            saveCursor: async (cursor) => {
              saved = cursor;
            },
          });
          backfillDone = result.completed;
        }
      };
      for (let n = 1; n <= passes; n++) {
        await pass(n);
      }
      return {
        session,
        sink,
        appended,
        gaps,
        state: () => state,
        backfillDone: () => backfillDone,
        pass,
      };
    }

    it("keeps a folder that refuses EXAMINE but answers STATUS as the backfill's open gap", async () => {
      const server = new FakeImapServer();
      server.addFolder("INBOX");
      const locked = server.addFolder("Gesperrt");
      put(locked, "old-1@x");
      put(locked, "old-2@x");
      // Mid mailbox move, a lock or an ACL problem: EXAMINE is refused, STATUS works, and no
      // new mail arrives, so every live pass only asks STATUS (and finds nothing to read).
      server.faults.refuseOpen.set("Gesperrt", { code: null, remaining: Number.POSITIVE_INFINITY });
      const run = await interleave(server, GAP_OPEN_AFTER_ATTEMPTS + 2);
      // The live passes did not reset the backfill's count: it gave the folder up as its own
      // gap, which stays open however many live passes follow.
      expect(run.backfillDone()).toBe(true);
      expect(run.gaps.open()).toEqual(["backfill_folder:Gesperrt"]);
      expect(run.gaps.gaps.get("backfill_folder:Gesperrt")?.attempts).toBe(GAP_OPEN_AFTER_ATTEMPTS);
      expect(run.appended).toEqual([]);
      for (let n = 0; n < 3; n++) {
        await run.pass(100 + n);
      }
      expect(run.gaps.open()).toEqual(["backfill_folder:Gesperrt"]);

      // Once the folder answers, a resync reads it from its first UID and takes the old mail
      // over: only that resolves the gap.
      server.faults.refuseOpen.clear();
      await run.pass(200);
      expect(run.gaps.open()).toEqual(["backfill_folder:Gesperrt"]);
      await catchUpImapCapture(run.session, run.state(), run.sink, {
        logger: silent,
        gaps: run.gaps,
        rescan: true,
      });
      expect(run.appended.map((item) => item.messageId).sort()).toEqual(["old-1@x", "old-2@x"]);
      expect(run.gaps.open()).toEqual([]);
    });

    it("takes a briefly refused folder's old mail over instead of completing without it", async () => {
      const server = new FakeImapServer();
      server.addFolder("INBOX");
      const busy = server.addFolder("Projekte");
      put(busy, "old-1@x");
      put(busy, "old-2@x");
      // STATUS and EXAMINE refused for two passes (a short outage of that folder), and new
      // mail arrives meanwhile, so the live passes fail on it too.
      const run = await interleave(server, 4, (n) => {
        if (n === 1) {
          server.faults.openFailures.add("Projekte");
          put(busy, "new@x");
        }
        if (n === 3) {
          server.faults.openFailures.clear();
        }
      });
      expect(run.backfillDone()).toBe(true);
      expect(run.appended.map((item) => item.messageId).sort()).toEqual([
        "new@x",
        "old-1@x",
        "old-2@x",
      ]);
      expect(run.gaps.open()).toEqual([]);
    });
  });

  it("asks again for a backfill message the server did not deliver, then records it as a gap", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    for (let i = 1; i <= 3; i++) {
      put(inbox, `old-${i}@x`);
    }
    const session = await connect(server);
    const { sink, appended } = memorySink();
    const gaps = new MemoryCaptureGaps({ spacingMs: 0 });
    const state = await activateImapCapture(session);
    server.faults.refuseSource.add("INBOX:2");
    let saved = readImapBackfillCursor(null);
    const run = () =>
      backfillImapCapture(session, state, saved, sink, {
        limits: { metaBatch: 10, maxBatchBytes: 1024 * 1024, maxBatchMessages: 10 },
        logger: silent,
        gaps,
        saveCursor: async (cursor) => {
          saved = cursor;
        },
      });
    const first = await run();
    expect(first).toMatchObject({ completed: false, retryLater: true });
    expect(saved.retry).toEqual({ INBOX: [2] });
    // Delivered on the second try: taken over, nothing open.
    server.faults.refuseSource.clear();
    expect((await run()).completed).toBe(true);
    expect(appended.map((item) => item.messageId)).toEqual(["old-1@x", "old-3@x", "old-2@x"]);
    expect(gaps.open()).toEqual([]);

    // A message that never comes: given up after three jobs, as an open gap.
    put(inbox, "never@x");
    const later = await activateImapCapture(session);
    server.faults.omitSource.add("INBOX:4");
    saved = readImapBackfillCursor(null);
    const runs = [];
    for (let job = 1; job <= GAP_OPEN_AFTER_ATTEMPTS; job++) {
      runs.push(
        await backfillImapCapture(session, later, saved, sink, {
          logger: silent,
          gaps,
          saveCursor: async (cursor) => {
            saved = cursor;
          },
        }),
      );
    }
    expect(runs.map((result) => result.completed)).toEqual([false, false, true]);
    expect(gaps.open()).toEqual(["message:INBOX;1000;4"]);
  });

  it("counts a folder the server refuses on STATUS as a gap from the third pass, resolved once read", async () => {
    const server = new FakeImapServer();
    server.addFolder("INBOX");
    const archived = server.addFolder("Archiv");
    const session = await connect(server);
    const { sink, appended } = memorySink();
    const gaps = new MemoryCaptureGaps({ spacingMs: 0 });
    let state = await activateImapCapture(session);
    put(archived, "a@x");
    server.faults.openFailures.add("Archiv");
    for (let pass = 1; pass <= GAP_OPEN_AFTER_ATTEMPTS; pass++) {
      const result = await catchUpImapCapture(session, state, sink, { logger: silent, gaps });
      expect(result.foldersFailed).toBe(1);
      state = result.state;
    }
    expect(gaps.open()).toEqual(["folder:Archiv"]);
    server.faults.openFailures.clear();
    await catchUpImapCapture(session, state, sink, { logger: silent, gaps });
    expect(appended.map((item) => item.messageId)).toEqual(["a@x"]);
    expect(gaps.open()).toEqual([]);
  });

  it("records a message the catch-up gives up on as an open gap", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const session = await connect(server);
    const { sink } = memorySink();
    const gaps = new MemoryCaptureGaps({ spacingMs: 0 });
    let state = await activateImapCapture(session);
    put(inbox, "stuck@x");
    server.faults.omitSource.add("INBOX:1");
    for (let pass = 1; pass <= MAX_UNDELIVERED_ATTEMPTS; pass++) {
      state = (await catchUpImapCapture(session, state, sink, { logger: silent, gaps })).state;
    }
    expect(gaps.open()).toEqual(["message:INBOX;1000;1"]);
  });

  it("tolerates unknown and malformed state", () => {
    expect(readImapCaptureState({ folders: { INBOX: { uidValidity: 1 } }, _mode: "poll" })).toEqual(
      {
        folders: {},
      },
    );
    expect(imapCaptureActivated(readImapCaptureState({}))).toBe(false);
  });
});

describe("IMAP capture gaps over time", () => {
  const MINUTE = 60_000;

  /** A gap sink on a clock the test moves (attempts count at most once an hour). */
  function clocked() {
    let now = Date.UTC(2026, 10, 2, 8, 0);
    const gaps = new MemoryCaptureGaps({ now: () => now });
    return {
      gaps,
      later(ms: number) {
        now += ms;
      },
    };
  }

  it("counts an attempt at most once an hour", async () => {
    const { gaps, later } = clocked();
    const gap = { kind: "message" as const, ref: "INBOX;1;7", reason: "undelivered" };
    expect(await gaps.failed(gap)).toBe(1);
    later(10 * MINUTE);
    expect(await gaps.failed(gap)).toBe(1);
    later(GAP_ATTEMPT_SPACING_MS);
    expect(await gaps.failed(gap)).toBe(2);
    later(GAP_ATTEMPT_SPACING_MS);
    expect(await gaps.failed(gap)).toBe(GAP_OPEN_AFTER_ATTEMPTS);
    expect(gaps.open()).toEqual(["message:INBOX;1;7"]);
  });

  it("does not give up a message the server refuses for a few passes in a row", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const session = await connect(server);
    const { sink, appended } = memorySink();
    const { gaps, later } = clocked();
    let state = await activateImapCapture(session);
    put(inbox, "busy@x");
    // Exchange: "The message could not be retrieved" for half an hour, passes ten minutes apart.
    server.faults.refuseSource.add("INBOX:1");
    for (let pass = 1; pass <= MAX_UNDELIVERED_ATTEMPTS + 1; pass++) {
      state = (await catchUpImapCapture(session, state, sink, { logger: silent, gaps })).state;
      later(10 * MINUTE);
    }
    expect(gaps.open()).toEqual([]);
    server.faults.refuseSource.clear();
    await catchUpImapCapture(session, state, sink, { logger: silent, gaps });
    expect(appended.map((item) => item.messageId)).toEqual(["busy@x"]);
    // Counted once in the first hour, never open (the worker's append resolves the row).
    expect(gaps.gaps.get("message:INBOX;1000;1")?.attempts).toBe(1);
    expect(gaps.open()).toEqual([]);
  });

  it("asks a day later for a message it gave up on, below its checkpoint", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const session = await connect(server);
    const { sink, appended } = memorySink();
    const { gaps, later } = clocked();
    let state = await activateImapCapture(session);
    put(inbox, "late@x");
    put(inbox, "next@x");
    server.faults.omitSource.add("INBOX:1");
    for (let pass = 1; pass <= GAP_OPEN_AFTER_ATTEMPTS; pass++) {
      state = (await catchUpImapCapture(session, state, sink, { logger: silent, gaps })).state;
      later(GAP_ATTEMPT_SPACING_MS);
    }
    expect(gaps.open()).toEqual(["message:INBOX;1000;1"]);
    expect(state.folders.INBOX?.lastUid).toBe(2);
    // The server delivers it again; no new mail, so only the retry opens the folder.
    server.faults.omitSource.clear();
    await catchUpImapCapture(session, state, sink, { logger: silent, gaps });
    expect(appended.map((item) => item.messageId)).toEqual(["next@x"]);
    later(GAP_RETRY_AFTER_MS);
    await catchUpImapCapture(session, state, sink, { logger: silent, gaps });
    expect(appended.map((item) => item.messageId)).toEqual(["next@x", "late@x"]);
    expect(gaps.open()).toEqual([]);
  });

  it("takes over a day later the old mail of a folder the backfill gave up", async () => {
    const server = new FakeImapServer();
    server.addFolder("INBOX");
    const moving = server.addFolder("Umzug");
    put(moving, "old-1@x");
    put(moving, "old-2@x");
    const session = await connect(server);
    const { sink, appended } = memorySink();
    const { gaps, later } = clocked();
    let state = await activateImapCapture(session);
    const activated = state;
    server.faults.refuseOpen.set("Umzug", { code: null, remaining: Number.POSITIVE_INFINITY });
    let saved = readImapBackfillCursor(null);
    let completed = false;
    // A backfill job an hour (the requeue delay after a retry) and a live pass apart.
    for (let job = 1; job <= GAP_OPEN_AFTER_ATTEMPTS; job++) {
      state = (await catchUpImapCapture(session, state, sink, { logger: silent, gaps })).state;
      const result = await backfillImapCapture(session, activated, saved, sink, {
        logger: silent,
        gaps,
        saveCursor: async (cursor) => {
          saved = cursor;
        },
      });
      completed = result.completed;
      later(GAP_ATTEMPT_SPACING_MS);
    }
    expect(completed).toBe(true);
    expect(gaps.open()).toEqual(["backfill_folder:Umzug"]);
    server.faults.refuseOpen.clear();
    state = (await catchUpImapCapture(session, state, sink, { logger: silent, gaps })).state;
    expect(appended).toEqual([]);
    later(GAP_RETRY_AFTER_MS);
    state = (await catchUpImapCapture(session, state, sink, { logger: silent, gaps })).state;
    expect(appended.map((item) => item.messageId).sort()).toEqual(["old-1@x", "old-2@x"]);
    expect(gaps.open()).toEqual([]);
    expect(state.folders.Umzug?.lastUid).toBe(2);
  });

  it("counts the account's server limit against no folder in the live capture", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const all = server.addFolder("Archiv");
    const session = await connect(server);
    const { sink, appended } = memorySink();
    const { gaps, later } = clocked();
    let state = await activateImapCapture(session);
    put(inbox, "in@x");
    put(all, "a@x");
    // Gmail while the backfill downloads the account: [OVERQUOTA] for hours, on EXAMINE, on
    // STATUS and on FETCH, passes every ten minutes and then hourly.
    const passes = 3 * GAP_OPEN_AFTER_ATTEMPTS;
    server.faults.refuseOpen.set("INBOX", {
      code: "OVERQUOTA",
      remaining: GAP_OPEN_AFTER_ATTEMPTS,
    });
    server.faults.refuseStatus.set("Archiv", {
      code: "OVERQUOTA",
      remaining: Number.POSITIVE_INFINITY,
    });
    for (let pass = 1; pass <= passes; pass++) {
      if (pass === GAP_OPEN_AFTER_ATTEMPTS + 1) {
        server.faults.refuseSource.add("INBOX:1");
        server.faults.refuseSourceCode = "OVERQUOTA";
      }
      if (pass === 2 * GAP_OPEN_AFTER_ATTEMPTS + 1) {
        // INBOX is read now; STATUS of the next folder still hits the cap.
        server.faults.refuseSource.clear();
        server.faults.refuseSourceCode = null;
      }
      const result = await catchUpImapCapture(session, state, sink, { logger: silent, gaps });
      expect(result.serverLimited).toBe(true);
      expect(result.foldersFailed).toBe(0);
      state = result.state;
      later(GAP_ATTEMPT_SPACING_MS);
    }
    expect(gaps.gaps.size).toBe(0);
    expect(gaps.open()).toEqual([]);
    expect(appended.map((item) => item.messageId)).toEqual(["in@x"]);
    // The cap is lifted: everything is read, nothing was lost or given up.
    server.faults.refuseStatus.clear();
    const result = await catchUpImapCapture(session, state, sink, { logger: silent, gaps });
    expect(result.serverLimited).toBe(false);
    expect(appended.map((item) => item.messageId).sort()).toEqual(["a@x", "in@x"]);
    expect(gaps.open()).toEqual([]);
  });

  it("parses the refs it writes, folder names with ';' included", () => {
    expect(parseImapExternalRef("Kunden;Acme;77;12")).toEqual({
      path: "Kunden;Acme",
      uidValidity: "77",
      uid: 12,
    });
    expect(parseImapExternalRef("INBOX")).toBeNull();
    expect(parseImapExternalRef("INBOX;1;x")).toBeNull();
  });
});

describe("fake IMAP IDLE", () => {
  it("announces new mail in the watched folder and STATUS sees it", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    server.addFolder("Other");
    const session = await connect(server);
    await session.openFolder("INBOX");
    const controller = new AbortController();
    const iterator = session.idle(controller.signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    put(server.folder("Other"), "elsewhere@x");
    put(inbox, "arrived@x");
    expect(await next).toEqual({ value: "exists", done: false });
    expect((await session.status("Other")).uidNext).toBe(2);
    controller.abort();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(server.stats.idles).toBe(1);
  });

  it("ends IDLE with a lost connection when the server drops it", async () => {
    const server = new FakeImapServer();
    server.addFolder("INBOX");
    const session = await connect(server);
    await session.openFolder("INBOX");
    const iterator = session.idle(new AbortController().signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    server.dropAll();
    await expect(next).rejects.toMatchObject({ connectionLost: true });
  });

  it("refuses IDLE on a server without it", async () => {
    const server = new FakeImapServer();
    server.addFolder("INBOX");
    server.faults.noIdle = true;
    const session = await connect(server);
    expect(session.idleSupported).toBe(false);
    await session.openFolder("INBOX");
    await expect(
      session.idle(new AbortController().signal)[Symbol.asyncIterator]().next(),
    ).rejects.toThrow(/IDLE/);
  });
});
