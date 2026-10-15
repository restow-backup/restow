import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobAbortedError } from "../../engine/chunkstore.js";
import type { ProtectedObjectRef } from "../../engine/types.js";
import type { ManifestObject, SnapshotManifest } from "../../manifest.js";
import { Harness, TENANT } from "../onedrive/testing.js";
import { SharePointBackupEngine, SiteUnavailableError } from "./engine.js";
import { SITE_OBJECT_TYPES } from "./layout.js";
import type { SiteManifestState } from "./state.js";
import { FakeSharePoint, type FakeSpLibrary, type FakeSpList, type FakeSpSite } from "./testing.js";

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
  site: FakeSpSite;
  documents: FakeSpLibrary;
  pages: FakeSpLibrary;
  tasks: FakeSpList;
}

function world(): World {
  const sp = new FakeSharePoint();
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
  sp.addListItem(tasks, { Title: "Book trip", Status: "Open", Total: 1 });
  sp.addList(site, { displayName: "User Information List", hidden: true });
  return { sp, site, documents, pages, tasks };
}

function engine(sp: FakeSharePoint, ids = { snap: 1, pack: 1 }) {
  const client = sp.graph.client();
  return new SharePointBackupEngine({
    graph: async () => client,
    checkpointMinIntervalMs: 0,
    snapshotIdGenerator: () => `snap-${ids.snap++}`,
    packIdGenerator: () => `pack-${String(ids.pack++).padStart(4, "0")}`,
  });
}

function at(manifest: SnapshotManifest, path: string): ManifestObject {
  const object = manifest.objects.find((candidate) => candidate.path === path);
  if (!object) {
    throw new Error(`no ${path}; have ${manifest.objects.map((o) => o.path).join(", ")}`);
  }
  return object;
}

