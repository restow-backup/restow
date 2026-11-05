import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobAbortedError } from "../../engine/chunkstore.js";
import type { ProgressUpdate } from "../../engine/progress.js";
import type { FirstBackupProgress, JobContext } from "../../engine/types.js";
import { classifyFailure } from "../../failures/classify.js";
import type { DriveDeltaItem } from "../../graph/resources/drive.js";
import {
  type FixtureRoute,
  graphError,
  must,
  selectedEntity,
} from "../../graph/testing/fake-graph.js";
import driveFixture from "../../graph/testing/fixtures/drive-delta.json" with { type: "json" };
import { OneDriveUnavailableError, resolveOneDriveId } from "./engine.js";
import fixture from "./fixtures/drive-backup.json" with { type: "json" };
import { ONEDRIVE_OBJECT_TYPES } from "./items.js";
import { ONEDRIVE_PHASES } from "./run.js";
import { type OneDriveCursor, type OneDriveManifestState, readCursor } from "./state.js";
import {
  bytesResponse,
  contentRoutes,
  createFakeGraph,
  DELTA_PATH,
  DRIVE,
  deltaUrl,
  downloadUrl,
  failingPackStorage,
  Harness,
  interruptedFetch,
  objectAt,
  oneDrive,
  paths,
  pseudoRandom,
  streamingFetch,
} from "./testing.js";

const Q3_PATH = "Documents/Reports/Q3 report.xlsx";
const Q3_ARCHIVED = "Documents/Archive/Q3 report.xlsx";
const DOWNLOAD_HOST = "https://contoso-my.sharepoint.example/download.aspx";

const CONTENT = {
  q3: "q3 content!",
  notes: "hello notes",
  plan: "plan v1 text",
};

/** Routes for the first, complete enumeration plus its downloads. */
function initialRoutes(): FixtureRoute[] {
  return [
    { url: deltaUrl(null), respond: { status: 200, json: fixture.initialPage1 } },
    { url: deltaUrl("NEXT1"), respond: { status: 200, json: fixture.initialPage2 } },
    ...contentRoutes(CONTENT),
  ];
}

function page(items: unknown[], deltaToken: string, nextToken?: string) {
  const link = `https://graph.microsoft.com/v1.0${DELTA_PATH.slice(5)}?token=`;
  return {
    "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#Collection(driveItem)",
    ...(nextToken ? { "@odata.nextLink": `${link}${nextToken}` } : {}),
    ...(nextToken ? {} : { "@odata.deltaLink": `${link}${deltaToken}` }),
    value: items,
  };
}

function q3Item(overrides: Partial<DriveDeltaItem> = {}): DriveDeltaItem {
  return { ...(fixture.initialPage1.value[3] as DriveDeltaItem), ...overrides };
}

function notesItem(overrides: Partial<DriveDeltaItem> = {}): DriveDeltaItem {
  return { ...(fixture.initialPage2.value[0] as DriveDeltaItem), ...overrides };
}

/** An item route that answers like Graph: only what the request's $select names. */
function itemAnswer(id: string, item: DriveDeltaItem): FixtureRoute {
  return {
    url: itemRoute(id),
    respond: (call) => ({ status: 200, json: selectedEntity(call, item) }),
  };
}

/**
 * A delta page as OneDrive for Business answers it: an item whose only change
 * is its sharing is listed (flagged `@microsoft.graph.sharedChanged`) only when
 * the request asks for it with `Prefer: deltashowsharingchanges`.
 */
function sharingDelta(changed: DriveDeltaItem[], deltaToken: string): FixtureRoute["respond"] {
  return (call) => {
    const prefer = call.headers.prefer ?? "";
    const asked = prefer.split(",").some((value) => value.trim() === "deltashowsharingchanges");
    return { status: 200, json: page(asked ? changed : [], deltaToken) };
  };
}

function downloadLink(item: string): string {
  return `${DOWNLOAD_HOST}?item=${item}&tempauth=OK`;
}

function itemRoute(id: string): (url: URL) => boolean {
  return (url) => url.pathname.endsWith(`/items/${id}`);
}

function state(manifest: { state?: Record<string, unknown> }): OneDriveManifestState {
  return manifest.state as unknown as OneDriveManifestState;
}

/** What the engine said about a first backup through this context's reporter. */
function firstBackupsOf(ctx: JobContext): FirstBackupProgress[] {
  const seen: FirstBackupProgress[] = [];
  ctx.progress.firstBackup = (info) => seen.push(info);
  return seen;
}

