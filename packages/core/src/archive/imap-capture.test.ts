import { describe, expect, it } from "vitest";
import { type FakeFolder, FakeImapServer } from "../backup/imap/testing/fake-imap.js";
import type { ImapAccountConfig, ImapSession } from "../backup/imap/types.js";
import { messageKey } from "./identity.js";
import {
  activateImapCapture,
  backfillImapCapture,
  captureFolderPlan,
  catchUpImapCapture,
  type ImapCaptureSink,
  imapCaptureActivated,
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

/** An archive of refs and Message-IDs, like the worker's per-mailbox lookup. */
function memorySink() {
  const refs = new Set<string>();
  const keys = new Set<string>();
  const appended: { ref: string; messageId: string | null }[] = [];
  const sink: ImapCaptureSink = {
    signal: new AbortController().signal,
    async alreadyCaptured(query) {
      return {
        externalRefs: new Set(query.externalRefs.filter((ref) => refs.has(ref))),
        messageKeys: new Set(
          query.messageIds
            .map((id) => messageKey(id))
            .filter((key): key is string => key !== null && keys.has(key)),
        ),
      };
    },
    async append(item) {
      refs.add(item.externalRef);
      const id = /Message-ID: <([^>]+)>/i.exec(item.original.toString())?.[1] ?? null;
      const key = messageKey(id);
      if (key) {
        keys.add(key);
      }
      appended.push({ ref: item.externalRef, messageId: id });
    },
  };
  return { sink, appended, keys };
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
    expect(plan.folders.map((folder) => folder.path)).toEqual(["INBOX", "Junk", "Sent", "Trash"]);
    expect(plan.idleFolder).toBe("INBOX");
    expect(plan.gmail).toBe(false);
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

  it("skips mail the archive already holds for the mailbox, by Message-ID", async () => {
    const server = new FakeImapServer();
    const inbox = server.addFolder("INBOX");
    const session = await connect(server);
    const { sink, appended, keys } = memorySink();
    const state = await activateImapCapture(session);
    keys.add("forwarded@x");
    put(inbox, "forwarded@x");
    put(inbox, "fresh@x");
    const result = await catchUpImapCapture(session, state, sink);
    expect(result.captured).toBe(1);
    expect(result.skipped).toBe(1);
    expect(appended.map((item) => item.messageId)).toEqual(["fresh@x"]);
    expect(server.stats.sourcesDelivered).toEqual(["INBOX:2"]);
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
    const after = await catchUpImapCapture(session, state, sink);
    expect(after.state.folders.INBOX?.uidValidity).toBe("1001");
    expect(after.captured).toBe(1);
    expect(after.skipped).toBe(2);
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

  it("tolerates unknown and malformed state", () => {
    expect(readImapCaptureState({ folders: { INBOX: { uidValidity: 1 } }, _mode: "poll" })).toEqual(
      {
        folders: {},
      },
    );
    expect(imapCaptureActivated(readImapCaptureState({}))).toBe(false);
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
