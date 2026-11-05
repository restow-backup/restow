import { describe, expect, it } from "vitest";
import { IMMUTABLE_ID_PREFER } from "../graph/resources/subscriptions.js";
import { type FakeFolder, FakeMailboxGraph } from "../graph/testing/fake-mailbox.js";
import { MemoryCaptureGaps } from "./capture-gaps.js";
import {
  backfillGraphMailbox,
  catchUpGraphMailbox,
  drainGraphPending,
  type GraphBackfillCursor,
  type GraphCaptureSink,
  type GraphCatchUpState,
  graphCaptureFolders,
} from "./graph-capture.js";
import { type HeldMails, messageKey } from "./identity.js";

const USER = "anna";
const FOLDERS: FakeFolder[] = [
  { id: "inbox", displayName: "Inbox", wellKnownName: "inbox" },
  { id: "projects", displayName: "Projects", parentFolderId: "inbox" },
  { id: "sent", displayName: "Sent Items", wellKnownName: "sentitems" },
  { id: "drafts", displayName: "Drafts", wellKnownName: "drafts" },
  { id: "drafts-sub", displayName: "Templates", parentFolderId: "drafts" },
  { id: "search", displayName: "Search Folders", wellKnownName: "searchfolders" },
  {
    id: "deletions",
    displayName: "Deletions",
    wellKnownName: "recoverableitemsdeletions",
    outsideTree: true,
  },
];

/** A sink like the worker's: what was appended, and the dedupe query over it. */
class MemorySink implements GraphCaptureSink {
  gaps?: MemoryCaptureGaps;
  retryLater?: (refs: readonly string[]) => Promise<void>;
  readonly appended: Array<{
    ref: string;
    key: string | null;
    received: Date | null;
    sentAt: Date | null;
    size: number;
  }> = [];

  async alreadyCaptured(query: {
    externalRefs?: readonly string[];
    messageIds?: readonly string[];
  }) {
    const refs = new Set(this.appended.map((a) => a.ref));
    const messages: HeldMails = new Map();
    for (const id of query.messageIds ?? []) {
      const key = messageKey(id);
      if (key === null) {
        continue;
      }
      const held = this.appended
        .filter((a) => a.key === key)
        .map((a) => ({ sizeBytes: a.size, sentAt: a.sentAt }));
      if (held.length > 0) {
        messages.set(key, held);
      }
    }
    return {
      externalRefs: new Set((query.externalRefs ?? []).filter((ref) => refs.has(ref))),
      messages,
    };
  }

  async append(mail: { original: Buffer; externalRef: string; receivedByService: Date | null }) {
    const text = mail.original.toString("utf8");
    const id = /^Message-ID: (.*)$/m.exec(text)?.[1]?.trim() ?? null;
    const date = /^Date: (.*)$/m.exec(text)?.[1]?.trim();
    this.appended.push({
      ref: mail.externalRef,
      key: messageKey(id),
      received: mail.receivedByService,
      sentAt: date ? new Date(date) : null,
      size: mail.original.length,
    });
  }

  refs(): string[] {
    return this.appended.map((a) => a.ref).sort();
  }
}

function mailbox(fake = new FakeMailboxGraph()) {
  fake.addMailbox(USER, FOLDERS, [
    { id: "m1", folderId: "inbox", receivedDateTime: "2026-10-01T08:00:00Z" },
    { id: "m2", folderId: "inbox", receivedDateTime: "2026-11-02T09:00:00Z" },
    { id: "m3", folderId: "projects", receivedDateTime: "2026-11-02T09:30:00Z" },
    { id: "m4", folderId: "sent", receivedDateTime: "2026-11-02T10:00:00Z" },
    { id: "d1", folderId: "drafts", isDraft: true },
    { id: "d2", folderId: "drafts-sub" },
    { id: "x1", folderId: "deletions", receivedDateTime: "2026-11-02T11:00:00Z" },
  ]);
  return fake;
}

const ACTIVATED = new Date("2026-11-02T00:00:00Z");

