import { describe, expect, it } from "vitest";

import {
  endpointRunMetrics,
  fileShareRunMetrics,
  m365RunMetrics,
  pveRunMetrics,
} from "./metrics.js";
import { describeFinding } from "./scan.js";

const activity = { v: 1, added: 3, removed: 1, renamed: 0, extensions: [], names: [] };

describe("the numbers of a run, per kind", () => {
  it("reads a machine's restic summary and its agent's report", () => {
    expect(
      endpointRunMetrics({
        filesNew: 10,
        filesChanged: 5,
        dataAdded: 2048,
        totalFilesProcessed: 900,
        activity,
      }),
    ).toMatchObject({
      itemsChanged: 15,
      itemsTotal: 900,
      bytesAdded: 2048,
      activity: { v: 1, added: 3, removed: 1 },
    });
  });

  it("leaves out what an older agent or an empty run did not report", () => {
    expect(endpointRunMetrics(null)).toEqual({
      itemsChanged: null,
      itemsTotal: null,
      bytesAdded: null,
      activity: null,
    });
    expect(endpointRunMetrics({ filesNew: 4 }).itemsChanged).toBe(4);
  });

  it("reads a file share runner's statistics", () => {
    expect(fileShareRunMetrics({ files: 300, filesNew: 2, filesChanged: 1, dataAdded: 7 })).toEqual(
      { itemsChanged: 3, itemsTotal: 300, bytesAdded: 7, activity: null },
    );
  });

  it("reads a container's restic numbers and a VM's uploaded bytes", () => {
    expect(pveRunMetrics("ct", { resticBytesAdded: 99, uploadedBytes: 1 })).toEqual({
      itemsChanged: null,
      itemsTotal: null,
      bytesAdded: 99,
      activity: null,
    });
    expect(
      pveRunMetrics("ct", { resticFilesNew: 1, resticFilesChanged: 2, resticFilesTotal: 50 }),
    ).toMatchObject({ itemsChanged: 3, itemsTotal: 50 });
    expect(pveRunMetrics("vm", { uploadedBytes: 4096, activity })).toEqual({
      itemsChanged: null,
      itemsTotal: null,
      bytesAdded: 4096,
      activity: null,
    });
  });

  it("reads a mailbox or OneDrive backup's result", () => {
    expect(
      m365RunMetrics({ snapshotId: "s", objectsWritten: 12, objectsTotal: 400, bytes: 100 }),
    ).toEqual({ itemsChanged: 12, itemsTotal: 400, bytesAdded: 100, activity: null });
  });
});

describe("a finding in the notification's words", () => {
  it("names the numbers and a few examples", () => {
    expect(
      describeFinding({
        code: "ransom_notes",
        value: 40,
        threshold: 2,
        examples: ["HOW_TO_DECRYPT.txt"],
      }),
    ).toBe("40 files named like a ransom note (HOW_TO_DECRYPT.txt)");
    expect(
      describeFinding({ code: "mass_deletions", value: 3000, threshold: 1000, share: 0.6 }),
    ).toBe("3000 files deleted, 60 %");
    expect(
      describeFinding({ code: "change_rate_items", value: 9000, threshold: 1500, baseline: 300 }),
    ).toBe("9000 new or changed files, usually about 300");
  });
});
