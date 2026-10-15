import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness, TENANT } from "../backup/onedrive/testing.js";
import { SharePointBackupEngine } from "../backup/sharepoint/engine.js";
import { FakeSharePoint, type FakeSpList, type FakeSpSite } from "../backup/sharepoint/testing.js";
import type { ProtectedObjectRef, RestoreRequest } from "../engine/types.js";
import { verifyProtectedObject } from "../verify/engine.js";
import { DownloadRestoreEngine } from "./download.js";
import { SharePointRestoreEngine } from "./sharepoint.js";
import { FakeDrive } from "./testing/fake-drive.js";
import { readZip } from "./testing/zip-reader.js";

const SITE_ID = "contoso.sharepoint.example,1111,2222";

const siteObject: ProtectedObjectRef = {
  id: "po-site-1",
  tenantId: TENANT,
  sourceId: "src-1",
  kind: "site",
  externalId: SITE_ID,
  displayName: "Sales",
  userId: null,
};

interface World {
  sp: FakeSharePoint;
  drive: FakeDrive;
  site: FakeSpSite;
  tasks: FakeSpList;
  snapshotId: string;
}

async function backedUp(harness: Harness): Promise<World> {
  const drive = new FakeDrive("b!docs");
  const sp = new FakeSharePoint(drive.routes());
  const site = sp.addSite({ id: SITE_ID, displayName: "Sales" });
  const documents = sp.addLibrary(site, "Documents", "b!docs");
  const reports = sp.addFolder(documents, "Reports");
  sp.addFile(documents, "Q3.xlsx", "q3 numbers", reports.id);
  sp.addFile(documents, "readme.txt", "hello sales");
  const pages = sp.addLibrary(site, "Site Pages", "b!pages");
  sp.addFile(pages, "Home.aspx", "<html>home</html>");
  const tasks = sp.addList(site, { displayName: "Team Tasks" });
  sp.addListItem(tasks, { Title: "Call customer", Status: "Open", Total: 1 });
  sp.addListItem(tasks, { Title: "Send offer", Status: "Done", Total: 1 });
  const client = sp.graph.client();
  const result = await new SharePointBackupEngine({
    graph: async () => client,
    checkpointMinIntervalMs: 0,
    snapshotIdGenerator: () => "snap-1",
  }).run(harness.context(), siteObject, {});
  return { sp, drive, site, tasks, snapshotId: result.snapshotId };
}

function request(world: World, overrides: Partial<RestoreRequest> = {}): RestoreRequest {
  return {
    restoreJobId: "restore-1",
    snapshotId: world.snapshotId,
    protectedObject: siteObject,
    selection: { all: true },
    target: { type: "original", ref: null },
    mode: "rename",
    actor: { userId: null, impersonated: false, reason: null },
    ...overrides,
  };
}

function restoreEngine(world: World) {
  const client = world.sp.graph.client();
  return new SharePointRestoreEngine({ graph: async () => client });
}