describe("graphCaptureFolders", () => {
  it("covers the tree and the deletions, not drafts or search folders", async () => {
    const fake = mailbox();
    const folders = await graphCaptureFolders(fake.client(), USER);
    expect(folders.map((f) => f.id).sort()).toEqual(["deletions", "inbox", "projects", "sent"]);
    expect(folders.find((f) => f.id === "projects")?.path).toBe("Inbox/Projects");
  });
});

describe("drainGraphPending", () => {
  it("captures announced mail, skips drafts, held mail and gone mail", async () => {
    const fake = mailbox();
    const sink = new MemorySink();
    await sink.append({
      original: Buffer.from("Message-ID: <m4@fake.example>\r\n\r\nx"),
      externalRef: "m4",
      receivedByService: null,
    });
    const result = await drainGraphPending({
      client: fake.client(),
      userId: USER,
      refs: ["m2", "m3", "d1", "m4", "gone", "m2"],
      sink,
    });
    expect(result.handled.sort()).toEqual(["d1", "gone", "m2", "m3", "m4"]);
    expect(result).toMatchObject({ captured: 2, skipped: 1, drafts: 1, missing: 1, failure: null });
    expect(sink.refs()).toEqual(["m2", "m3", "m4"]);
    // Metadata in one $batch, held mail not asked for.
    const batches = fake.graph.callsTo("POST", "/$batch");
    expect(batches).toHaveLength(1);
    const sent = batches[0]?.json as { requests: unknown[] } | undefined;
    expect(sent?.requests).toHaveLength(4);
    expect(fake.prefer).toContain(IMMUTABLE_ID_PREFER);
    expect(sink.appended.find((a) => a.ref === "m2")?.received?.toISOString()).toBe(
      "2026-11-02T09:00:00.000Z",
    );
  });

  it("leaves refs pending whose metadata request fails, captures the rest", async () => {
    const fake = mailbox();
    fake.failNext("/messages/m3", 403);
    const sink = new MemorySink();
    const result = await drainGraphPending({
      client: fake.client(),
      userId: USER,
      refs: ["m2", "m3"],
      sink,
    });
    expect(result.handled).toEqual(["m2"]);
    expect(result.failure?.status).toBe(403);
  });

  it("downloads a mail whose Message-ID the archive holds under another date", async () => {
    // Same Message-ID, other content (a resend with edited content, a reused id): another
    // mail, which the append keeps next to the first (`message-id-conflict`).
    const fake = mailbox();
    const sink = new MemorySink();
    const mime = (date: string, body: string) =>
      `Message-ID: <ticket-7@helpdesk.example>\r\nFrom: helpdesk@fabrikam.example\r\nTo: user@contoso.example\r\nSubject: Ticket 7\r\nDate: ${date}\r\n\r\n${body}\r\n`;
    fake.addMessage(USER, {
      id: "t1",
      folderId: "inbox",
      internetMessageId: "<ticket-7@helpdesk.example>",
      mime: mime("Mon, 02 Nov 2026 08:00:00 +0000", "Status: open"),
    });
    fake.addMessage(USER, {
      id: "t2",
      folderId: "inbox",
      internetMessageId: "<ticket-7@helpdesk.example>",
      mime: mime("Tue, 03 Nov 2026 15:30:00 +0000", "Status: closed"),
    });
    // The same mail again (a copy in another folder, other immutable id): not downloaded.
    fake.addMessage(USER, {
      id: "t1-copy",
      folderId: "projects",
      internetMessageId: "<ticket-7@helpdesk.example>",
      mime: mime("Mon, 02 Nov 2026 08:00:00 +0000", "Status: open"),
    });
    await drainGraphPending({ client: fake.client(), userId: USER, refs: ["t1"], sink });
    const result = await drainGraphPending({
      client: fake.client(),
      userId: USER,
      refs: ["t2", "t1-copy"],
      sink,
    });
    expect(result).toMatchObject({ captured: 1, skipped: 1 });
    expect(sink.refs()).toEqual(["t1", "t2"]);
    expect(fake.graph.callsTo("GET", "/messages/t1-copy/$value")).toHaveLength(0);
  });

  it("records a message too large for a MIME export as a gap, not silently", async () => {
    const fake = mailbox();
    fake.addMessage(USER, { id: "big", folderId: "inbox", tooLarge: true });
    const sink = new MemorySink();
    const gaps = new MemoryCaptureGaps({ spacingMs: 0 });
    sink.gaps = gaps;
    const result = await drainGraphPending({
      client: fake.client(),
      userId: USER,
      refs: ["big"],
      sink,
    });
    expect(result.oversized).toEqual(["big"]);
    expect(result.handled).toEqual(["big"]);
    expect(sink.appended).toEqual([]);
    expect(gaps.gaps.get("message:big")).toMatchObject({ reason: "too_large", open: true });
  });

  it("records an item Exchange cannot convert to MIME as a gap, never as too large", async () => {
    const fake = mailbox();
    fake.addMessage(USER, {
      id: "irm",
      folderId: "inbox",
      mimeError: { status: 500, code: "ErrorMimeContentConversionFailed" },
    });
    const sink = new MemorySink();
    const gaps = new MemoryCaptureGaps({ spacingMs: 0 });
    sink.gaps = gaps;
    const result = await drainGraphPending({
      client: fake.client(),
      userId: USER,
      refs: ["irm"],
      sink,
    });
    expect(result).toMatchObject({ oversized: [], notConvertible: ["irm"], handled: ["irm"] });
    expect(gaps.open()).toEqual(["message:irm"]);
    expect(gaps.gaps.get("message:irm")?.reason).toBe("not_convertible");
  });

  it("keeps a message whose MIME export failed with 500 pending and archives it on a later pass", async () => {
    const fake = mailbox();
    fake.failNext("/messages/m2/$value", 500, 500);
    const sink = new MemorySink();
    const gaps = new MemoryCaptureGaps({ spacingMs: 0 });
    sink.gaps = gaps;
    const drain = () =>
      drainGraphPending({ client: fake.client(), userId: USER, refs: ["m2"], sink });
    const first = await drain();
    // Not "too large", not handled: it stays pending for the next pass.
    expect(first).toMatchObject({ oversized: [], deferred: ["m2"], handled: [] });
    const second = await drain();
    expect(second.deferred).toEqual(["m2"]);
    const third = await drain();
    expect(third.handled).toEqual(["m2"]);
    expect(sink.refs()).toEqual(["m2"]);
    expect(gaps.open()).toEqual([]);
  });

  it("gives a message up as a gap after three failed exports", async () => {
    const fake = mailbox();
    fake.failNext("/messages/m2/$value", 500, 500, 500);
    const sink = new MemorySink();
    const gaps = new MemoryCaptureGaps({ spacingMs: 0 });
    sink.gaps = gaps;
    for (let pass = 1; pass <= 3; pass++) {
      await drainGraphPending({ client: fake.client(), userId: USER, refs: ["m2"], sink });
    }
    expect(gaps.open()).toEqual(["message:m2"]);
    expect(gaps.gaps.get("message:m2")?.reason).toBe("export_failed");
  });
});

