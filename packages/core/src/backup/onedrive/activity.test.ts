import { describe, expect, it } from "vitest";

import type { ManifestObject } from "../../manifest.js";
import { ActivityCollector } from "../../ransomware/activity.js";
import { ONEDRIVE_OBJECT_TYPES } from "./items.js";
import { driveActivity } from "./run.js";

function file(id: string, path: string, sha256: string): ManifestObject {
  return { id, path, type: ONEDRIVE_OBJECT_TYPES.file, sha256, size: 1, chunks: [] } as never;
}

function folder(id: string, path: string): ManifestObject {
  return { id, path, type: ONEDRIVE_OBJECT_TYPES.folder, chunks: [] } as never;
}

describe("what a OneDrive run changed, for the ransomware signals", () => {
  it("tells new, changed, renamed and removed files apart, and ignores folders", () => {
    const previous = new Map(
      [
        file("a", "Docs/a.docx", "1"),
        file("b", "Docs/b.xlsx", "2"),
        file("c", "Docs/c.pdf", "3"),
        file("d", "Docs/d.txt", "4"),
        file("e", "Docs/e.txt", "5"),
        folder("f", "Docs"),
      ].map((object) => [object.id as string, object]),
    );
    const report = driveActivity(previous, [
      folder("f", "Documents"),
      // Encrypted in place and renamed: a change and an extension rename.
      file("a", "Docs/a.docx.locked", "9"),
      // Renamed without a change of content: an extension rename.
      file("b", "Docs/b.xlsx.locked", "2"),
      // Moved: no rename that counts.
      file("c", "Archive/c.pdf", "3"),
      // Changed in place.
      file("d", "Docs/d.txt", "8"),
      file("n", "Docs/HOW_TO_DECRYPT.txt", "7"),
    ]);
    expect(report).toMatchObject({
      added: 1,
      modified: 2,
      removed: 1,
      renamed: 2,
      names: [{ value: "HOW_TO_DECRYPT.txt", count: 1 }],
    });
    expect(report.extensions).toContainEqual({ value: "locked", count: 2 });
  });

  it("keeps the entropy samples the run measured", () => {
    const collector = new ActivityCollector();
    collector.addEntropy({ path: "Docs/x.txt", ext: "txt", size: 10, head: 7.99, tail: null });
    expect(driveActivity(new Map(), [], collector).entropy).toHaveLength(1);
  });
});
