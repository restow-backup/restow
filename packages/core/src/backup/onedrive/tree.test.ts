import { describe, expect, it } from "vitest";
import type { ManifestObject } from "../../manifest.js";
import { ONEDRIVE_OBJECT_TYPES, versionObjectId, versionPath } from "./items.js";
import { DriveTree } from "./tree.js";

const ROOT = "ROOT";

function folder(id: string, path: string, parentId: string): ManifestObject {
  return {
    id,
    path,
    type: ONEDRIVE_OBJECT_TYPES.folder,
    size: 0,
    mtime: 1,
    metadata: { parentId },
    chunks: [],
  };
}

function file(id: string, path: string, parentId: string, chunk = "ab"): ManifestObject {
  return {
    id,
    path,
    type: ONEDRIVE_OBJECT_TYPES.file,
    size: 3,
    mtime: 1,
    metadata: { parentId },
    chunks: [chunk.repeat(32)],
  };
}

function version(itemId: string, filePath: string, versionId: string): ManifestObject {
  return {
    id: versionObjectId(itemId, versionId),
    path: versionPath(filePath, versionId),
    type: ONEDRIVE_OBJECT_TYPES.version,
    size: 2,
    mtime: 1,
    metadata: { itemId, versionId },
    chunks: ["cd".repeat(32)],
  };
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Put an object the way the run does: parent from metadata, name from the path. */
function put(tree: DriveTree, object: ManifestObject): void {
  if (object.type === ONEDRIVE_OBJECT_TYPES.version) {
    tree.put(object, {
      parentId: object.metadata?.itemId ?? null,
      name: object.metadata?.versionId ?? "",
    });
    return;
  }
  tree.put(object, { parentId: object.metadata?.parentId ?? null, name: nameOf(object.path) });
}

function paths(tree: DriveTree, cascadeDeletions = true): string[] {
  return tree
    .materialize({ cascadeDeletions })
    .objects.map((o) => o.path)
    .sort();
}

/** Documents/Reports/q3.xlsx (+ one version) and notes.txt. */
function sampleObjects(): ManifestObject[] {
  return [
    folder("DOCS", "Documents", ROOT),
    folder("REPORTS", "Documents/Reports", "DOCS"),
    file("Q3", "Documents/Reports/q3.xlsx", "REPORTS"),
    version("Q3", "Documents/Reports/q3.xlsx", "1.0"),
    file("NOTES", "notes.txt", ROOT),
  ];
}

function sampleTree(): DriveTree {
  return DriveTree.fromObjects(sampleObjects(), { rootId: ROOT });
}

describe("DriveTree", () => {
  it("rebuilds a manifest's objects unchanged and knows every item's path", () => {
    const tree = sampleTree();
    expect(tree.size).toBe(5);
    expect(tree.materialize({ cascadeDeletions: true }).objects).toEqual(sampleObjects());
    expect(tree.pathOf("REPORTS")).toBe("Documents/Reports");
    expect(tree.pathOf(ROOT)).toBe("");
    expect(tree.pathOf("nope")).toBeUndefined();
    expect(tree.versionsOf("Q3").map((o) => o.id)).toEqual(["Q3#1.0"]);
  });

  it("places objects without a recorded parent by their path", () => {
    const objects = sampleObjects().map(({ metadata: _metadata, ...rest }) => rest);
    const tree = DriveTree.fromObjects(objects, { rootId: ROOT });
    put(tree, folder("REPORTS", "Documents/Archive", "DOCS"));
    expect(paths(tree)).toEqual([
      "Documents",
      "Documents/Archive",
      "Documents/Archive/q3.xlsx",
      "Documents/Archive/q3.xlsx:versions/1.0",
      "notes.txt",
    ]);
  });

  it("moves everything below a renamed folder with a single update", () => {
    const tree = sampleTree();
    put(tree, folder("REPORTS", "Archive", ROOT));
    expect(paths(tree)).toEqual([
      "Archive",
      "Archive/q3.xlsx",
      "Archive/q3.xlsx:versions/1.0",
      "Documents",
      "notes.txt",
    ]);
    const q3 = tree.materialize({ cascadeDeletions: true }).objects.find((o) => o.id === "Q3");
    expect(q3?.chunks).toEqual(["ab".repeat(32)]);
  });

  it("moves a file together with its versions", () => {
    const tree = sampleTree();
    put(tree, file("Q3", "q3-final.xlsx", ROOT));
    expect(paths(tree)).toContain("q3-final.xlsx:versions/1.0");
    expect(paths(tree)).not.toContain("Documents/Reports/q3.xlsx");
  });

  it("cascades a deletion to everything below it at commit, not at a checkpoint", () => {
    const tree = sampleTree();
    tree.remove("DOCS");
    expect(paths(tree, false)).toEqual([
      "Documents/Reports",
      "Documents/Reports/q3.xlsx",
      "Documents/Reports/q3.xlsx:versions/1.0",
      "notes.txt",
    ]);
    const committed = tree.materialize({ cascadeDeletions: true });
    expect(committed.objects.map((o) => o.path)).toEqual(["notes.txt"]);
    expect(committed.cascaded).toBe(3);
    expect(tree.deletedIds()).toEqual(["DOCS"]);
  });

  it("keeps an item moved out of a deleted folder, whichever order the two arrive in", () => {
    for (const order of ["move-first", "delete-first"] as const) {
      const tree = sampleTree();
      const move = () => put(tree, folder("REPORTS", "Reports", ROOT));
      const del = () => tree.remove("DOCS");
      if (order === "move-first") {
        move();
        del();
      } else {
        del();
        move();
      }
      expect(paths(tree)).toEqual([
        "Reports",
        "Reports/q3.xlsx",
        "Reports/q3.xlsx:versions/1.0",
        "notes.txt",
      ]);
    }
  });

  it("lets a folder take over the name of a deleted one and keeps both families apart", () => {
    for (const order of ["move-first", "delete-first"] as const) {
      const tree = sampleTree();
      put(tree, file("DOCFILE", "Documents/readme.txt", "DOCS"));
      const move = () => put(tree, folder("REPORTS", "Documents", ROOT));
      const del = () => tree.remove("DOCS");
      if (order === "move-first") {
        move();
        del();
      } else {
        del();
        move();
      }
      expect(paths(tree)).toEqual([
        "Documents",
        "Documents/q3.xlsx",
        "Documents/q3.xlsx:versions/1.0",
        "notes.txt",
      ]);
    }
  });

  it("places a child that arrived before its parent once the parent is known", () => {
    const tree = new DriveTree(ROOT);
    put(tree, file("C", "Later/c.txt", "LATER"));
    expect(paths(tree)).toEqual(["Later/c.txt"]);
    put(tree, folder("LATER", "Renamed", ROOT));
    expect(paths(tree)).toEqual(["Renamed", "Renamed/c.txt"]);
  });

  it("forgets an item's deletion when the item comes back", () => {
    const tree = sampleTree();
    tree.remove("REPORTS");
    put(tree, folder("REPORTS", "Documents/Reports", "DOCS"));
    expect(paths(tree)).toContain("Documents/Reports/q3.xlsx");
    expect(tree.deletedIds()).toEqual([]);
  });

  it("keeps the most recently recorded item when two claim the same path", () => {
    const tree = sampleTree();
    put(tree, file("NOTES2", "notes.txt", ROOT, "ef"));
    const result = tree.materialize({ cascadeDeletions: true });
    expect(result.collisions).toEqual(["notes.txt"]);
    expect(result.objects.find((o) => o.path === "notes.txt")?.id).toBe("NOTES2");
  });

  it("survives inconsistent parent cycles by falling back to the last known path", () => {
    const tree = new DriveTree(ROOT);
    put(tree, folder("A", "A", "B"));
    put(tree, folder("B", "B", "A"));
    const result = tree.materialize({ cascadeDeletions: true });
    expect(result.objects).toHaveLength(2);
  });

  it("clears everything and hands back what it dropped", () => {
    const tree = sampleTree();
    tree.remove("NOTES");
    const dropped = tree.clear();
    expect(dropped.map((o) => o.id).sort()).toEqual(["DOCS", "Q3", "Q3#1.0", "REPORTS"]);
    expect(tree.size).toBe(0);
    expect(tree.deletedIds()).toEqual([]);
    expect(tree.versionsOf("Q3")).toEqual([]);
  });

  it("drops a removed version from its file's version list", () => {
    const tree = sampleTree();
    tree.remove("Q3#1.0");
    expect(tree.versionsOf("Q3")).toEqual([]);
    expect(paths(tree)).not.toContain("Documents/Reports/q3.xlsx:versions/1.0");
  });
});
