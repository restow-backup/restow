import { describe, expect, it } from "vitest";
import {
  InMemoryDeltaTokenStore,
  RecordDeltaTokenStore,
  collectDelta,
  isRemoved,
  syncDelta,
} from "./delta.js";
import { GraphError } from "./errors.js";
import { createFakeGraph, graphError } from "./testing/fake-graph.js";
import driveFixture from "./testing/fixtures/drive-delta.json" with { type: "json" };
import mailFixture from "./testing/fixtures/messages-delta.json" with { type: "json" };

const INITIAL = "/users/user-1/mailFolders/AAMkFolderInbox/messages/delta?$select=id";

describe("syncDelta", () => {
  it("enumerates all pages on the first run and stores the delta link", async () => {
    const graph = createFakeGraph([
      {
        url: (u) => u.pathname.endsWith("/messages/delta") && !u.search.includes("skiptoken"),
        respond: { status: 200, json: mailFixture.initialPage1 },
      },
      { url: /\$skiptoken=SKIP1/, respond: { status: 200, json: mailFixture.initialPage2 } },
    ]);
    const store = new InMemoryDeltaTokenStore();
    const { items, summary } = await collectDelta<{ id: string }>({
      client: graph.client(),
      store,
      key: "mail:user-1:inbox",
      initialUrl: INITIAL,
    });

    expect(items.map((i) => i.id)).toEqual(["AAMkMsg1", "AAMkMsg2", "AAMkMsg3"]);
    expect(summary).toEqual({
      mode: "initial",
      deltaLink: mailFixture.initialPage2["@odata.deltaLink"],
      pages: 2,
      items: 3,
    });
    expect(await store.get("mail:user-1:inbox")).toBe(mailFixture.initialPage2["@odata.deltaLink"]);
  });

  it("resumes from the stored token and reports removals", async () => {
    const graph = createFakeGraph([
      { url: /\$deltatoken=DELTA1/, respond: { status: 200, json: mailFixture.incrementalPage } },
    ]);
    const store = new RecordDeltaTokenStore({
      "mail:user-1:inbox": mailFixture.initialPage2["@odata.deltaLink"],
    });
    const { items, summary } = await collectDelta<{ id: string }>({
      client: graph.client(),
      store,
      key: "mail:user-1:inbox",
      initialUrl: INITIAL,
    });

    expect(summary.mode).toBe("incremental");
    expect(items.map((i) => [i.id, isRemoved(i)])).toEqual([
      ["AAMkMsg2", false],
      ["AAMkMsg1", true],
    ]);
    expect(store.record["mail:user-1:inbox"]).toContain("DELTA2");
    expect(graph.calls).toHaveLength(1);
  });

  it("handles 410 Gone on an Outlook stream by dropping the token and enumerating this stream from scratch", async () => {
    const graph = createFakeGraph([
      { url: /\$deltatoken=STALE/, respond: { status: 410, json: mailFixture.goneOutlook } },
      {
        url: (u) => u.pathname.endsWith("/messages/delta") && !u.search.includes("token"),
        respond: { status: 200, json: mailFixture.initialPage1 },
      },
      { url: /\$skiptoken=SKIP1/, respond: { status: 200, json: mailFixture.initialPage2 } },
    ]);
    const store = new RecordDeltaTokenStore({
      "mail:user-1:inbox":
        "https://graph.microsoft.com/v1.0/users/user-1/mailFolders/AAMkFolderInbox/messages/delta?$deltatoken=STALE",
      "mail:user-1:sent": "https://graph.microsoft.com/v1.0/other",
    });
    const resyncs: string[] = [];
    const { items, summary } = await collectDelta<{ id: string }>({
      client: graph.client(),
      store,
      key: "mail:user-1:inbox",
      initialUrl: INITIAL,
      onResync: (info) => resyncs.push(`${info.key}:${info.reason}:${info.nextUrl}`),
    });

    expect(summary.mode).toBe("resync");
    expect(items).toHaveLength(3);
    expect(resyncs).toEqual([`mail:user-1:inbox:gone:${INITIAL}`]);
    // Only the affected stream was reset; the other folder keeps its token.
    expect(store.record["mail:user-1:sent"]).toBe("https://graph.microsoft.com/v1.0/other");
    expect(store.record["mail:user-1:inbox"]).toContain("DELTA1");
  });

  it("follows the Location header of a OneDrive resyncRequired and flags the reset mid-run", async () => {
    const graph = createFakeGraph([
      { url: /token=DELTA1/, respond: { status: 200, json: driveFixture.initialPage1 } },
      {
        url: /token=NEXT1/,
        respond: {
          status: 410,
          headers: {
            Location: "https://graph.microsoft.com/v1.0/drives/b!drive1/root/delta?token=FRESH",
          },
          json: driveFixture.goneDrive,
        },
      },
      { url: /token=FRESH/, respond: { status: 200, json: driveFixture.resyncPage } },
    ]);
    const store = new RecordDeltaTokenStore({
      "drive:b!drive1": "https://graph.microsoft.com/v1.0/drives/b!drive1/root/delta?token=DELTA1",
    });
    const batches: Array<{ mode: string; reset: boolean; ids: string[] }> = [];
    const generator = syncDelta<{ id: string }>({
      client: graph.client(),
      store,
      key: "drive:b!drive1",
      initialUrl: "/drives/b!drive1/root/delta",
    });
    let next = await generator.next();
    while (!next.done) {
      batches.push({
        mode: next.value.mode,
        reset: next.value.reset,
        ids: next.value.items.map((i) => i.id),
      });
      next = await generator.next();
    }

    expect(batches).toEqual([
      { mode: "incremental", reset: false, ids: ["01ROOT", "01DOCS", "01REPORT"] },
      { mode: "resync", reset: true, ids: ["01ROOT", "01REPORT"] },
    ]);
    expect(next.value.mode).toBe("resync");
    expect(store.record["drive:b!drive1"]).toContain("DELTA3");

    // collectDelta discards what came before the reset.
    const graph2 = createFakeGraph([
      { url: /token=DELTA1/, respond: { status: 200, json: driveFixture.initialPage1 } },
      {
        url: /token=NEXT1/,
        respond: {
          status: 410,
          headers: { Location: "https://x/root/delta?token=FRESH" },
          json: driveFixture.goneDrive,
        },
      },
      { url: /token=FRESH/, respond: { status: 200, json: driveFixture.resyncPage } },
    ]);
    const store2 = new RecordDeltaTokenStore({ k: "https://x/root/delta?token=DELTA1" });
    const { items } = await collectDelta<{ id: string }>({
      client: graph2.client(),
      store: store2,
      key: "k",
      initialUrl: "/drives/b!drive1/root/delta",
    });
    expect(items.map((i) => i.id)).toEqual(["01ROOT", "01REPORT"]);
  });

  it("does not loop when the full enumeration itself answers 410", async () => {
    const graph = createFakeGraph([
      { url: /delta/, respond: { status: 410, json: graphError("SyncStateNotFound") } },
    ]);
    const store = new RecordDeltaTokenStore({
      k: "https://graph.microsoft.com/v1.0/x/delta?$deltatoken=STALE",
    });
    await expect(
      collectDelta({ client: graph.client(), store, key: "k", initialUrl: "/x/delta" }),
    ).rejects.toBeInstanceOf(GraphError);
    expect(graph.calls).toHaveLength(2);
    expect(store.record.k).toBeUndefined();
  });

  it("propagates other errors untouched", async () => {
    const graph = createFakeGraph([
      { url: /delta/, respond: { status: 403, json: graphError("ErrorAccessDenied") } },
    ]);
    await expect(
      collectDelta({
        client: graph.client(),
        store: new InMemoryDeltaTokenStore(),
        key: "k",
        initialUrl: "/x/delta",
      }),
    ).rejects.toMatchObject({ status: 403, code: "ErrorAccessDenied" });
  });
});
