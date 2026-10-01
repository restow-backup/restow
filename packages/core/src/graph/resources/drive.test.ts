import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { InMemoryDeltaTokenStore } from "../delta.js";
import { createFakeGraph, graphError, must } from "../testing/fake-graph.js";
import fixture from "../testing/fixtures/drive-delta.json" with { type: "json" };
import {
  type DriveDeltaItem,
  createUploadSession,
  driveDelta,
  driveItemPath,
  ensureDriveFolderPath,
  getUserDrive,
  isDeletedItem,
  isFileItem,
  isFolderItem,
  openItemDownload,
  uploadFile,
} from "./drive.js";
import {
  DRIVE_FRAGMENT_BOUNDS,
  OUTLOOK_FRAGMENT_BOUNDS,
  UPLOAD_FRAGMENT_UNIT,
  UploadSessionError,
  normalizeFragmentSize,
  readFragments,
  uploadToSession,
} from "./upload-session.js";

const DRIVE = "b!drive1";

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

describe("drive", () => {
  it("returns null for users without a OneDrive instead of failing", async () => {
    const graph = createFakeGraph([
      { url: /users\/user-1\/drive/, respond: { status: 200, json: fixture.drive } },
      {
        url: /users\/user-shared\/drive/,
        respond: { status: 404, json: graphError("ResourceNotFound", "User's mysite not found.") },
      },
      {
        url: /users\/user-broken\/drive/,
        respond: { status: 403, json: graphError("accessDenied") },
      },
    ]);
    const client = graph.client();
    expect((await getUserDrive(client, "user-1"))?.id).toBe(DRIVE);
    expect(await getUserDrive(client, "user-shared")).toBeNull();
    await expect(getUserDrive(client, "user-broken")).rejects.toMatchObject({ status: 403 });
  });

  it("enumerates the root delta and reports deletions through the deleted facet", async () => {
    const graph = createFakeGraph([
      {
        url: (u) => u.pathname.endsWith("/root/delta") && u.search === "",
        respond: { status: 200, json: fixture.initialPage1 },
      },
      { url: /token=NEXT1/, respond: { status: 200, json: fixture.initialPage2 } },
      { url: /token=DELTA1/, respond: { status: 200, json: fixture.incrementalPage } },
    ]);
    const store = new InMemoryDeltaTokenStore();
    const client = graph.client();

    const first: DriveDeltaItem[] = [];
    let generator = driveDelta(client, store, DRIVE);
    let next = await generator.next();
    while (!next.done) {
      first.push(...next.value.items);
      next = await generator.next();
    }
    expect(first.map((i) => driveItemPath(i))).toEqual([
      "",
      "Documents",
      "Documents/Report Q3.xlsx",
      "notes.txt",
    ]);
    expect(first.filter(isFolderItem).map((i) => i.id)).toEqual(["01ROOT", "01DOCS"]);
    expect(first.filter(isFileItem).map((i) => i.id)).toEqual(["01REPORT", "01NOTES"]);
    expect(new URL(must(graph.calls[0]).url).searchParams.has("$select")).toBe(false);

    const second: DriveDeltaItem[] = [];
    generator = driveDelta(client, store, DRIVE);
    next = await generator.next();
    while (!next.done) {
      second.push(...next.value.items);
      next = await generator.next();
    }
    expect(next.value.mode).toBe("incremental");
    expect(second.map((i) => [i.id, isDeletedItem(i), isFileItem(i)])).toEqual([
      ["01NOTES", true, false],
    ]);
  });

  it("streams through the pre-authenticated download URL without a bearer token and refreshes an expired one", async () => {
    const graph = createFakeGraph([
      {
        url: /tempauth=OK/,
        respond: { status: 200, bytes: new TextEncoder().encode("hello notes") },
      },
      { url: /tempauth=EXPIRING/, respond: { status: 401, text: "expired" } },
      {
        url: (u) => u.pathname.endsWith("/items/01REPORT"),
        respond: { status: 200, json: fixture.refreshedItem },
      },
      {
        url: /tempauth=FRESH/,
        respond: {
          status: 200,
          headers: { "content-length": "5" },
          bytes: new Uint8Array([1, 2, 3, 4, 5]),
        },
      },
    ]);
    const client = graph.client();
    const notes = fixture.initialPage2.value[0] as DriveDeltaItem;
    const download = await openItemDownload(client, DRIVE, notes);
    expect((await drain(download.stream)).toString()).toBe("hello notes");
    expect(must(graph.calls[0]).headers.authorization).toBeUndefined();

    const report = fixture.initialPage1.value[2] as DriveDeltaItem;
    const refreshed = await openItemDownload(client, DRIVE, report);
    expect(await drain(refreshed.stream)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(refreshed.contentLength).toBe(5);
    const itemGet = new URL(must(graph.callsTo("GET", "/items/01REPORT")[0]).url);
    expect(itemGet.searchParams.get("$select")).toContain("content.downloadUrl");
    expect(must(graph.callsTo("GET", "/items/01REPORT")[0]).headers.authorization).toBe(
      "Bearer test-token",
    );
  });

  it("uploads small files with one PUT and sets fileSystemInfo afterwards", async () => {
    const graph = createFakeGraph([
      {
        method: "PUT",
        url: /items\/01DOCS:\/small\.txt:\/content/,
        respond: { status: 201, json: { id: "01SMALL", name: "small.txt" } },
      },
      {
        method: "PATCH",
        url: (u) => u.pathname.endsWith("/items/01SMALL"),
        respond: {
          status: 200,
          json: {
            id: "01SMALL",
            name: "small.txt",
            fileSystemInfo: { lastModifiedDateTime: "2026-08-30T15:30:00Z" },
          },
        },
      },
    ]);
    const item = await uploadFile(
      graph.client(),
      DRIVE,
      "01DOCS",
      "small.txt",
      Buffer.from("tiny"),
      4,
      {
        conflictBehavior: "rename",
        fileSystemInfo: { lastModifiedDateTime: "2026-08-30T15:30:00Z" },
      },
    );
    expect(item.fileSystemInfo?.lastModifiedDateTime).toBe("2026-08-30T15:30:00Z");
    const put = must(graph.calls[0]);
    expect(new URL(put.url).searchParams.get("@microsoft.graph.conflictBehavior")).toBe("rename");
    expect(Buffer.from(put.body as Uint8Array).toString()).toBe("tiny");
    expect(must(graph.calls[1]).json).toEqual({
      fileSystemInfo: { lastModifiedDateTime: "2026-08-30T15:30:00Z" },
    });
  });

  it("uploads large files through an upload session in 320 KiB-aligned fragments with mtime in the session", async () => {
    const size = 8_000_000;
    const fragment = normalizeFragmentSize(5 * 1024 * 1024, DRIVE_FRAGMENT_BOUNDS);
    let received = 0;
    const graph = createFakeGraph([
      {
        method: "POST",
        url: /createUploadSession/,
        respond: { status: 200, json: fixture.uploadSession },
      },
      {
        method: "PUT",
        url: /session=SESSION1/,
        respond: (call) => {
          const range = must(
            must(call.headers["content-range"]).match(/^bytes (\d+)-(\d+)\/(\d+)$/),
          );
          expect(Number(range[1])).toBe(received);
          expect((call.body as Uint8Array).length).toBe(Number(range[2]) - Number(range[1]) + 1);
          received = Number(range[2]) + 1;
          return received >= size
            ? { status: 201, json: fixture.uploadedItem }
            : {
                status: 202,
                json: {
                  expirationDateTime: "2026-09-22T12:00:00Z",
                  nextExpectedRanges: [`${received}-`],
                },
              };
        },
      },
    ]);
    const progress: number[] = [];
    const item = await uploadFile(
      graph.client(),
      DRIVE,
      "01DOCS",
      "restored.bin",
      Readable.from([Buffer.alloc(3_000_000, 1), Buffer.alloc(5_000_000, 2)]),
      size,
      {
        fragmentSize: 5 * 1024 * 1024,
        fileSystemInfo: { lastModifiedDateTime: "2026-08-30T15:30:00Z" },
        onProgress: (p) => progress.push(p.uploadedBytes),
      },
    );
    expect(item.id).toBe("01RESTORED");
    expect(fragment % UPLOAD_FRAGMENT_UNIT).toBe(0);
    const session = must(graph.callsTo("POST", "createUploadSession")[0]).json as {
      item: Record<string, unknown>;
    };
    expect(session.item).toEqual({
      "@microsoft.graph.conflictBehavior": "fail",
      name: "restored.bin",
      fileSystemInfo: { lastModifiedDateTime: "2026-08-30T15:30:00Z" },
    });
    const puts = graph.callsTo("PUT", "SESSION1");
    expect(puts).toHaveLength(2);
    expect(must(puts[0]).headers["content-range"]).toBe(`bytes 0-${fragment - 1}/${size}`);
    expect(must(puts[1]).headers["content-range"]).toBe(`bytes ${fragment}-${size - 1}/${size}`);
    expect(puts.every((p) => p.headers.authorization === undefined)).toBe(true);
    expect(progress).toEqual([fragment, size]);
  });

  it("ensures folder paths below the root, tolerating a create race", async () => {
    const graph = createFakeGraph([
      {
        url: (u) => u.pathname === `/v1.0/drives/${DRIVE}/root:/Documents`,
        respond: { status: 200, json: { id: "01DOCS", name: "Documents", folder: {} } },
      },
      {
        url: (u) => u.pathname === `/v1.0/drives/${DRIVE}/items/01DOCS:/Restored`,
        respond: [
          { status: 404, json: graphError("itemNotFound") },
          { status: 200, json: { id: "01RESTORED_DIR", folder: {} } },
        ],
      },
      {
        method: "POST",
        url: (u) => u.pathname.endsWith("/items/01DOCS/children"),
        respond: { status: 409, json: graphError("nameAlreadyExists") },
      },
    ]);
    const id = await ensureDriveFolderPath(graph.client(), DRIVE, "Documents/Restored");
    expect(id).toBe("01RESTORED_DIR");
    expect(must(graph.callsTo("POST", "/children")[0]).json).toEqual({
      name: "Restored",
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    });
  });

  it("refuses to treat a file as a folder", async () => {
    const graph = createFakeGraph([
      {
        url: (u) => u.pathname === `/v1.0/drives/${DRIVE}/root:/notes.txt`,
        respond: { status: 200, json: { id: "01NOTES", file: {} } },
      },
    ]);
    await expect(ensureDriveFolderPath(graph.client(), DRIVE, "notes.txt")).rejects.toThrow(
      /a file with that name exists/,
    );
  });
});

describe("upload sessions", () => {
  it("normalises fragment sizes into bounds and whole units", () => {
    expect(normalizeFragmentSize(1, DRIVE_FRAGMENT_BOUNDS)).toBe(16 * UPLOAD_FRAGMENT_UNIT);
    expect(normalizeFragmentSize(10 * 1024 * 1024, DRIVE_FRAGMENT_BOUNDS)).toBe(
      32 * UPLOAD_FRAGMENT_UNIT,
    );
    expect(normalizeFragmentSize(1024 * 1024 * 1024, DRIVE_FRAGMENT_BOUNDS)).toBe(
      192 * UPLOAD_FRAGMENT_UNIT,
    );
    expect(normalizeFragmentSize(4 * 1024 * 1024, OUTLOOK_FRAGMENT_BOUNDS)).toBe(
      12 * UPLOAD_FRAGMENT_UNIT,
    );
  });

  it("re-chunks arbitrary readable chunks into exact fragments", async () => {
    const readable = Readable.from([Buffer.from("abc"), Buffer.from("defgh"), Buffer.from("i")]);
    const fragments: string[] = [];
    for await (const fragment of readFragments(readable, 4)) {
      fragments.push(fragment.toString());
    }
    expect(fragments).toEqual(["abcd", "efgh", "i"]);
  });

  it("resumes a seekable source from the offset the session reports", async () => {
    const total = 3 * UPLOAD_FRAGMENT_UNIT;
    const data = Buffer.alloc(total, 9);
    const graph = createFakeGraph([
      {
        method: "PUT",
        url: /session=RESUME/,
        respond: [
          { status: 202, json: { nextExpectedRanges: [`${2 * UPLOAD_FRAGMENT_UNIT}-`] } },
          { status: 201, json: { id: "done" } },
        ],
      },
    ]);
    const outcome = await uploadToSession<{ id: string }>(
      graph.client(),
      { uploadUrl: "https://x/upload?session=RESUME", nextExpectedRanges: ["0-"] },
      data,
      total,
      { fragmentSize: UPLOAD_FRAGMENT_UNIT, bounds: OUTLOOK_FRAGMENT_BOUNDS },
    );
    expect(outcome.result?.id).toBe("done");
    expect(outcome.fragments).toBe(2);
    expect(must(graph.calls[1]).headers["content-range"]).toBe(
      `bytes ${2 * UPLOAD_FRAGMENT_UNIT}-${total - 1}/${total}`,
    );
  });

  it("fails clearly when the session expired (404) or the range was rejected (416)", async () => {
    const graph = createFakeGraph([
      {
        method: "PUT",
        url: /session=EXPIRED/,
        respond: { status: 404, json: graphError("itemNotFound") },
      },
      {
        method: "PUT",
        url: /session=RANGE/,
        respond: { status: 416, json: graphError("invalidRange") },
      },
      {
        method: "GET",
        url: /session=RANGE/,
        respond: { status: 200, json: { nextExpectedRanges: ["655360-"] } },
      },
    ]);
    const client = graph.client();
    const data = Buffer.alloc(UPLOAD_FRAGMENT_UNIT);
    await expect(
      uploadToSession(client, { uploadUrl: "https://x/u?session=EXPIRED" }, data, data.length, {
        bounds: OUTLOOK_FRAGMENT_BOUNDS,
      }),
    ).rejects.toMatchObject({ name: "UploadSessionError", details: { status: 404 } });
    const error = await uploadToSession(
      client,
      { uploadUrl: "https://x/u?session=RANGE" },
      data,
      data.length,
      {
        bounds: OUTLOOK_FRAGMENT_BOUNDS,
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadSessionError);
    expect((error as UploadSessionError).details.nextExpectedRanges).toEqual(["655360-"]);
  });

  it("creates a OneDrive upload session with conflict behaviour and timestamps", async () => {
    const graph = createFakeGraph([
      {
        method: "POST",
        url: /createUploadSession/,
        respond: { status: 200, json: fixture.uploadSession },
      },
    ]);
    const session = await createUploadSession(graph.client(), DRIVE, "root", "a b.txt", {
      conflictBehavior: "replace",
    });
    expect(session.uploadUrl).toContain("SESSION1");
    expect(new URL(must(graph.calls[0]).url).pathname).toBe(
      `/v1.0/drives/${DRIVE}/root:/a%20b.txt:/createUploadSession`,
    );
    expect(must(graph.calls[0]).json).toEqual({
      item: { "@microsoft.graph.conflictBehavior": "replace", name: "a b.txt" },
    });
  });
});