describe("SharePointBackupEngine", () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await Harness.create();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it("backs up libraries, lists and the site's metadata into one snapshot", async () => {
    const { sp } = world();
    const result = await engine(sp).run(harness.context(), siteObject, {});
    expect(result.failures).toEqual([]);
    const manifest = await harness.manifest(result);
    expect(manifest.objects.map((object) => object.path)).toEqual([
      "Libraries/Documents",
      "Libraries/Documents/Reports",
      "Libraries/Documents/Reports/Q3.xlsx",
      "Libraries/Documents/readme.txt",
      "Libraries/Site Pages",
      "Libraries/Site Pages/Home.aspx",
      "Lists/Team Tasks",
      "Lists/Team Tasks/1.json",
      "Lists/Team Tasks/2.json",
      "Lists/Team Tasks/3.json",
      "Lists/Team Tasks/_list.json",
      "site.json",
    ]);
    expect(manifest.source).toMatchObject({ kind: "site", id: SITE_ID });

    expect(at(manifest, "Libraries/Documents").metadata).toMatchObject({
      siteRole: "library",
      driveId: "b!docs",
    });
    const q3 = at(manifest, "Libraries/Documents/Reports/Q3.xlsx");
    expect(q3.type).toBe("file");
    expect((await harness.readObject(q3)).toString()).toBe("q3 numbers");

    const item = at(manifest, "Lists/Team Tasks/2.json");
    expect(item.type).toBe(SITE_OBJECT_TYPES.listItem);
    expect(item.metadata).toMatchObject({
      siteRole: "listItem",
      listItemId: "2",
      title: "Send offer",
    });
    const itemJson = JSON.parse((await harness.readObject(item)).toString());
    expect(itemJson.fields).toMatchObject({ Title: "Send offer", Status: "Done" });

    const schema = JSON.parse(
      (await harness.readObject(at(manifest, "Lists/Team Tasks/_list.json"))).toString(),
    );
    expect(schema.columns.map((column: { name: string }) => column.name)).toContain("Status");

    const info = JSON.parse((await harness.readObject(at(manifest, "site.json"))).toString());
    expect(info.site).toMatchObject({ displayName: "Sales", id: SITE_ID });
    expect(info.libraries.map((library: { folder: string }) => library.folder)).toEqual([
      "Documents",
      "Site Pages",
    ]);
    expect(info.libraries[0].rootPermissions[0]).toMatchObject({ roles: ["owner"] });
    expect(info.lists).toEqual([
      expect.objectContaining({ folder: "Team Tasks", items: 3, template: "genericList" }),
    ]);

    const state = manifest.state as unknown as SiteManifestState;
    expect(state.engine).toBe("sharepoint");
    expect(state.libraries.map((library) => [library.driveId, library.folder])).toEqual([
      ["b!docs", "Documents"],
      ["b!pages", "Site Pages"],
    ]);
    expect(state.libraries[0]?.drive.deltaLink).toContain("token=T");
  });

  it("continues each library from its delta link and reuses unchanged list items", async () => {
    const { sp, documents, tasks } = world();
    const ids = { snap: 1, pack: 1 };
    const first = await engine(sp, ids).run(harness.context(), siteObject, {});
    const before = await harness.manifest(first);

    const readme = [...documents.entries.values()].find((entry) => entry.name === "readme.txt");
    if (!readme) throw new Error("fixture");
    sp.changeFile(documents, readme, "hello sales v2");
    const q3 = [...documents.entries.values()].find((entry) => entry.name === "Q3.xlsx");
    if (!q3) throw new Error("fixture");
    sp.deleteEntry(documents, q3);
    const firstItem = tasks.items[0];
    if (!firstItem) throw new Error("fixture");
    sp.changeListItem(firstItem, { Status: "Done" });

    sp.graph.calls.length = 0;
    const second = await engine(sp, ids).run(harness.context({ jobId: "job-2" }), siteObject, {});
    const manifest = await harness.manifest(second);
    expect(sp.graph.calls.some((call) => call.url.includes("delta?token=T"))).toBe(true);
    expect(manifest.objects.map((object) => object.path)).not.toContain(
      "Libraries/Documents/Reports/Q3.xlsx",
    );
    expect(
      (await harness.readObject(at(manifest, "Libraries/Documents/readme.txt"))).toString(),
    ).toBe("hello sales v2");
    // The unchanged Site Pages file is neither downloaded again nor changed.
    expect(sp.graph.calls.filter((call) => call.url.includes("download.aspx"))).toHaveLength(1);
    expect(at(manifest, "Libraries/Site Pages/Home.aspx").chunks).toEqual(
      at(before, "Libraries/Site Pages/Home.aspx").chunks,
    );
    // Item 2 is unchanged and keeps its bytes; item 1 changed.
    expect(at(manifest, "Lists/Team Tasks/2.json").chunks).toEqual(
      at(before, "Lists/Team Tasks/2.json").chunks,
    );
    const changed = JSON.parse(
      (await harness.readObject(at(manifest, "Lists/Team Tasks/1.json"))).toString(),
    );
    expect(changed.fields.Status).toBe("Done");
  });

  it("reports a library Graph refuses and keeps its last good copy", async () => {
    const { sp, documents } = world();
    const ids = { snap: 1, pack: 1 };
    await engine(sp, ids).run(harness.context(), siteObject, {});
    documents.refuse = 403;
    const second = await engine(sp, ids).run(harness.context({ jobId: "job-2" }), siteObject, {});
    expect(second.failures).toEqual([expect.objectContaining({ itemRef: "Libraries/Documents" })]);
    const manifest = await harness.manifest(second);
    expect(
      (await harness.readObject(at(manifest, "Libraries/Documents/readme.txt"))).toString(),
    ).toBe("hello sales");
    expect(manifest.objects.map((object) => object.path)).toContain(
      "Libraries/Site Pages/Home.aspx",
    );
  });

  it("reports a list Graph refuses and keeps the items it had", async () => {
    const { sp, tasks } = world();
    const ids = { snap: 1, pack: 1 };
    await engine(sp, ids).run(harness.context(), siteObject, {});
    tasks.refuse = 403;
    const second = await engine(sp, ids).run(harness.context({ jobId: "job-2" }), siteObject, {});
    expect(second.failures.map((failure) => failure.itemRef)).toEqual(["Lists/Team Tasks"]);
    const manifest = await harness.manifest(second);
    expect(at(manifest, "Lists/Team Tasks/1.json").metadata?.stale).toBe("true");
    expect(manifest.objects.map((object) => object.path)).toContain("Lists/Team Tasks/_list.json");
  });

  it("fails with SiteUnavailableError when the site is gone", async () => {
    const sp = new FakeSharePoint();
    await expect(engine(sp).run(harness.context(), siteObject, {})).rejects.toBeInstanceOf(
      SiteUnavailableError,
    );
  });

  it("resumes after an interruption without walking finished libraries again", async () => {
    const { sp } = world();
    const ids = { snap: 1, pack: 1 };
    const controller = new AbortController();
    const ctx = harness.context({
      signal: controller.signal,
      onProgress: (update) => {
        // Stop as soon as the second library starts.
        if (update.snapshot.done >= 3) controller.abort();
      },
    });
    await expect(engine(sp, ids).run(ctx, siteObject, {})).rejects.toBeInstanceOf(JobAbortedError);
    sp.graph.calls.length = 0;
    const result = await engine(sp, ids).run(harness.context(), siteObject, {});
    expect(result.snapshotId).toBe("snap-1");
    const deltaCalls = sp.graph.calls.filter((call) => call.url.includes("/root/delta"));
    expect(deltaCalls.every((call) => !call.url.includes("b!docs"))).toBe(true);
    const manifest = await harness.manifest(result);
    expect(manifest.objects.map((object) => object.path)).toContain(
      "Libraries/Documents/Reports/Q3.xlsx",
    );
    expect(manifest.objects.map((object) => object.path)).toContain("Lists/Team Tasks/3.json");
  });
});