describe("catchUpGraphMailbox", () => {
  it("leaves older mail to the backfill at first, then follows the delta links", async () => {
    const fake = mailbox(new FakeMailboxGraph({ pageSize: 1 }));
    const client = fake.client();
    const sink = new MemorySink();
    const checkpoints: GraphCatchUpState[] = [];
    const first = await catchUpGraphMailbox({
      client,
      userId: USER,
      state: {},
      sink,
      activatedAt: ACTIVATED,
      backfillCompleted: false,
      checkpoint: async (state) => {
        checkpoints.push(state);
      },
    });
    expect(sink.refs()).toEqual(["m2", "m3", "m4", "x1"]);
    expect(first).toMatchObject({ captured: 4, leftToBackfill: 1, folders: 4, resynced: 0 });
    expect(Object.keys(first.state.folders ?? {}).sort()).toEqual([
      "deletions",
      "inbox",
      "projects",
      "sent",
    ]);
    expect(Object.values(first.state.folders ?? {}).every((c) => c.deltaLink)).toBe(true);
    // Paged (1 per page): a checkpoint per page with the next link.
    expect(checkpoints.some((s) => s.folders?.inbox?.nextLink)).toBe(true);
    expect(fake.prefer.every((p) => p.includes(IMMUTABLE_ID_PREFER))).toBe(true);

    // New mail and a move: only the new mail is captured (the moved id is known).
    fake.addMessage(USER, {
      id: "m5",
      folderId: "inbox",
      receivedDateTime: "2026-11-03T08:00:00Z",
    });
    fake.moveMessage(USER, "m2", "projects");
    const second = await catchUpGraphMailbox({
      client,
      userId: USER,
      state: first.state,
      sink,
      activatedAt: ACTIVATED,
      backfillCompleted: false,
    });
    expect(second).toMatchObject({ captured: 1, skipped: 1 });
    expect(sink.refs()).toEqual(["m2", "m3", "m4", "m5", "x1"]);
  });

  it("captures old mail moved into a folder made after capture started, in full", async () => {
    const fake = mailbox();
    const client = fake.client();
    const sink = new MemorySink();
    const first = await catchUpGraphMailbox({
      client,
      userId: USER,
      state: {},
      sink,
      activatedAt: ACTIVATED,
      backfillCompleted: false,
    });
    expect(first.leftToBackfill).toBe(1);
    expect([...(first.state.knownFolders ?? [])].sort()).toEqual([
      "deletions",
      "inbox",
      "projects",
      "sent",
    ]);
    // While the backfill runs, the user makes a folder and moves old mail into it.
    fake.addFolder(USER, { id: "projekt-x", displayName: "Projekt X", parentFolderId: "inbox" });
    fake.moveMessage(USER, "m1", "projekt-x");
    const second = await catchUpGraphMailbox({
      client,
      userId: USER,
      state: first.state,
      sink,
      activatedAt: ACTIVATED,
      backfillCompleted: false,
    });
    // Not left to the backfill: it never lists this folder.
    expect(second).toMatchObject({ captured: 1, leftToBackfill: 0 });
    expect(sink.refs()).toContain("m1");
    expect(second.state.knownFolders).toContain("projekt-x");
  });

  it("hands a message whose export failed to the retry list and moves on", async () => {
    const fake = mailbox();
    fake.failNext("/messages/m3/$value", 500);
    const sink = new MemorySink();
    const retried: string[] = [];
    sink.retryLater = async (refs) => {
      retried.push(...refs);
    };
    const result = await catchUpGraphMailbox({
      client: fake.client(),
      userId: USER,
      state: {},
      sink,
      activatedAt: ACTIVATED,
      backfillCompleted: true,
    });
    expect(retried).toEqual(["m3"]);
    expect(result.deferred).toEqual(["m3"]);
    expect(sink.refs()).not.toContain("m3");
    // The drain of the next pass takes it.
    await drainGraphPending({ client: fake.client(), userId: USER, refs: retried, sink });
    expect(sink.refs()).toContain("m3");
  });

  it("moves past a message whose $value Graph refuses with 403 in a catch-up and the backfill", async () => {
    const fake = mailbox();
    // An item the app may not read: its listing works, its MIME export answers 403.
    fake.addMessage(USER, {
      id: "locked",
      folderId: "inbox",
      receivedDateTime: "2026-11-02T08:30:00Z",
      mimeError: { status: 403, code: "ErrorAccessDenied" },
    });
    const sink = new MemorySink();
    sink.gaps = new MemoryCaptureGaps({ spacingMs: 0 });
    const retried: string[] = [];
    sink.retryLater = async (refs) => {
      retried.push(...refs);
    };
    let state: GraphCatchUpState = {};
    for (let pass = 1; pass <= 3; pass++) {
      const result = await catchUpGraphMailbox({
        client: fake.client(),
        userId: USER,
        state: pass === 1 ? {} : { ...state, folders: {} },
        sink,
        activatedAt: ACTIVATED,
        backfillCompleted: true,
      });
      state = result.state;
    }
    // The catch-up went on past it: every other message is in, the delta position saved.
    expect(sink.refs()).toEqual(["m1", "m2", "m3", "m4", "x1"]);
    expect(state.folders?.inbox?.deltaLink).toBeDefined();
    expect(retried).toContain("locked");
    expect(sink.gaps.open()).toEqual(["message:locked"]);
    expect(sink.gaps.gaps.get("message:locked")?.reason).toBe("fetch_failed");

    const backfill = await backfillGraphMailbox({
      client: fake.client(),
      userId: USER,
      sink,
      cursor: null,
      saveCursor: async () => {},
    });
    expect(backfill.completed).toBe(true);
    expect(backfill.exportFailed).toEqual(["locked"]);
  });

  it("enumerates a folder again after 410 Gone and captures what is unknown", async () => {
    const fake = mailbox();
    const client = fake.client();
    const sink = new MemorySink();
    const first = await catchUpGraphMailbox({
      client,
      userId: USER,
      state: {},
      sink,
      activatedAt: ACTIVATED,
      backfillCompleted: false,
    });
    fake.expireDelta(USER, "inbox");
    const second = await catchUpGraphMailbox({
      client,
      userId: USER,
      state: first.state,
      sink,
      activatedAt: ACTIVATED,
      backfillCompleted: false,
    });
    // The resync is no first enumeration: the older m1 is captured now (flagged late later).
    expect(second).toMatchObject({ resynced: 1, captured: 1 });
    expect(sink.refs()).toContain("m1");
  });

  it("resumes an interrupted enumeration from its checkpoint", async () => {
    const fake = mailbox(new FakeMailboxGraph({ pageSize: 1 }));
    const client = fake.client();
    const sink = new MemorySink();
    const controller = new AbortController();
    let saved: GraphCatchUpState = {};
    await expect(
      catchUpGraphMailbox({
        client,
        userId: USER,
        state: {},
        sink,
        activatedAt: ACTIVATED,
        backfillCompleted: true,
        signal: controller.signal,
        checkpoint: async (state) => {
          saved = state;
          if (state.folders?.inbox?.nextLink) {
            controller.abort();
          }
        },
        folders: [{ id: "inbox", path: "Inbox", wellKnownName: "inbox" }],
      }),
    ).rejects.toThrow();
    expect(saved.folders?.inbox?.nextLink).toBeTruthy();
    const resumed = await catchUpGraphMailbox({
      client,
      userId: USER,
      state: saved,
      sink,
      activatedAt: ACTIVATED,
      backfillCompleted: true,
      folders: [{ id: "inbox", path: "Inbox", wellKnownName: "inbox" }],
    });
    expect(resumed.state.folders?.inbox?.deltaLink).toBeTruthy();
    expect(sink.refs()).toEqual(["m1", "m2"]);
  });

  it("captures everything unknown on a full resync", async () => {
    const fake = mailbox();
    const sink = new MemorySink();
    const result = await catchUpGraphMailbox({
      client: fake.client(),
      userId: USER,
      state: { folders: { inbox: { deltaLink: "https://graph.microsoft.com/v1.0/stale" } } },
      sink,
      activatedAt: ACTIVATED,
      backfillCompleted: false,
      fullResync: true,
    });
    expect(result.leftToBackfill).toBe(0);
    expect(sink.refs()).toEqual(["m1", "m2", "m3", "m4", "x1"]);
  });
});

