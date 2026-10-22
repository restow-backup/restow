import { describe, expect, it } from "vitest";
import { IMMUTABLE_ID_PREFER } from "../graph/resources/subscriptions.js";
import { type FakeFolder, FakeMailboxGraph } from "../graph/testing/fake-mailbox.js";
import {
  backfillGraphMailbox,
  catchUpGraphMailbox,
  drainGraphPending,
  type GraphBackfillCursor,
  type GraphCaptureSink,
  type GraphCatchUpState,
  graphCaptureFolders,
} from "./graph-capture.js";
import { messageKey } from "./identity.js";

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
  readonly appended: Array<{ ref: string; key: string | null; received: Date | null }> = [];

  async alreadyCaptured(query: {
    externalRefs?: readonly string[];
    messageIds?: readonly string[];
  }) {
    const refs = new Set(this.appended.map((a) => a.ref));
    const keys = new Set(this.appended.map((a) => a.key).filter((k): k is string => k !== null));
    return {
      externalRefs: new Set((query.externalRefs ?? []).filter((ref) => refs.has(ref))),
      messageKeys: new Set(
        (query.messageIds ?? [])
          .map((id) => messageKey(id))
          .filter((key): key is string => key !== null && keys.has(key)),
      ),
    };
  }

  async append(mail: { original: Buffer; externalRef: string; receivedByService: Date | null }) {
    const id = /^Message-ID: (.*)$/m.exec(mail.original.toString("utf8"))?.[1]?.trim() ?? null;
    this.appended.push({
      ref: mail.externalRef,
      key: messageKey(id),
      received: mail.receivedByService,
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

  it("does not archive a message too large for a MIME export", async () => {
    const fake = mailbox();
    fake.addMessage(USER, { id: "big", folderId: "inbox", tooLarge: true });
    const sink = new MemorySink();
    const result = await drainGraphPending({
      client: fake.client(),
      userId: USER,
      refs: ["big"],
      sink,
    });
    expect(result.oversized).toEqual(["big"]);
    expect(result.handled).toEqual(["big"]);
    expect(sink.appended).toEqual([]);
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
