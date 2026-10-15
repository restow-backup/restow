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
      newBytes: null,
      compressionRatio: null,
      dedupRatio: null,
    });
    expect(endpointRunMetrics({ filesNew: 4 }).itemsChanged).toBe(4);
  });

  it("reads a file share runner's statistics", () => {
    expect(fileShareRunMetrics({ files: 300, filesNew: 2, filesChanged: 1, dataAdded: 7 })).toEqual(
      {
        itemsChanged: 3,
        itemsTotal: 300,
        bytesAdded: 7,
        activity: null,
        newBytes: 7,
        compressionRatio: null,
        dedupRatio: null,
      },
    );
  });

  it("reads a container's restic numbers and a VM's uploaded bytes", () => {
    expect(pveRunMetrics("ct", { resticBytesAdded: 99, uploadedBytes: 1 })).toEqual({
      itemsChanged: null,
      itemsTotal: null,
      bytesAdded: 99,
      activity: null,
      newBytes: 99,
      compressionRatio: null,
      dedupRatio: null,
    });
    expect(
      pveRunMetrics("ct", { resticFilesNew: 1, resticFilesChanged: 2, resticFilesTotal: 50 }),
    ).toMatchObject({ itemsChanged: 3, itemsTotal: 50 });
    expect(pveRunMetrics("vm", { uploadedBytes: 4096, activity })).toEqual({
      itemsChanged: null,
      itemsTotal: null,
      bytesAdded: 4096,
      activity: null,
      newBytes: null,
      compressionRatio: null,
      dedupRatio: null,
    });
  });

  it("reads a mailbox or OneDrive backup's result", () => {
    expect(
      m365RunMetrics({ snapshotId: "s", objectsWritten: 12, objectsTotal: 400, bytes: 100 }),
    ).toEqual({
      itemsChanged: 12,
      itemsTotal: 400,
      bytesAdded: 100,
      activity: null,
      newBytes: null,
      compressionRatio: null,
      dedupRatio: null,
    });
  });
});

describe("compression and deduplication of the new data, per source", () => {
  it("reads restic's packed and processed bytes (machines, file shares, containers)", () => {
    const summary = { dataAdded: 1000, dataAddedPacked: 400, totalBytesProcessed: 10_000 };
    expect(endpointRunMetrics(summary)).toMatchObject({
      newBytes: 1000,
      compressionRatio: 0.4,
      dedupRatio: 0.1,
    });
    expect(fileShareRunMetrics(summary)).toMatchObject({ compressionRatio: 0.4, dedupRatio: 0.1 });
    expect(
      pveRunMetrics("ct", {
        resticBytesAdded: 2000,
        resticBytesAddedPacked: 1990,
        resticTotalBytes: 4000,
      }),
    ).toMatchObject({ newBytes: 2000, compressionRatio: 0.995, dedupRatio: 0.5 });
  });

  it("reads the chunk store's statistics (VMs, mailboxes, OneDrive, SharePoint)", () => {
    expect(
      pveRunMetrics("vm", {
        uploadedBytes: 8000,
        chunkBytesIn: 8000,
        chunkBytesNew: 2000,
        chunkBytesSampled: 1000,
        chunkBytesSampledCompressed: 300,
      }),
    ).toMatchObject({ bytesAdded: 8000, newBytes: 2000, compressionRatio: 0.3, dedupRatio: 0.25 });
    expect(
      m365RunMetrics({
        bytes: 500,
        chunkStats: {
          bytesIn: 1000,
          bytesNew: 500,
          bytesSampled: 500,
          bytesSampledCompressed: 499,
        },
      }),
    ).toMatchObject({ newBytes: 500, compressionRatio: 0.998, dedupRatio: 0.5 });
  });

  it("has no ratio when nothing was added or processed", () => {
    expect(
      endpointRunMetrics({ dataAdded: 0, dataAddedPacked: 0, totalBytesProcessed: 0 }),
    ).toMatchObject({ compressionRatio: null, dedupRatio: null });
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
    expect(
      describeFinding({
        code: "incompressible_data",
        value: 0.998,
        threshold: 0.95,
        baseline: 0.45,
        bytes: 4 * 1024 ** 3,
      }),
    ).toBe("4294967296 bytes of new data do not compress (99.8 % of their size), usually 45 %");
    expect(
      describeFinding({ code: "dedup_collapse", value: 0.99, threshold: 0.8, baseline: 0.4 }),
    ).toBe("99 % of the data read was new (nothing deduplicated), usually 40 %");
  });
});