describe("SharePointRestoreEngine", () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await Harness.create();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it("puts files back into their original library at their original path", async () => {
    const world = await backedUp(harness);
    const report = await restoreEngine(world).run(
      harness.context({ jobId: "restore" }),
      request(world, { selection: { folderPaths: ["Libraries/Documents"] } }),
    );
    expect(report.failures).toEqual([]);
    expect(
      world.drive
        .files()
        .map((file) => world.drive.pathOf(file.id))
        .sort(),
    ).toEqual(["Reports/Q3.xlsx", "readme.txt"]);
    expect(
      world.drive
        .files()
        .find((file) => file.name === "Q3.xlsx")
        ?.content.toString(),
    ).toBe("q3 numbers");
    // Uploads went to the library's own drive.
    const uploads = world.sp.graph.calls.filter((call) => call.method === "PUT");
    expect(uploads.every((call) => call.url.includes("/drives/b!docs/"))).toBe(true);
    expect(
      report.items.find((item) => item.path === "Libraries/Documents/readme.txt"),
    ).toMatchObject({ status: "restored", verified: true });
  });

  it("keeps both copies in rename mode and overwrites in replace mode", async () => {
    const world = await backedUp(harness);
    const root = world.drive.items.get("root");
    if (!root) throw new Error("fixture");
    world.drive.addFile("root", "readme.txt", Buffer.from("changed since"));
    await restoreEngine(world).run(
      harness.context({ jobId: "restore" }),
      request(world, { selection: { paths: ["Libraries/Documents/readme.txt"] } }),
    );
    expect(
      world.drive
        .files()
        .map((file) => file.name)
        .sort(),
    ).toEqual(["readme 1.txt", "readme.txt"]);

    await restoreEngine(world).run(
      harness.context({ jobId: "restore-2" }),
      request(world, {
        restoreJobId: "restore-2",
        mode: "replace",
        selection: { paths: ["Libraries/Documents/readme.txt"] },
      }),
    );
    expect(world.drive.child("root", "readme.txt")?.content.toString()).toBe("hello sales");
  });

  it("restores into another library below a folder, keeping each library apart", async () => {
    const world = await backedUp(harness);
    const report = await restoreEngine(world).run(
      harness.context({ jobId: "restore" }),
      request(world, {
        target: { type: "other", ref: "b!archive:/Restored" },
        selection: { folderPaths: ["Libraries"] },
      }),
    );
    expect(report.failures).toEqual([]);
    expect(
      world.drive
        .files()
        .map((file) => world.drive.pathOf(file.id))
        .sort(),
    ).toEqual([
      "Restored/Documents/Reports/Q3.xlsx",
      "Restored/Documents/readme.txt",
      "Restored/Site Pages/Home.aspx",
    ]);
    const uploads = world.sp.graph.calls.filter((call) => call.method === "PUT");
    expect(uploads.every((call) => call.url.includes("/drives/b!archive/"))).toBe(true);
  });

  it("adds list items as new items with their writable fields only", async () => {
    const world = await backedUp(harness);
    const report = await restoreEngine(world).run(
      harness.context({ jobId: "restore" }),
      request(world, { selection: { folderPaths: ["Lists/Team Tasks"] } }),
    );
    expect(report.failures).toEqual([]);
    expect(world.tasks.items.map((item) => [item.id, item.fields.Title])).toEqual([
      ["1", "Call customer"],
      ["2", "Send offer"],
      ["3", "Call customer"],
      ["4", "Send offer"],
    ]);
    const posted = world.sp.graph.callsTo("POST", "/items").map((call) => call.json);
    expect(posted[0]).toEqual({ fields: { Title: "Call customer", Status: "Open" } });
    expect(
      report.items.find((item) => item.path === "Lists/Team Tasks/Call customer (1).json"),
    ).toMatchObject({
      status: "restored",
      targetRef: "3",
    });
    expect(report.items.find((item) => item.path === "Lists/Team Tasks/_list.json")).toMatchObject({
      status: "skipped",
      code: "not_restorable",
    });
  });

  it("overwrites an existing item in replace mode and recreates a deleted one", async () => {
    const world = await backedUp(harness);
    const first = world.tasks.items[0];
    if (!first) throw new Error("fixture");
    world.sp.changeListItem(first, { Status: "Done" });
    world.tasks.items.splice(1, 1);
    const report = await restoreEngine(world).run(
      harness.context({ jobId: "restore" }),
      request(world, { mode: "replace", selection: { folderPaths: ["Lists/Team Tasks"] } }),
    );
    expect(report.failures).toEqual([]);
    expect(
      world.tasks.items.map((item) => [item.id, item.fields.Title, item.fields.Status]),
    ).toEqual([
      ["1", "Call customer", "Open"],
      ["2", "Send offer", "Done"],
    ]);
  });

  it("leaves existing items alone in skip mode", async () => {
    const world = await backedUp(harness);
    const report = await restoreEngine(world).run(
      harness.context({ jobId: "restore" }),
      request(world, {
        mode: "skip",
        selection: { paths: ["Lists/Team Tasks/Call customer (1).json"] },
      }),
    );
    expect(report.skipped).toBe(1);
    expect(world.tasks.items).toHaveLength(2);
  });

  it("downloads a site restore point as a ZIP with libraries and list items", async () => {
    const world = await backedUp(harness);
    const report = await new DownloadRestoreEngine().run(
      harness.context({ jobId: "download" }),
      request(world, { target: { type: "download", ref: null } }),
    );
    expect(report.failures).toEqual([]);
    const entries = readZip(await harness.storage.get(report.downloadKey as string));
    const names = entries.map((entry) => entry.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "Libraries/Documents/Reports/Q3.xlsx",
        "Libraries/Site Pages/Home.aspx",
        "Lists/Team Tasks/Call customer (1).json",
        "site.json",
      ]),
    );
    const item = entries.find((entry) => entry.name === "Lists/Team Tasks/Send offer (2).json");
    expect(JSON.parse(item?.data.toString("utf8") ?? "{}").fields.Title).toBe("Send offer");
  });

  it("reads sample files of a site restore point back in the restore check", async () => {
    await backedUp(harness);
    const outcome = await verifyProtectedObject(harness.context({ jobId: "verify" }), siteObject, {
      kind: "verify",
      sampleSize: 20,
      seed: 7,
    });
    expect(outcome.readiness).toBe("green");
    expect(outcome.checked).toBe(3);
    expect(outcome.mismatched).toBe(0);
  });
});
