import { afterEach, describe, expect, it } from "vitest";
import type { ManifestObject, SnapshotManifest } from "../manifest.js";
import {
  RestoreSourceError,
  planRestore,
  resolveRestoreSource,
  selectObjects,
} from "./selection.js";
import { type SnapshotFixture, createSnapshotFixture } from "./testing/fixtures.js";

function manifestOf(objects: ManifestObject[]): SnapshotManifest {
  return {
    version: 1,
    tenantId: "t",
    snapshotId: "s",
    createdAt: 0,
    source: { type: "m365", id: "user@example.org" },
    objects,
  };
}

function object(path: string, extra: Partial<ManifestObject> = {}): ManifestObject {
  return { path, size: 1, mtime: 0, chunks: [], ...extra };
}

describe("selectObjects", () => {
  const manifest = manifestOf([
    object("mail/Inbox/b.eml", { type: "mail", id: "B" }),
    object("mail/Inbox/a.eml", { type: "mail", id: "A" }),
    object("mail/Inbox/Projects/c.eml", { type: "mail", id: "C" }),
    object("mail/Sent Items/d.json", { type: "mail", id: "D", metadata: { format: "json" } }),
    object("mail/Sent Items/d.attachments/x.pdf.1", {
      type: "attachment",
      metadata: { messagePath: "mail/Sent Items/d.json" },
    }),
    object("mail/Sent Items/d.attachments/y.pdf.2", {
      type: "attachment",
      metadata: { messageItemId: "D" },
    }),
    object("calendar/Team/e.json", { type: "event", id: "E" }),
  ]);

  it("returns everything in path order for an empty or `all` selection", () => {
    expect(selectObjects(manifest, {}).map((o) => o.path)).toEqual([
      "calendar/Team/e.json",
      "mail/Inbox/Projects/c.eml",
      "mail/Inbox/a.eml",
      "mail/Inbox/b.eml",
      "mail/Sent Items/d.attachments/x.pdf.1",
      "mail/Sent Items/d.attachments/y.pdf.2",
      "mail/Sent Items/d.json",
    ]);
    expect(selectObjects(manifest, { all: true })).toHaveLength(7);
  });

  it("selects by path, folder subtree and id without duplicates", () => {
    expect(
      selectObjects(manifest, {
        paths: ["mail/Inbox/a.eml"],
        objectIds: ["A", "E"],
        folderPaths: ["mail/Inbox/Projects"],
      }).map((o) => o.id),
    ).toEqual(["E", "C", "A"]);
  });

  it("pulls attachments in with their message, by path or by message id", () => {
    const plan = planRestore(manifest, { objectIds: ["D"] });
    expect(plan.objects.map((o) => o.path)).toEqual([
      "mail/Sent Items/d.attachments/x.pdf.1",
      "mail/Sent Items/d.attachments/y.pdf.2",
      "mail/Sent Items/d.json",
    ]);
    expect(plan.mail).toHaveLength(1);
    expect(plan.attachmentsByMessage.get("mail/Sent Items/d.json")).toHaveLength(2);
    expect(plan.orphanAttachments).toEqual([]);
  });

  it("keeps an attachment selected without its message apart", () => {
    const plan = planRestore(manifest, { paths: ["mail/Sent Items/d.attachments/x.pdf.1"] });
    expect(plan.mail).toEqual([]);
    expect(plan.orphanAttachments.map((o) => o.path)).toEqual([
      "mail/Sent Items/d.attachments/x.pdf.1",
    ]);
  });

  it("does not match a folder prefix against a longer name", () => {
    expect(selectObjects(manifest, { folderPaths: ["mail/Inbox/Proj"] })).toHaveLength(0);
  });

  it("restores historical versions only when they are picked explicitly", () => {
    const drive = manifestOf([
      object("Docs", { type: "folder", id: "F" }),
      object("Docs/report.docx", { type: "file", id: "R" }),
      object("Docs/report.docx:versions/1.0", { type: "file-version", id: "R#1.0" }),
      object("Docs/nb", { type: "package", id: "P" }),
    ]);
    expect(selectObjects(drive, { all: true }).map((o) => o.id)).toEqual(["F", "P", "R"]);
    expect(selectObjects(drive, { folderPaths: ["Docs"] }).map((o) => o.id)).toEqual([
      "F",
      "P",
      "R",
    ]);
    expect(selectObjects(drive, { objectIds: ["R#1.0"] }).map((o) => o.id)).toEqual(["R#1.0"]);
    expect(selectObjects(drive, { paths: ["Docs/report.docx:versions/1.0"] })).toHaveLength(1);

    const plan = planRestore(drive, { all: true, objectIds: ["R#1.0"] });
    expect(plan.files.map((o) => o.id)).toEqual(["R"]);
    expect(plan.versions.map((o) => o.id)).toEqual(["R#1.0"]);
    expect(plan.folders.map((o) => o.id)).toEqual(["F"]);
    expect(plan.informational.map((o) => o.id)).toEqual(["P"]);
  });
});

describe("resolveRestoreSource", () => {
  let fixture: SnapshotFixture;

  afterEach(async () => {
    await fixture?.cleanup();
  });

  it("loads the committed manifest of the requested snapshot", async () => {
    fixture = await createSnapshotFixture({
      kind: "onedrive",
      externalId: "drive-1",
      objects: [{ path: "Documents/a.txt", type: "file", content: "hello" }],
    });
    const { record, manifest } = await resolveRestoreSource(fixture.ctx, {
      snapshotId: fixture.snapshotId,
      protectedObject: fixture.protectedObject,
    });
    expect(record.id).toBe(fixture.snapshotId);
    expect(manifest.objects.map((o) => o.path)).toEqual(["Documents/a.txt"]);
  });

  it("refuses unknown, foreign, pruned and unfinished snapshots", async () => {
    fixture = await createSnapshotFixture({
      kind: "onedrive",
      externalId: "drive-1",
      objects: [{ path: "Documents/a.txt", type: "file", content: "hello" }],
    });
    const request = { snapshotId: fixture.snapshotId, protectedObject: fixture.protectedObject };
    await expect(
      resolveRestoreSource(fixture.ctx, {
        ...request,
        snapshotId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toBeInstanceOf(RestoreSourceError);
    await expect(
      resolveRestoreSource(fixture.ctx, {
        ...request,
        protectedObject: { ...fixture.protectedObject, id: "someone-else" },
      }),
    ).rejects.toThrow(/different protected object/);

    const record = await fixture.ctx.snapshots.get(fixture.snapshotId);
    const rows = (fixture.ctx.snapshots as unknown as { rows: Map<string, unknown> }).rows;
    rows.set(fixture.snapshotId, { ...record, status: "pruned" });
    await expect(resolveRestoreSource(fixture.ctx, request)).rejects.toThrow(/pruned/);
    rows.set(fixture.snapshotId, { ...record, manifestPath: null });
    await expect(resolveRestoreSource(fixture.ctx, request)).rejects.toThrow(/never completed/);
  });
});