describe("OneDriveBackupEngine", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await Harness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("enumerates the drive on the first run, streams files and records folders and metadata", async () => {
    const graph = createFakeGraph(initialRoutes());
    const ctx = harness.context();
    const result = await harness.engine(graph).run(ctx, oneDrive, {});

    expect(result).toMatchObject({
      snapshotId: "snap-1",
      sequence: 1,
      objectsWritten: 6,
      objectsTotal: 6,
      failures: [],
    });
    expect(result.bytes).toBe(CONTENT.q3.length + CONTENT.notes.length);
    // A first backup has nothing to compare with: no activity report for the ransomware signals.
    expect(result.activity).toBeUndefined();

    const manifest = await harness.manifest(result);
    expect(paths(manifest)).toEqual([
      "Documents",
      "Documents/Reports",
      Q3_PATH,
      "Notebook",
      "Team files",
      "notes.txt",
    ]);
    expect(objectAt(manifest, "Documents").type).toBe(ONEDRIVE_OBJECT_TYPES.folder);
    expect(objectAt(manifest, "Documents").metadata).toMatchObject({ sharedScope: "users" });
    expect(objectAt(manifest, "Notebook")).toMatchObject({
      type: ONEDRIVE_OBJECT_TYPES.folder,
      chunks: [],
      metadata: { packageType: "oneNote" },
    });
    expect(objectAt(manifest, "Team files").type).toBe(ONEDRIVE_OBJECT_TYPES.shortcut);
    const q3 = objectAt(manifest, Q3_PATH);
    expect(q3).toMatchObject({
      id: "01Q3",
      type: ONEDRIVE_OBJECT_TYPES.file,
      size: 11,
      mtime: Date.parse("2026-08-30T15:30:00Z"),
    });
    expect(q3.metadata).toMatchObject({ cTag: '"c:{Q3},1"', createdBy: "Alice Example" });
    expect((await harness.readObject(q3)).toString()).toBe(CONTENT.q3);
    expect((await harness.readObject(objectAt(manifest, "notes.txt"))).toString()).toBe(
      CONTENT.notes,
    );

    expect(state(manifest)).toMatchObject({
      engine: "onedrive",
      driveId: DRIVE,
      rootId: "01ROOT",
      deltaLink: fixture.initialPage2["@odata.deltaLink"],
      mode: "initial",
      retry: [],
      fullResyncRequired: false,
      versions: false,
    });

    // Downloads use the pre-authenticated URL, never the bearer token.
    for (const call of graph.calls.filter((c) => c.url.includes("download.aspx"))) {
      expect(call.headers.authorization).toBeUndefined();
    }
    expect(harness.cursor.cursor).toBeNull();
    expect(harness.progress.last?.snapshot).toMatchObject({
      total: 6,
      done: 6,
      failed: 0,
      bytes: 22,
      phase: ONEDRIVE_PHASES.commit,
    });
    const phases = [...new Set(harness.progress.updates.map((u) => u.snapshot.phase))];
    expect(phases).toEqual([ONEDRIVE_PHASES.enumerate, ONEDRIVE_PHASES.commit]);
  });

  it("applies deletions, moves and additions incrementally without re-downloading unchanged files", async () => {
    const graph = createFakeGraph([
      ...initialRoutes(),
      { url: deltaUrl("DELTA1"), respond: { status: 200, json: fixture.incrementalPage } },
    ]);
    const engine = harness.engine(graph);
    const first = await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
    const secondCtx = harness.context({ jobId: "job-2" });
    const announced = firstBackupsOf(secondCtx);
    const second = await engine.run(secondCtx, oneDrive, {});
    // A follow-up run is no first backup.
    expect(announced).toEqual([]);

    expect(second).toMatchObject({ snapshotId: "snap-2", sequence: 2, objectsTotal: 6 });
    // The renamed folder, the moved file and the new file changed; nothing else.
    expect(second.objectsWritten).toBe(3);
    // For the ransomware signals: one file new, one gone, a move is no extension rename, and
    // the new .docx (a compressed format) was not measured.
    expect(second.activity).toMatchObject({
      v: 1,
      added: 1,
      modified: 0,
      removed: 1,
      renamed: 0,
      extensions: [{ value: "docx", count: 1 }],
      names: [],
      entropy: [],
    });
    expect(second.bytes).toBe(CONTENT.plan.length);

    const manifest = await harness.manifest(second);
    expect(paths(manifest)).toEqual([
      "Documents",
      "Documents/Archive",
      Q3_ARCHIVED,
      "Documents/plan.docx",
      "Notebook",
      "Team files",
    ]);
    const q3 = objectAt(manifest, Q3_ARCHIVED);
    const previousQ3 = objectAt(await harness.manifest(first), Q3_PATH);
    expect(q3.chunks).toEqual(previousQ3.chunks);
    expect(q3.metadata?.eTag).toBe('"{Q3},2"');
    expect(objectAt(manifest, "Documents/Archive").metadata?.eTag).toBe('"{R1},2"');
    // plan.docx carries no parentReference.path: it is placed below its parent by id.
    expect((await harness.readObject(objectAt(manifest, "Documents/plan.docx"))).toString()).toBe(
      CONTENT.plan,
    );
    expect(graph.callsTo("GET", "item=q3")).toHaveLength(1);
    expect(graph.calls.filter((c) => new URL(c.url).pathname.includes("/items/"))).toHaveLength(0);
    expect(state(manifest).deltaLink).toContain("DELTA2");
    expect(state(manifest).mode).toBe("incremental");

    // Chunks of the moved file are now referenced by both snapshots.
    for (const hex of q3.chunks) {
      expect(harness.chunkIndex.chunks.get(hex)?.refcount).toBe(2);
    }
    const phases = harness.progress.updates.map((u) => u.snapshot.phase);
    expect(phases).toContain(ONEDRIVE_PHASES.changes);
  });

  for (const order of ["deletion first", "move first"] as const) {
    it(`keeps a folder moved out of a folder deleted in the same delta (${order})`, async () => {
      const deletedDocs = {
        id: "01DOCS",
        name: "Documents",
        deleted: { state: "deleted" },
        parentReference: { driveId: DRIVE, id: "01ROOT" },
      };
      // Reports leaves Documents for the top level and takes over its name.
      const movedReports = {
        ...fixture.initialPage1.value[2],
        name: "Documents",
        eTag: '"{R1},3"',
        parentReference: { driveId: DRIVE, id: "01ROOT", path: "/drive/root:" },
      };
      const items =
        order === "deletion first" ? [deletedDocs, movedReports] : [movedReports, deletedDocs];
      const graph = createFakeGraph([
        ...initialRoutes(),
        { url: deltaUrl("DELTA1"), respond: { status: 200, json: page(items, "DELTA2") } },
      ]);
      const engine = harness.engine(graph);
      await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
      const result = await engine.run(harness.context({ jobId: "job-2" }), oneDrive, {});

      const manifest = await harness.manifest(result);
      expect(paths(manifest)).toEqual([
        "Documents",
        "Documents/Q3 report.xlsx",
        "Notebook",
        "Team files",
        "notes.txt",
      ]);
      expect(objectAt(manifest, "Documents").id).toBe("01REPORTS");
      expect(
        (await harness.readObject(objectAt(manifest, "Documents/Q3 report.xlsx"))).toString(),
      ).toBe(CONTENT.q3);
      expect(graph.callsTo("GET", "item=q3")).toHaveLength(1);
    });
  }

  it("places items by parent id and asks Graph once for a child that arrives before its parent", async () => {
    const folder = {
      id: "01F",
      name: "Folder",
      folder: { childCount: 2 },
      parentReference: { driveId: DRIVE, id: "01ROOT" },
    };
    const early = {
      id: "01EARLY",
      name: "early.txt",
      size: 5,
      cTag: '"c:{E},1"',
      file: { mimeType: "text/plain" },
      "@microsoft.graph.downloadUrl": downloadLink("early"),
      parentReference: { driveId: DRIVE, id: "01F" },
    };
    const late = {
      ...early,
      id: "01LATE",
      name: "late.txt",
      cTag: '"c:{L},1"',
      "@microsoft.graph.downloadUrl": downloadLink("late"),
    };
    const root = fixture.initialPage1.value[0];
    const graph = createFakeGraph([
      {
        url: deltaUrl(null),
        respond: { status: 200, json: page([root, early, folder, late], "DELTA-F") },
      },
      {
        url: itemRoute("01EARLY"),
        respond: {
          status: 200,
          json: {
            ...early,
            parentReference: { driveId: DRIVE, id: "01F", path: "/drive/root:/Folder" },
          },
        },
      },
      ...contentRoutes({ early: "early", late: "late!" }),
    ]);
    const result = await harness.engine(graph).run(harness.context(), oneDrive, {});
    const manifest = await harness.manifest(result);
    expect(paths(manifest)).toEqual(["Folder", "Folder/early.txt", "Folder/late.txt"]);
    expect(result.failures).toEqual([]);
    // Only the child whose parent was unknown needed the extra lookup.
    expect(graph.calls.filter((c) => new URL(c.url).pathname.includes("/items/"))).toHaveLength(1);
    expect(graph.callsTo("GET", "/items/01EARLY")).toHaveLength(1);
  });

  it("re-enumerates the drive after 410 Gone, reusing content whose tag is unchanged", async () => {
    const graph = createFakeGraph([
      ...initialRoutes(),
      {
        url: deltaUrl("DELTA1"),
        respond: {
          status: 410,
          headers: {
            location: `https://graph.microsoft.com/v1.0${DELTA_PATH.slice(5)}?token=FRESH`,
          },
          json: fixture.gone,
        },
      },
      { url: deltaUrl("FRESH"), respond: { status: 200, json: fixture.resyncPage } },
    ]);
    const engine = harness.engine(graph);
    await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
    const result = await engine.run(harness.context({ jobId: "job-2" }), oneDrive, {});

    const manifest = await harness.manifest(result);
    // Items the resync no longer lists are gone; the rest is exactly what it was.
    expect(paths(manifest)).toEqual(["Documents", "Documents/Reports", Q3_PATH]);
    expect(result.objectsWritten).toBe(0);
    expect(result.bytes).toBe(0);
    expect(graph.callsTo("GET", "item=q3")).toHaveLength(1);
    expect(state(manifest)).toMatchObject({
      mode: "resync",
      deltaLink: expect.stringContaining("DELTA-R"),
    });
    expect(harness.progress.updates.map((u) => u.snapshot.phase)).toContain(ONEDRIVE_PHASES.resync);
  });

  it("discards what earlier pages produced when 410 strikes mid-walk", async () => {
    const graph = createFakeGraph([
      {
        url: deltaUrl(null),
        respond: [
          { status: 200, json: fixture.initialPage1 },
          {
            status: 200,
            json: page(
              [...fixture.resyncPage.value.slice(0, 2), fixture.initialPage2.value[0]],
              "DELTA-R2",
            ),
          },
        ],
      },
      { url: deltaUrl("NEXT1"), respond: { status: 410, json: fixture.gone } },
      ...contentRoutes(CONTENT),
    ]);
    const result = await harness.engine(graph).run(harness.context(), oneDrive, {});
    const manifest = await harness.manifest(result);
    expect(paths(manifest)).toEqual(["Documents", "notes.txt"]);
    expect(state(manifest)).toMatchObject({ mode: "resync" });
    // q3 was downloaded before the reset; its chunks stay in the pack store but are unreferenced.
    expect(graph.callsTo("GET", "item=q3")).toHaveLength(1);
    expect(result.objectsTotal).toBe(2);
  });

  it("streams a large file through the chunker without buffering it", async () => {
    const big = pseudoRandom(5 * 1024 * 1024 + 4321, 11);
    const item: DriveDeltaItem = q3Item({
      id: "01BIG",
      name: "big.bin",
      size: big.length,
      cTag: '"c:{BIG},1"',
      file: { mimeType: "application/octet-stream" },
      "@microsoft.graph.downloadUrl": downloadLink("big"),
      parentReference: { driveId: DRIVE, id: "01ROOT", path: "/drive/root:" },
    });
    const graph = createFakeGraph([
      {
        url: deltaUrl(null),
        respond: { status: 200, json: page([fixture.initialPage1.value[0], item], "DELTA-BIG") },
      },
    ]);
    let requests = 0;
    const client = graph.client({
      fetchImpl: streamingFetch(
        graph.fetch,
        (url) => {
          if (url.searchParams.get("item") !== "big") {
            return null;
          }
          requests += 1;
          return big;
        },
        64 * 1024,
      ),
    });
    const result = await harness.engine(client).run(harness.context(), oneDrive, {});
    expect(requests).toBe(1);
    expect(result.bytes).toBe(big.length);
    const manifest = await harness.manifest(result);
    const object = objectAt(manifest, "big.bin");
    expect(object.size).toBe(big.length);
    expect(object.chunks.length).toBeGreaterThan(1);
    expect(new Set(object.chunks).size).toBe(object.chunks.length);
    expect((await harness.readObject(object)).equals(big)).toBe(true);
    expect(harness.progress.last?.snapshot.bytes).toBe(big.length);
  });

  it("resumes from the checkpoint after cancellation without downloading stored files again", async () => {
    const controller = new AbortController();
    const graph = createFakeGraph([
      { url: deltaUrl(null), respond: { status: 200, json: fixture.initialPage1 } },
      {
        url: deltaUrl("NEXT1"),
        respond: () => {
          // The worker is told to stop while the second page is being fetched.
          controller.abort("shutdown");
          return { status: 200, json: fixture.initialPage2 };
        },
      },
      ...contentRoutes(CONTENT),
    ]);
    const engine = harness.engine(graph, { checkpointEveryItems: 2 });

    const firstCtx = harness.context({ jobId: "job-1", signal: controller.signal });
    const first = firstBackupsOf(firstCtx);
    await expect(engine.run(firstCtx, oneDrive, {})).rejects.toBeInstanceOf(JobAbortedError);
    // A first backup; the drive says its item count only by being enumerated (#47).
    expect(first).toEqual([{ itemsBefore: 0, itemsTotal: null }]);

    const saved = readCursor(harness.cursor.cursor, DRIVE) as OneDriveCursor;
    expect(saved).toMatchObject({
      engine: "onedrive",
      driveId: DRIVE,
      rootId: "01ROOT",
      mode: "initial",
      retriesDone: true,
      retryOverflow: false,
    });
    expect(saved.pageUrl).toContain("token=NEXT1");
    expect(saved.lastItemId).toBeUndefined();
    expect(saved.snapshot?.snapshotId).toBe("snap-1");
    expect(saved.snapshot?.objectCount).toBe(3);
    expect((await harness.snapshots.get("snap-1"))?.manifestPath).toBeNull();

    const secondCtx = harness.context({ jobId: "job-1", attempt: 1 });
    const second = firstBackupsOf(secondCtx);
    const result = await engine.run(secondCtx, oneDrive, {});
    // The resumed attempt counts what the first one stored as done.
    expect(second).toEqual([{ itemsBefore: 3, itemsTotal: null }]);
    expect(result.snapshotId).toBe("snap-1");
    expect(result.objectsTotal).toBe(6);
    // Everything is new relative to the (absent) previous snapshot, across both attempts.
    expect(result.objectsWritten).toBe(6);
    expect(graph.callsTo("GET", "item=q3")).toHaveLength(1);
    expect(graph.callsTo("GET", "item=notes")).toHaveLength(1);
    // The initial page was not fetched again; the walk continued at page two.
    expect(
      graph.calls.filter(
        (c) => new URL(c.url).pathname === DELTA_PATH && !c.url.includes("token="),
      ),
    ).toHaveLength(1);
    const manifest = await harness.manifest(result);
    expect(paths(manifest)).toHaveLength(6);
    expect((await harness.readObject(objectAt(manifest, Q3_PATH))).toString()).toBe(CONTENT.q3);
    expect(harness.cursor.cursor).toBeNull();
  });

  it("skips the items of the checkpointed page that were already stored", async () => {
    const controller = new AbortController();
    const graph = createFakeGraph(initialRoutes());
    const engine = harness.engine(graph, { checkpointEveryItems: 1 });
    // Cancel as soon as notes.txt (first item of page two) has been stored.
    const cancelAfterNotes = (update: ProgressUpdate) => {
      if (update.snapshot.done === 4) {
        controller.abort("cancelled");
      }
    };
    await expect(
      engine.run(
        harness.context({
          jobId: "job-1",
          signal: controller.signal,
          onProgress: cancelAfterNotes,
        }),
        oneDrive,
        {},
      ),
    ).rejects.toBeInstanceOf(JobAbortedError);
    const saved = readCursor(harness.cursor.cursor, DRIVE) as OneDriveCursor;
    expect(saved.pageUrl).toContain("token=NEXT1");
    expect(saved.lastItemId).toBe("01NOTES");
    expect(saved.snapshot?.objectCount).toBe(4);

    const result = await engine.run(harness.context({ jobId: "job-1", attempt: 1 }), oneDrive, {});
    expect(graph.callsTo("GET", "item=notes")).toHaveLength(1);
    expect(result.objectsTotal).toBe(6);
    expect(paths(await harness.manifest(result))).toContain("notes.txt");
  });

  it("cascades a deletion checkpointed before a restart once the run commits", async () => {
    const controller = new AbortController();
    const deletedDocs = {
      id: "01DOCS",
      name: "Documents",
      deleted: { state: "deleted" },
      parentReference: { driveId: DRIVE, id: "01ROOT" },
    };
    const newFile = notesItem({
      id: "01NEW",
      name: "new.txt",
      cTag: '"c:{NEW},1"',
      "@microsoft.graph.downloadUrl": downloadLink("new"),
    });
    const graph = createFakeGraph([
      ...initialRoutes(),
      {
        url: deltaUrl("DELTA1"),
        respond: { status: 200, json: page([deletedDocs], "", "INC2") },
      },
      {
        url: deltaUrl("INC2"),
        respond: () => {
          controller.abort("shutdown");
          return { status: 200, json: page([newFile], "DELTA2") };
        },
      },
      ...contentRoutes({ new: "hello there" }),
    ]);
    const engine = harness.engine(graph, { checkpointEveryItems: 1 });
    await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
    await expect(
      engine.run(harness.context({ jobId: "job-2", signal: controller.signal }), oneDrive, {}),
    ).rejects.toBeInstanceOf(JobAbortedError);

    // Until the commit the checkpoint keeps the deleted folder's children.
    expect(readCursor(harness.cursor.cursor, DRIVE)?.snapshot?.objectCount).toBe(5);

    const result = await engine.run(harness.context({ jobId: "job-2", attempt: 1 }), oneDrive, {});
    expect(paths(await harness.manifest(result))).toEqual([
      "Notebook",
      "Team files",
      "new.txt",
      "notes.txt",
    ]);
  });

  it("reports unreadable items, keeps the last good copy marked stale and retries them next run", async () => {
    const changedQ3 = q3Item({
      eTag: '"{Q3},3"',
      cTag: '"c:{Q3},2"',
      size: 12,
      file: { mimeType: "text/plain", hashes: { quickXorHash: "cZgBCMbwBjfQoQxurAMIZAAAAAA=" } },
      "@microsoft.graph.downloadUrl": downloadLink("q3v2"),
    });
    const newFile = q3Item({
      id: "01NEW",
      name: "new.txt",
      size: 5,
      cTag: '"c:{NEW},1"',
      "@microsoft.graph.downloadUrl": downloadLink("new"),
      parentReference: { driveId: DRIVE, id: "01ROOT", path: "/drive/root:" },
    });
    const graph = createFakeGraph([
      ...initialRoutes(),
      {
        url: deltaUrl("DELTA1"),
        respond: { status: 200, json: page([changedQ3, newFile], "DELTA2") },
      },
      { url: deltaUrl("DELTA2"), respond: { status: 200, json: page([], "DELTA3") } },
      {
        url: downloadUrl("q3v2"),
        respond: [
          {
            status: 500,
            json: graphError("generalException", "General exception while processing"),
          },
          { status: 200, bytes: new TextEncoder().encode("q3 content 2") },
        ],
      },
      {
        url: downloadUrl("new"),
        respond: {
          status: 200,
          bytes: new TextEncoder().encode("12345"),
          headers: { "content-length": "99" },
        },
      },
      { url: itemRoute("01Q3"), respond: { status: 200, json: changedQ3 } },
      { url: itemRoute("01NEW"), respond: { status: 404, json: graphError("itemNotFound") } },
    ]);
    const engine = harness.engine(graph);
    await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
    harness.progress.updates.length = 0;

    const second = await engine.run(harness.context({ jobId: "job-2" }), oneDrive, {});
    expect(second.failures.map((f) => f.itemRef)).toEqual([Q3_PATH, "new.txt"]);
    expect(must(second.failures[0]).reason).toMatch(/Graph 500 generalException/);
    expect(must(second.failures[1]).reason).toMatch(/TruncatedDownloadError/);
    expect(second.failures.some((f) => f.reason.includes("tempauth"))).toBe(false);
    expect(harness.progress.failures.map((f) => f.itemRef)).toEqual([Q3_PATH, "new.txt"]);

    const manifest = await harness.manifest(second);
    const stale = objectAt(manifest, Q3_PATH);
    expect(stale.metadata).toMatchObject({ stale: "true", cTag: '"c:{Q3},1"', eTag: '"{Q3},3"' });
    expect((await harness.readObject(stale)).toString()).toBe(CONTENT.q3);
    expect(paths(manifest)).not.toContain("new.txt");
    expect(state(manifest).retry).toEqual(["01Q3", "01NEW"]);

    // Next run: the retry phase fetches both items again; q3 succeeds, new.txt is gone for good.
    harness.progress.updates.length = 0;
    const third = await engine.run(harness.context({ jobId: "job-3" }), oneDrive, {});
    expect(third.failures).toEqual([]);
    const healed = await harness.manifest(third);
    const q3 = objectAt(healed, Q3_PATH);
    expect(q3.metadata?.stale).toBeUndefined();
    expect(q3.metadata?.cTag).toBe('"c:{Q3},2"');
    expect((await harness.readObject(q3)).toString()).toBe("q3 content 2");
    expect(state(healed).retry).toEqual([]);
    expect(harness.progress.updates.map((u) => u.snapshot.phase)).toContain(ONEDRIVE_PHASES.retry);
    expect(graph.callsTo("GET", "/items/01NEW")).toHaveLength(1);
  });

  it("keeps authorship, sharing and the shortcut facet of items fetched again by the retry", async () => {
    const sharedQ3 = q3Item({
      shared: {
        scope: "organization",
        sharedBy: { user: { displayName: "Alice Example", id: "user-1" } },
        sharedDateTime: "2026-09-10T08:00:00Z",
      },
    });
    const shortcut = fixture.initialPage2.value[2] as DriveDeltaItem;
    const graph = createFakeGraph([
      {
        url: deltaUrl(null),
        respond: {
          status: 200,
          json: {
            ...fixture.initialPage1,
            value: [...fixture.initialPage1.value.slice(0, 3), sharedQ3],
          },
        },
      },
      {
        url: deltaUrl("NEXT1"),
        respond: {
          status: 200,
          // The shortcut arrives without its name: it cannot be placed and is retried.
          json: {
            ...fixture.initialPage2,
            value: [
              fixture.initialPage2.value[0],
              fixture.initialPage2.value[1],
              { ...shortcut, name: undefined },
            ],
          },
        },
      },
      { url: deltaUrl("DELTA1"), respond: { status: 200, json: page([], "DELTA2") } },
      {
        url: downloadUrl("q3"),
        respond: [
          { status: 423, json: graphError("resourceLocked", "The file is checked out") },
          { status: 200, bytes: new TextEncoder().encode(CONTENT.q3) },
        ],
      },
      ...contentRoutes({ notes: CONTENT.notes }),
      itemAnswer("01Q3", sharedQ3),
      itemAnswer("01SHORTCUT", shortcut),
    ]);
    const engine = harness.engine(graph);
    const first = await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
    expect(first.failures.map((f) => f.itemRef)).toEqual([Q3_PATH, "01SHORTCUT"]);
    expect(state(await harness.manifest(first)).retry).toEqual(["01Q3", "01SHORTCUT"]);

    const second = await engine.run(harness.context({ jobId: "job-2" }), oneDrive, {});
    expect(second.failures).toEqual([]);
    const manifest = await harness.manifest(second);
    expect(objectAt(manifest, Q3_PATH).metadata).toMatchObject({
      createdBy: "Alice Example",
      lastModifiedBy: "Bob Example",
      sharedScope: "organization",
      sharedBy: "Alice Example",
      sharedDateTime: "2026-09-10T08:00:00Z",
    });
    expect(objectAt(manifest, "Team files")).toMatchObject({
      type: ONEDRIVE_OBJECT_TYPES.shortcut,
      metadata: { remoteItemId: "01REMOTE", remoteDriveId: "b!teamdrive" },
    });
    expect(state(manifest).retry).toEqual([]);
  });

  it("records a sharing-only change on the next incremental run without downloading again", async () => {
    // A flagged entry need not carry the sharing itself: it is read from the item.
    const flagged = q3Item({ "@microsoft.graph.sharedChanged": "True" });
    const shared = q3Item({
      shared: {
        scope: "anonymous",
        sharedBy: { user: { displayName: "Bob Example", id: "user-2" } },
        sharedDateTime: "2026-09-20T12:00:00Z",
      },
    });
    let current = shared;
    const graph = createFakeGraph([
      ...initialRoutes(),
      { url: deltaUrl("DELTA1"), respond: sharingDelta([flagged], "DELTA2") },
      { url: deltaUrl("DELTA2"), respond: sharingDelta([flagged], "DELTA3") },
      {
        url: itemRoute("01Q3"),
        respond: (call) => ({ status: 200, json: selectedEntity(call, current) }),
      },
    ]);
    const engine = harness.engine(graph);
    const first = await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
    const before = objectAt(await harness.manifest(first), Q3_PATH);
    expect(before.metadata?.sharedScope).toBeUndefined();
    const downloads = () => graph.callsTo("GET", "item=q3").length;
    expect(downloads()).toBe(1);

    const second = await engine.run(harness.context({ jobId: "job-2" }), oneDrive, {});
    expect(second.failures).toEqual([]);
    const after = objectAt(await harness.manifest(second), Q3_PATH);
    expect(after.metadata).toMatchObject({
      sharedScope: "anonymous",
      sharedBy: "Bob Example",
      sharedDateTime: "2026-09-20T12:00:00Z",
    });
    expect(after.chunks).toEqual(before.chunks);
    expect(downloads()).toBe(1);
    for (const call of graph.callsTo("GET", "/root/delta")) {
      expect(call.headers.prefer).toBe("deltashowsharingchanges");
    }

    // The link is removed again: the item comes without `shared`, and the sharing goes.
    current = q3Item();
    const third = await engine.run(harness.context({ jobId: "job-3" }), oneDrive, {});
    const unshared = objectAt(await harness.manifest(third), Q3_PATH);
    expect(unshared.metadata?.sharedScope).toBeUndefined();
    expect(unshared.metadata?.sharedBy).toBeUndefined();
    expect(downloads()).toBe(1);
  });

  it("records the sharing a new file inherits from its shared folder", async () => {
    // As OneDrive for Business answers: with `hierarchicalsharing` the inherited sharing is left
    // out of every item below the folder where it is set.
    const inherited = {
      scope: "organization",
      sharedBy: { user: { displayName: "Alice Example", id: "user-1" } },
      sharedDateTime: "2026-09-10T08:00:00Z",
    };
    const newFile = q3Item({
      id: "01NEW",
      name: "new.txt",
      cTag: '"c:{NEW},1"',
      size: 5,
      file: { mimeType: "text/plain" },
      "@microsoft.graph.downloadUrl": downloadLink("new"),
      parentReference: { driveId: DRIVE, id: "01REPORTS" },
    });
    const graph = createFakeGraph([
      ...initialRoutes(),
      {
        url: deltaUrl("DELTA1"),
        respond: (call) => {
          const hierarchical = (call.headers.prefer ?? "").includes("hierarchicalsharing");
          return {
            status: 200,
            json: page([hierarchical ? newFile : { ...newFile, shared: inherited }], "DELTA2"),
          };
        },
      },
      {
        url: downloadUrl("new"),
        respond: { status: 200, bytes: new TextEncoder().encode("new!!") },
      },
    ]);
    const engine = harness.engine(graph);
    await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
    const second = await engine.run(harness.context({ jobId: "job-2" }), oneDrive, {});
    expect(second.failures).toEqual([]);
    expect(
      objectAt(await harness.manifest(second), "Documents/Reports/new.txt").metadata,
    ).toMatchObject({ sharedScope: "organization", sharedBy: "Alice Example" });
  });

  it("reports a sharing change it could not read and keeps the file", async () => {
    const flagged = q3Item({ "@microsoft.graph.sharedChanged": "True" });
    const graph = createFakeGraph([
      ...initialRoutes(),
      { url: deltaUrl("DELTA1"), respond: sharingDelta([flagged], "DELTA2") },
      {
        url: itemRoute("01Q3"),
        respond: { status: 403, json: graphError("accessDenied", "Access denied") },
      },
    ]);
    const engine = harness.engine(graph);
    const first = await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
    const second = await engine.run(harness.context({ jobId: "job-2" }), oneDrive, {});
    expect(second.failures.map((f) => f.itemRef)).toEqual([Q3_PATH]);
    expect(must(second.failures[0]).reason).toMatch(/^reading the sharing: Graph 403/);
    const manifest = await harness.manifest(second);
    expect(objectAt(manifest, Q3_PATH).chunks).toEqual(
      objectAt(await harness.manifest(first), Q3_PATH).chunks,
    );
    expect(state(manifest).retry).toEqual(["01Q3"]);
  });

  it("asks Graph once more for an entry without a facet and never skips it in silence", async () => {
    const at = { driveId: DRIVE, id: "01ROOT", path: "/drive/root:" };
    // A partial entry: Graph names the item but not what it is.
    const bare = { id: "01BARE", name: "bare.txt", parentReference: at };
    const bareFile = q3Item({
      ...bare,
      size: 4,
      cTag: '"c:{BARE},1"',
      file: { mimeType: "text/plain" },
      "@microsoft.graph.downloadUrl": downloadLink("bare"),
    });
    // A kind the classifier does not know (a personal OneDrive album, the bundle facet).
    const album = {
      id: "01ALBUM",
      name: "Holiday",
      parentReference: at,
      bundle: { childCount: 2 },
    };
    const graph = createFakeGraph([
      { url: deltaUrl(null), respond: { status: 200, json: fixture.initialPage1 } },
      {
        url: deltaUrl("NEXT1"),
        respond: {
          status: 200,
          json: { ...fixture.initialPage2, value: [...fixture.initialPage2.value, bare, album] },
        },
      },
      { url: deltaUrl("DELTA1"), respond: { status: 200, json: page([], "DELTA2") } },
      ...contentRoutes({ ...CONTENT, bare: "bare" }),
      itemAnswer("01BARE", bareFile),
      itemAnswer("01ALBUM", album as DriveDeltaItem),
    ]);
    const engine = harness.engine(graph);
    const first = await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
    const manifest = await harness.manifest(first);
    expect((await harness.readObject(objectAt(manifest, "bare.txt"))).toString()).toBe("bare");
    expect(paths(manifest)).not.toContain("Holiday");
    expect(first.failures).toHaveLength(1);
    expect(must(first.failures[0])).toMatchObject({
      itemRef: "Holiday",
      cause: { code: "graph.item_incomplete" },
    });
    expect(state(manifest).retry).toEqual(["01ALBUM"]);

    // The next run asks again (once) and still reports it.
    const second = await engine.run(harness.context({ jobId: "job-2" }), oneDrive, {});
    expect(second.failures.map((f) => f.cause?.code)).toEqual(["graph.item_incomplete"]);
    expect(graph.callsTo("GET", "/items/01ALBUM")).toHaveLength(2);
    expect(state(await harness.manifest(second)).retry).toEqual(["01ALBUM"]);
  });

  describe("proves the downloaded bytes against the hash Graph reported", () => {
    const QXH_V2 = "cZgBCMbwBjfQoQxurAMIZAAAAAA="; // "q3 content 2"
    const QXH_V3 = "cZgBCMbwBjfQoQxurAMIZgAAAAA="; // "q3 content 3"
    const v2 = q3Item({
      eTag: '"{Q3},2"',
      cTag: '"c:{Q3},2"',
      size: 12,
      file: { mimeType: "text/plain", hashes: { quickXorHash: QXH_V2 } },
      "@microsoft.graph.downloadUrl": downloadLink("q3v2"),
    });

    function routes(served: string, current: DriveDeltaItem): FixtureRoute[] {
      return [
        ...initialRoutes(),
        { url: deltaUrl("DELTA1"), respond: { status: 200, json: page([v2], "DELTA2") } },
        ...contentRoutes({ q3v2: served }),
        itemAnswer("01Q3", current),
      ];
    }

    it("keeps the last good copy and retries when bytes of the right length are not the file's", async () => {
      // Same length, other bytes: a Content-Length check alone passes them.
      const graph = createFakeGraph(routes("Q3 CONTENT 2", v2));
      const engine = harness.engine(graph);
      await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
      const second = await engine.run(harness.context({ jobId: "job-2" }), oneDrive, {});
      expect(second.failures.map((f) => f.itemRef)).toEqual([Q3_PATH]);
      expect(must(second.failures[0]).reason).toMatch(
        new RegExp(
          `ContentMismatchError: .*QuickXorHash .*reported ${QXH_V2.replace(/[+/=]/g, ".")}`,
        ),
      );
      const manifest = await harness.manifest(second);
      const stale = objectAt(manifest, Q3_PATH);
      expect(stale.metadata).toMatchObject({ stale: "true", cTag: '"c:{Q3},1"' });
      expect((await harness.readObject(stale)).toString()).toBe(CONTENT.q3);
      expect(state(manifest).retry).toEqual(["01Q3"]);
      // Graph was asked once whether the file had changed in between.
      expect(graph.callsTo("GET", "/items/01Q3")).toHaveLength(1);
    });

    it("stores a revision that arrived after the delta page under that revision's tag and hash", async () => {
      const v3 = q3Item({
        eTag: '"{Q3},3"',
        cTag: '"c:{Q3},3"',
        size: 12,
        file: { mimeType: "text/plain", hashes: { quickXorHash: QXH_V3 } },
        "@microsoft.graph.downloadUrl": downloadLink("q3v3"),
      });
      const graph = createFakeGraph(routes("q3 content 3", v3));
      const engine = harness.engine(graph);
      await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
      const second = await engine.run(harness.context({ jobId: "job-2" }), oneDrive, {});
      expect(second.failures).toEqual([]);
      const q3 = objectAt(await harness.manifest(second), Q3_PATH);
      expect(q3.metadata).toMatchObject({ cTag: '"c:{Q3},3"', quickXorHash: QXH_V3 });
      expect(q3.metadata?.stale).toBeUndefined();
      expect((await harness.readObject(q3)).toString()).toBe("q3 content 3");
    });

    it("measures a download without Content-Length against the size Graph reported", async () => {
      const graph = createFakeGraph([
        { url: deltaUrl(null), respond: { status: 200, json: fixture.initialPage1 } },
        { url: deltaUrl("NEXT1"), respond: { status: 200, json: fixture.initialPage2 } },
        {
          url: downloadUrl("q3"),
          // An encoded body: Content-Length (if any) says nothing about the bytes fetch hands over.
          respond: bytesResponse("q3 cont", { "content-encoding": "gzip" }),
        },
        ...contentRoutes({ notes: CONTENT.notes }),
      ]);
      const result = await harness.engine(graph).run(harness.context(), oneDrive, {});
      expect(result.failures.map((f) => f.itemRef)).toEqual([Q3_PATH]);
      expect(must(result.failures[0]).reason).toMatch(/TruncatedDownloadError: .*7 of 11/);
      expect(paths(await harness.manifest(result))).not.toContain(Q3_PATH);
    });
  });

  it("takes back a failure when a later delta entry says the item was deleted", async () => {
    const graph = createFakeGraph([
      { url: deltaUrl(null), respond: { status: 200, json: fixture.initialPage1 } },
      { url: deltaUrl("NEXT1"), respond: { status: 200, json: fixture.initialPage2 } },
      ...contentRoutes({ notes: CONTENT.notes }),
      {
        url: downloadUrl("q3"),
        respond: { status: 423, json: graphError("resourceLocked", "The file is checked out") },
      },
      {
        // The retry pass cannot read it (a passing fault) ...
        url: itemRoute("01Q3"),
        respond: { status: 500, json: graphError("generalException", "General exception") },
      },
      {
        // ... and the walk then says it was deleted.
        url: deltaUrl("DELTA1"),
        respond: {
          status: 200,
          json: page(
            [{ id: "01Q3", deleted: { state: "deleted" }, parentReference: { driveId: DRIVE } }],
            "DELTA2",
          ),
        },
      },
    ]);
    const engine = harness.engine(graph);
    const first = await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
    expect(state(await harness.manifest(first)).retry).toEqual(["01Q3"]);
    harness.progress.updates.length = 0;

    const second = await engine.run(harness.context({ jobId: "job-2" }), oneDrive, {});
    expect(second.failures).toEqual([]);
    const withdrawn = harness.progress.updates.flatMap((update) => update.withdrawn ?? []);
    // Never stored, so the retry knew it by its id only.
    expect(withdrawn.map((failure) => failure.itemRef)).toEqual(["01Q3"]);
    const manifest = await harness.manifest(second);
    expect(paths(manifest)).not.toContain(Q3_PATH);
    expect(state(manifest).retry).toEqual([]);
  });

  it("takes back the failures of items below a folder deleted later in the same run", async () => {
    const changedQ3 = q3Item({
      cTag: '"c:{Q3},2"',
      size: 12,
      file: { mimeType: "text/plain", hashes: { quickXorHash: "cZgBCMbwBjfQoQxurAMIZAAAAAA=" } },
      "@microsoft.graph.downloadUrl": downloadLink("q3v2"),
    });
    const newFile = q3Item({
      id: "01NEW",
      name: "new.txt",
      cTag: '"c:{NEW},1"',
      size: 5,
      file: { mimeType: "text/plain" },
      "@microsoft.graph.downloadUrl": downloadLink("new"),
      parentReference: { driveId: DRIVE, id: "01REPORTS" },
    });
    const graph = createFakeGraph([
      ...initialRoutes(),
      {
        url: deltaUrl("DELTA1"),
        respond: {
          status: 200,
          json: page(
            [
              changedQ3,
              newFile,
              // Graph names only the folder; what was below it goes with it.
              { id: "01DOCS", deleted: { state: "deleted" }, parentReference: { driveId: DRIVE } },
            ],
            "DELTA2",
          ),
        },
      },
      ...["q3v2", "new"].map((item) => ({
        url: downloadUrl(item),
        respond: { status: 500, json: graphError("generalException", "General exception") },
      })),
    ]);
    const engine = harness.engine(graph);
    await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
    const second = await engine.run(harness.context({ jobId: "job-2" }), oneDrive, {});
    expect(second.failures).toEqual([]);
    const manifest = await harness.manifest(second);
    expect(paths(manifest)).toEqual(["Notebook", "Team files", "notes.txt"]);
    expect(state(manifest).retry).toEqual([]);
  });

  it("keeps the failure of a file whose folder was moved out of a folder deleted in the same run", async () => {
    // Reports moves from Documents to the top level, then Documents is deleted, and a new file
    // in Reports cannot be read: it is not below anything deleted.
    const reportsMoved = {
      ...(fixture.initialPage1.value[2] as DriveDeltaItem),
      parentReference: { driveId: DRIVE, id: "01ROOT" },
    };
    const newFile = q3Item({
      id: "01NEW",
      name: "new.txt",
      cTag: '"c:{NEW},1"',
      size: 5,
      file: { mimeType: "text/plain" },
      "@microsoft.graph.downloadUrl": downloadLink("new"),
      parentReference: { driveId: DRIVE, id: "01REPORTS" },
    });
    const graph = createFakeGraph([
      ...initialRoutes(),
      {
        url: deltaUrl("DELTA1"),
        respond: {
          status: 200,
          json: page(
            [
              reportsMoved,
              newFile,
              { id: "01DOCS", deleted: { state: "deleted" }, parentReference: { driveId: DRIVE } },
            ],
            "DELTA2",
          ),
        },
      },
      {
        url: downloadUrl("new"),
        respond: { status: 500, json: graphError("generalException", "General exception") },
      },
    ]);
    const engine = harness.engine(graph);
    await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
    const second = await engine.run(harness.context({ jobId: "job-2" }), oneDrive, {});
    expect(second.failures.map((failure) => failure.itemRef)).toEqual(["Reports/new.txt"]);
    const manifest = await harness.manifest(second);
    expect(paths(manifest)).toContain("Reports/Q3 report.xlsx");
    expect(state(manifest).retry).toEqual(["01NEW"]);
  });

  it("reports a download that breaks off mid-stream as an item failure and carries on", async () => {
    const graph = createFakeGraph(initialRoutes());
    const client = graph.client({
      fetchImpl: interruptedFetch(
        graph.fetch,
        (url) => url.searchParams.get("item") === "q3",
        Buffer.from("q3 c"),
        CONTENT.q3.length,
      ),
    });
    const result = await harness.engine(client).run(harness.context(), oneDrive, {});
    expect(result.failures).toHaveLength(1);
    expect(must(result.failures[0])).toMatchObject({ itemRef: Q3_PATH });
    expect(must(result.failures[0]).reason).toMatch(/DownloadInterruptedError.*socket hang up/);
    const manifest = await harness.manifest(result);
    expect(paths(manifest)).not.toContain(Q3_PATH);
    expect((await harness.readObject(objectAt(manifest, "notes.txt"))).toString()).toBe(
      CONTENT.notes,
    );
    expect(state(manifest).retry).toEqual(["01Q3"]);
  });

  it("takes back the failure of an item that a later delta entry of the same run delivers", async () => {
    const graph = createFakeGraph([
      { url: deltaUrl(null), respond: { status: 200, json: fixture.initialPage1 } },
      {
        url: deltaUrl("NEXT1"),
        // Graph may list the same item again further down the feed.
        respond: {
          status: 200,
          json: { ...fixture.initialPage2, value: [...fixture.initialPage2.value, q3Item()] },
        },
      },
      {
        url: downloadUrl("q3"),
        respond: [
          { status: 423, json: graphError("resourceLocked", "The resource is locked") },
          { status: 200, bytes: new TextEncoder().encode(CONTENT.q3) },
        ],
      },
      ...contentRoutes({ notes: CONTENT.notes, plan: CONTENT.plan }),
    ]);
    const result = await harness.engine(graph).run(harness.context(), oneDrive, {});
    expect(result.failures).toEqual([]);
    // The failure went out live; the sink is told to take it back.
    const withdrawn = harness.progress.updates.flatMap((update) => update.withdrawn ?? []);
    expect(withdrawn).toEqual(harness.progress.failures);
    expect(withdrawn.map((failure) => failure.itemRef)).toEqual([Q3_PATH]);
    expect(harness.progress.last?.snapshot.failed).toBe(0);
    const manifest = await harness.manifest(result);
    expect(state(manifest).retry).toEqual([]);
    const q3 = objectAt(manifest, Q3_PATH);
    expect(q3.metadata?.stale).toBeUndefined();
    expect((await harness.readObject(q3)).toString()).toBe(CONTENT.q3);
  });

  it("ends the run on a cancellation during a download without blaming the file", async () => {
    const controller = new AbortController();
    const graph = createFakeGraph([
      { url: deltaUrl(null), respond: { status: 200, json: fixture.initialPage1 } },
      { url: deltaUrl("NEXT1"), respond: { status: 200, json: fixture.initialPage2 } },
      {
        url: downloadUrl("q3"),
        respond: () => {
          // The job is cancelled while the download is being opened; the request fails with it.
          controller.abort("cancelled");
          return { status: 500, json: graphError("generalException", "aborted") };
        },
      },
      ...contentRoutes({ notes: CONTENT.notes, plan: CONTENT.plan }),
    ]);
    const ctx = harness.context({ signal: controller.signal });
    await expect(harness.engine(graph).run(ctx, oneDrive, {})).rejects.toBeInstanceOf(
      JobAbortedError,
    );
    await ctx.progress.flush();
    expect(harness.progress.failures).toEqual([]);
    const saved = readCursor(harness.cursor.cursor, DRIVE) as OneDriveCursor;
    expect(saved.retry).toEqual([]);
  });

  it("drops an item deleted between the delta and its download without reporting a failure", async () => {
    const graph = createFakeGraph([
      { url: deltaUrl(null), respond: { status: 200, json: fixture.initialPage1 } },
      { url: deltaUrl("NEXT1"), respond: { status: 200, json: fixture.initialPage2 } },
      { url: downloadUrl("q3"), respond: { status: 404, json: graphError("itemNotFound") } },
      { url: itemRoute("01Q3"), respond: { status: 404, json: graphError("itemNotFound") } },
      ...contentRoutes({ notes: CONTENT.notes }),
    ]);
    const result = await harness.engine(graph).run(harness.context(), oneDrive, {});
    expect(result.failures).toEqual([]);
    const manifest = await harness.manifest(result);
    expect(paths(manifest)).not.toContain(Q3_PATH);
    expect(paths(manifest)).toContain("Documents/Reports");
    expect(state(manifest).retry).toEqual([]);
  });

  it("fails the job, not the items, when the storage cannot take the data", async () => {
    const graph = createFakeGraph(initialRoutes());
    // One-byte packs force a pack write while the second file is being stored.
    const engine = harness.engine(graph, { maxPackBytes: 1 });
    await expect(
      engine.run(
        harness.context({ storage: failingPackStorage(harness.storage, "disk full") }),
        oneDrive,
        {},
      ),
    ).rejects.toThrow(/disk full/);
    expect(harness.progress.failures).toEqual([]);
    // The pending pack is lost, so no checkpoint may point at it.
    expect(harness.cursor.cursor).toBeNull();
  });

  it("enumerates the whole drive next time when more items failed than the retry list holds", async () => {
    const changedQ3 = q3Item({
      cTag: '"c:{Q3},2"',
      "@microsoft.graph.downloadUrl": downloadLink("q3v2"),
    });
    const changedNotes = notesItem({
      cTag: '"c:{N1},2"',
      "@microsoft.graph.downloadUrl": downloadLink("notesv2"),
    });
    const graph = createFakeGraph([
      ...initialRoutes(),
      {
        url: deltaUrl("DELTA1"),
        respond: { status: 200, json: page([changedQ3, changedNotes], "DELTA2") },
      },
      { url: downloadUrl("q3v2"), respond: { status: 500, json: graphError("generalException") } },
      {
        url: downloadUrl("notesv2"),
        respond: { status: 500, json: graphError("generalException") },
      },
    ]);
    const engine = harness.engine(graph, { maxRetryIds: 1 });
    await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
    const second = await engine.run(harness.context({ jobId: "job-2" }), oneDrive, {});
    expect(second.failures).toHaveLength(2);
    expect(state(await harness.manifest(second))).toMatchObject({
      retry: ["01Q3"],
      fullResyncRequired: true,
    });

    const third = await engine.run(harness.context({ jobId: "job-3" }), oneDrive, {});
    expect(graph.calls.filter((c) => c.url.includes("token=DELTA2"))).toHaveLength(0);
    const initialWalks = graph.calls.filter(
      (c) => new URL(c.url).pathname === DELTA_PATH && !c.url.includes("token="),
    );
    expect(initialWalks).toHaveLength(2);
    expect(third.failures).toEqual([]);
    expect(state(await harness.manifest(third))).toMatchObject({
      mode: "initial",
      retry: [],
      fullResyncRequired: false,
    });
  });

  it("stores historical versions when enabled and carries them through renames", async () => {
    const graph = createFakeGraph([
      ...initialRoutes(),
      {
        url: (u) => u.pathname.endsWith("/items/01Q3/versions"),
        respond: { status: 200, json: fixture.versions },
      },
      {
        url: (u) => u.pathname.endsWith("/items/01Q3/versions/2.0/content"),
        respond: { status: 200, bytes: new TextEncoder().encode("q3 content v2!") },
      },
      {
        url: (u) => u.pathname.endsWith("/items/01Q3/versions/1.0/content"),
        respond: { status: 200, bytes: new TextEncoder().encode("q3 v1 c!") },
      },
      {
        url: (u) => u.pathname.endsWith("/items/01NOTES/versions"),
        respond: { status: 200, json: { value: [{ id: "1.0", size: 11 }] } },
      },
      { url: deltaUrl("DELTA1"), respond: { status: 200, json: fixture.incrementalPage } },
    ]);
    const engine = harness.engine(graph, { includeVersions: true });
    const first = await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
    const manifest = await harness.manifest(first);
    expect(paths(manifest)).toContain(`${Q3_PATH}:versions/2.0`);
    expect(paths(manifest)).toContain(`${Q3_PATH}:versions/1.0`);
    expect(paths(manifest).filter((p) => p.includes(":versions/"))).toHaveLength(2);
    const v2 = objectAt(manifest, `${Q3_PATH}:versions/2.0`);
    expect(v2).toMatchObject({ type: ONEDRIVE_OBJECT_TYPES.version, id: "01Q3#2.0", size: 14 });
    expect(v2.metadata).toMatchObject({
      itemId: "01Q3",
      versionId: "2.0",
      lastModifiedBy: "Alice Example",
    });
    expect((await harness.readObject(v2)).toString()).toBe("q3 content v2!");
    expect(first.objectsTotal).toBe(8);
    expect(state(manifest).versions).toBe(true);

    const second = await engine.run(harness.context({ jobId: "job-2" }), oneDrive, {});
    const renamed = await harness.manifest(second);
    expect(paths(renamed)).toContain(`${Q3_ARCHIVED}:versions/2.0`);
    expect(paths(renamed)).toContain(`${Q3_ARCHIVED}:versions/1.0`);
    expect(graph.callsTo("GET", "/versions/2.0/content")).toHaveLength(1);
    const listings = graph.calls.filter((c) =>
      new URL(c.url).pathname.endsWith("/items/01Q3/versions"),
    );
    expect(listings).toHaveLength(1);
  });

  it("drops versions the source no longer lists and downloads only the new ones", async () => {
    const changedQ3 = q3Item({
      size: 12,
      cTag: '"c:{Q3},2"',
      file: { mimeType: "text/plain", hashes: { quickXorHash: "cZgBCMbwBjfQoQxurAMIZAAAAAA=" } },
      "@microsoft.graph.downloadUrl": downloadLink("q3v2"),
    });
    const trimmed = {
      value: [
        { id: "4.0", size: 12, lastModifiedDateTime: "2026-09-15T08:00:00Z" },
        { id: "3.0", size: 11, lastModifiedDateTime: "2026-08-30T15:30:00Z" },
        fixture.versions.value[1],
      ],
    };
    const graph = createFakeGraph([
      ...initialRoutes(),
      {
        url: (u) => u.pathname.endsWith("/items/01Q3/versions"),
        respond: [
          { status: 200, json: fixture.versions },
          { status: 200, json: trimmed },
        ],
      },
      {
        url: (u) => u.pathname.endsWith("/items/01Q3/versions/3.0/content"),
        respond: { status: 200, bytes: new TextEncoder().encode(CONTENT.q3) },
      },
      {
        url: (u) => u.pathname.endsWith("/items/01Q3/versions/2.0/content"),
        respond: { status: 200, bytes: new TextEncoder().encode("q3 content v2!") },
      },
      {
        url: (u) => u.pathname.endsWith("/items/01Q3/versions/1.0/content"),
        respond: { status: 200, bytes: new TextEncoder().encode("q3 v1 c!") },
      },
      {
        url: (u) => u.pathname.endsWith("/items/01NOTES/versions"),
        respond: { status: 200, json: { value: [] } },
      },
      { url: deltaUrl("DELTA1"), respond: { status: 200, json: page([changedQ3], "DELTA2") } },
      ...contentRoutes({ q3v2: "q3 content 2" }),
    ]);
    const engine = harness.engine(graph, { includeVersions: true });
    await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
    const second = await engine.run(harness.context({ jobId: "job-2" }), oneDrive, {});

    const versions = paths(await harness.manifest(second)).filter((p) => p.includes(":versions/"));
    expect(versions).toEqual([`${Q3_PATH}:versions/2.0`, `${Q3_PATH}:versions/3.0`]);
    expect(graph.callsTo("GET", "/versions/2.0/content")).toHaveLength(1);
    expect(graph.callsTo("GET", "/versions/3.0/content")).toHaveLength(1);
  });

  it("lists versions of unchanged files too once versions are switched on", async () => {
    const graph = createFakeGraph([
      ...initialRoutes(),
      {
        url: (u) => u.pathname.endsWith("/items/01Q3/versions"),
        respond: { status: 200, json: fixture.versions },
      },
      {
        url: (u) => u.pathname.endsWith("/items/01Q3/versions/2.0/content"),
        respond: { status: 200, bytes: new TextEncoder().encode("q3 content v2!") },
      },
      {
        url: (u) => u.pathname.endsWith("/items/01Q3/versions/1.0/content"),
        respond: { status: 200, bytes: new TextEncoder().encode("q3 v1 c!") },
      },
      {
        url: (u) => u.pathname.endsWith("/items/01NOTES/versions"),
        respond: { status: 200, json: { value: [{ id: "1.0", size: 11 }] } },
      },
    ]);
    await harness.engine(graph).run(harness.context({ jobId: "job-1" }), oneDrive, {});
    const second = await harness
      .engine(graph, { includeVersions: true })
      .run(harness.context({ jobId: "job-2" }), oneDrive, {});

    const manifest = await harness.manifest(second);
    expect(paths(manifest)).toContain(`${Q3_PATH}:versions/2.0`);
    expect(paths(manifest)).toContain(`${Q3_PATH}:versions/1.0`);
    expect(state(manifest)).toMatchObject({ versions: true, mode: "initial" });
    // The files themselves were reused; only the versions were new.
    expect(graph.callsTo("GET", "item=q3")).toHaveLength(1);
    expect(second.bytes).toBe("q3 content v2!".length + "q3 v1 c!".length);
  });

  it("re-enumerates on a full run but still reuses unchanged content", async () => {
    const graph = createFakeGraph(initialRoutes());
    const engine = harness.engine(graph);
    await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
    const full = await engine.run(harness.context({ jobId: "job-2" }), oneDrive, { full: true });
    expect(full.bytes).toBe(0);
    expect(full.objectsTotal).toBe(6);
    expect(full.objectsWritten).toBe(0);
    expect(graph.callsTo("GET", "item=q3")).toHaveLength(1);
    expect(graph.calls.filter((c) => c.url.includes("token=DELTA1"))).toHaveLength(0);
    expect(state(await harness.manifest(full))).toMatchObject({ mode: "initial" });
  });

  it("checkpoints no more often than the minimum interval allows", async () => {
    const graph = createFakeGraph(initialRoutes());
    const engine = harness.engine(graph, {
      checkpointEveryItems: 1,
      checkpointMinIntervalMs: 60_000,
    });
    await engine.run(harness.context({ jobId: "job-1" }), oneDrive, {});
    // The clock stands still: only the checkpoint after the walk is taken.
    expect(harness.cursor.saves).toBe(1);

    const other = await Harness.create();
    try {
      let tick = 0;
      const moving = () => new Date(Date.parse("2026-09-22T10:00:00Z") + 61_000 * tick++);
      await other
        .engine(createFakeGraph(initialRoutes()), {
          checkpointEveryItems: 1,
          checkpointMinIntervalMs: 60_000,
        })
        .run(other.context({ now: moving }), oneDrive, {});
      expect(other.cursor.saves).toBeGreaterThan(3);
    } finally {
      await other.dispose();
    }
  });

  it("fails the job, not the item, when the drive itself cannot be read", async () => {
    const graph = createFakeGraph([
      { url: deltaUrl(null), respond: { status: 403, json: graphError("accessDenied") } },
    ]);
    await expect(harness.engine(graph).run(harness.context(), oneDrive, {})).rejects.toMatchObject({
      status: 403,
    });
    // A checkpoint was left behind so the retry does not start from nothing.
    expect(readCursor(harness.cursor.cursor, DRIVE)?.snapshot?.snapshotId).toBe("snap-1");
  });

  it("refuses protected objects of another kind", async () => {
    const graph = createFakeGraph([]);
    await expect(
      harness.engine(graph).run(harness.context(), { ...oneDrive, kind: "mailbox" }, {}),
    ).rejects.toThrow(/cannot back up/);
  });
});

describe("resolveOneDriveId", () => {
  it("takes a drive id as-is and resolves users through /users/{id}/drive", async () => {
    const graph = createFakeGraph([
      {
        url: /users\/alice%40example\.test\/drive/,
        respond: { status: 200, json: driveFixture.drive },
      },
      {
        url: /users\/shared%40example\.test\/drive/,
        respond: { status: 404, json: graphError("ResourceNotFound", "User's mysite not found.") },
      },
    ]);
    const client = graph.client();
    expect(await resolveOneDriveId(client, oneDrive)).toBe(DRIVE);
    expect(await resolveOneDriveId(client, { ...oneDrive, externalId: "alice@example.test" })).toBe(
      "b!drive1",
    );
    const missing = resolveOneDriveId(client, { ...oneDrive, externalId: "shared@example.test" });
    await expect(missing).rejects.toBeInstanceOf(OneDriveUnavailableError);
    // Permanent and named for what it is, so the job is not retried as "unknown".
    const cause = classifyFailure(await missing.catch((error: unknown) => error));
    expect(cause).toMatchObject({ code: "graph.onedrive_unavailable", transient: false });
  });
});