describe("backfillGraphMailbox", () => {
  it("takes over a folder made while it ran, before it reports completed", async () => {
    const fake = mailbox();
    fake.addMessage(USER, {
      id: "old-sent",
      folderId: "sent",
      receivedDateTime: "2026-09-01T08:00:00Z",
    });
    const sink = new MemorySink();
    let cursor: GraphBackfillCursor | null = null;
    let moved = false;
    const done = await backfillGraphMailbox({
      client: fake.client(),
      userId: USER,
      sink,
      cursor,
      saveCursor: async (next) => {
        cursor = next;
      },
      onPage: () => {
        if (!moved) {
          // After the first page of Inbox: a new folder, and old mail of Sent moved into it.
          moved = true;
          fake.addFolder(USER, { id: "projekt-x", displayName: "Projekt X" });
          fake.moveMessage(USER, "old-sent", "projekt-x");
        }
      },
    });
    expect(done.completed).toBe(true);
    expect(sink.refs()).toContain("old-sent");
    expect(done.cursor.folders).toContain("projekt-x");
  });

  it("takes over every old message although mail already paged is deleted between pages", async () => {
    const fake = new FakeMailboxGraph();
    const old = Array.from({ length: 12 }, (_, n) => ({
      id: `old-${String(n + 1).padStart(2, "0")}`,
      folderId: "inbox",
      receivedDateTime: new Date(Date.UTC(2025, 0, 1 + n, 8)).toISOString(),
    }));
    fake.addMailbox(USER, FOLDERS, old);
    const sink = new MemorySink();
    let cursor: GraphBackfillCursor | null = null;
    const run = (budgetMs?: number) => {
      let clock = 0;
      return backfillGraphMailbox({
        client: fake.client(),
        userId: USER,
        sink,
        cursor,
        saveCursor: async (next) => {
          cursor = next;
        },
        ...(budgetMs !== undefined ? { budgetMs, now: () => clock++ } : {}),
      });
    };
    // A job whose budget ends after a few pages (2 messages each), over hours or days.
    expect((await run(4)).completed).toBe(false);
    const taken = sink.refs();
    expect(taken.length).toBeGreaterThan(0);
    // Meanwhile the user deletes mail the backfill already took: on Graph's offset paging
    // every removal shifted the rest by one and one older mail was never listed.
    for (const id of taken.slice(0, 3)) {
      fake.deleteMessage(USER, id);
    }
    expect((await run()).completed).toBe(true);
    expect(sink.refs()).toEqual(old.map((m) => m.id));
  });

  it("pages through more mail in one second than a page holds", async () => {
    const fake = new FakeMailboxGraph();
    const same = Array.from({ length: 5 }, (_, n) => ({
      id: `burst-${n + 1}`,
      folderId: "inbox",
      receivedDateTime: "2025-03-01T08:00:00Z",
    }));
    fake.addMailbox(USER, FOLDERS, [
      ...same,
      { id: "after", folderId: "inbox", receivedDateTime: "2025-03-01T08:00:01Z" },
    ]);
    const sink = new MemorySink();
    const result = await backfillGraphMailbox({
      client: fake.client(),
      userId: USER,
      sink,
      cursor: null,
      saveCursor: async () => {},
    });
    expect(result.completed).toBe(true);
    expect(sink.refs()).toEqual(["after", "burst-1", "burst-2", "burst-3", "burst-4", "burst-5"]);
  });

  it("pages a folder again from its start when the cursor holds an offset of an earlier version", async () => {
    const fake = mailbox();
    const sink = new MemorySink();
    const result = await backfillGraphMailbox({
      client: fake.client(),
      userId: USER,
      sink,
      cursor: {
        folders: ["inbox", "projects", "sent", "deletions"],
        index: 0,
        nextLink: "https://graph.microsoft.com/v1.0/users/anna/mailFolders/inbox/messages?$skip=2",
        captured: 0,
        skipped: 0,
      },
      saveCursor: async () => {},
    });
    expect(result.completed).toBe(true);
    expect(sink.refs()).toEqual(["m1", "m2", "m3", "m4", "x1"]);
  });

  it("takes over every folder page by page and resumes from its cursor", async () => {
    const fake = mailbox();
    const client = fake.client();
    const sink = new MemorySink();
    let cursor: GraphBackfillCursor | null = null;
    let clock = 0;
    const partial = await backfillGraphMailbox({
      client,
      userId: USER,
      sink,
      cursor,
      saveCursor: async (next) => {
        cursor = next;
      },
      budgetMs: 2,
      now: () => clock++,
    });
    expect(partial.completed).toBe(false);
    expect(cursor).not.toBeNull();
    const done = await backfillGraphMailbox({
      client,
      userId: USER,
      sink,
      cursor,
      saveCursor: async (next) => {
        cursor = next;
      },
    });
    expect(done.completed).toBe(true);
    expect(sink.refs()).toEqual(["m1", "m2", "m3", "m4", "x1"]);
    // Again: nothing new, everything skipped without a download.
    const mimeCalls = fake.graph.calls.filter((c) => c.url.includes("/$value")).length;
    const again = await backfillGraphMailbox({
      client,
      userId: USER,
      sink,
      cursor: null,
      saveCursor: async () => {},
    });
    expect(again).toMatchObject({ completed: true, captured: 0, skipped: 5 });
    expect(fake.graph.calls.filter((c) => c.url.includes("/$value")).length).toBe(mimeCalls);
  });
});
