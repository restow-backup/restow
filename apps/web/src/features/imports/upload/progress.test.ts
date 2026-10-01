import { describe, expect, it } from "vitest";

import type { ImportUploadDto } from "../types";
import { SpeedMeter, itemRatio, overallProgress } from "./progress";
import { assignResumes, receivedRatio, resumableUploads } from "./resume";
import { readyUploadIds, uploadReducer } from "./state";
import type { UploadItem } from "./types";

function item(overrides: Partial<UploadItem>): UploadItem {
  return {
    localId: "a",
    name: "a.eml",
    size: 100,
    status: "uploading",
    uploadId: "u1",
    segmentCount: 4,
    segmentsDone: 0,
    uploadedBytes: 0,
    resumed: false,
    detectedFormat: null,
    refusal: null,
    error: null,
    retrying: null,
    ...overrides,
  };
}

describe("SpeedMeter", () => {
  it("has no speed before it has enough samples", () => {
    const meter = new SpeedMeter();
    expect(meter.bytesPerSecond(0)).toBeNull();
    meter.record(0, 0);
    expect(meter.bytesPerSecond(500)).toBeNull();
  });

  it("measures the slope over the window", () => {
    const meter = new SpeedMeter(10_000);
    meter.record(0, 0);
    meter.record(2_000, 2_000_000);
    meter.record(4_000, 4_000_000);
    expect(meter.bytesPerSecond(4_000)).toBe(1_000_000);
  });

  it("forgets what happened before the window", () => {
    const meter = new SpeedMeter(5_000);
    meter.record(0, 0);
    meter.record(1_000, 10_000_000); // a fast start
    meter.record(20_000, 10_100_000);
    meter.record(24_000, 10_500_000);
    const speed = meter.bytesPerSecond(24_000);
    expect(speed).toBeLessThan(200_000);
    expect(speed).toBeGreaterThan(0);
  });

  it("slows down while nothing arrives", () => {
    const meter = new SpeedMeter(10_000);
    meter.record(0, 0);
    meter.record(2_000, 2_000_000);
    const running = meter.bytesPerSecond(2_000) ?? 0;
    const stalled = meter.bytesPerSecond(6_000) ?? 0;
    expect(stalled).toBeLessThan(running);
  });

  it("starts over when the byte count falls (a new batch)", () => {
    const meter = new SpeedMeter();
    meter.record(0, 0);
    meter.record(2_000, 2_000);
    meter.record(3_000, 0);
    expect(meter.bytesPerSecond(3_000)).toBeNull();
  });
});

describe("overallProgress", () => {
  it("adds up bytes, ratio and the time left", () => {
    const progress = overallProgress(
      [
        item({ localId: "a", size: 100, status: "ready" }),
        item({ localId: "b", size: 300, status: "uploading", uploadedBytes: 100 }),
      ],
      50,
    );
    expect(progress).toMatchObject({
      files: 2,
      filesDone: 1,
      totalBytes: 400,
      uploadedBytes: 200,
      ratio: 0.5,
      bytesPerSecond: 50,
      etaSeconds: 4,
      busy: true,
    });
  });

  it("ignores cancelled files and reports failures", () => {
    const progress = overallProgress(
      [
        item({ localId: "a", status: "cancelled" }),
        item({ localId: "b", status: "failed", error: "network" }),
      ],
      null,
    );
    expect(progress).toMatchObject({ files: 1, filesFailed: 1, busy: false, etaSeconds: null });
  });

  it("counts a refused file as transferred", () => {
    const progress = overallProgress([item({ status: "refused" })], null);
    expect(progress).toMatchObject({ ratio: 1, filesDone: 1, busy: false });
  });

  it("gives every item its own ratio", () => {
    expect(itemRatio(item({ size: 200, uploadedBytes: 50 }))).toBe(0.25);
    expect(itemRatio(item({ status: "ready" }))).toBe(1);
  });
});

describe("upload state", () => {
  it("follows the events of a file from queue to ready", () => {
    let items = uploadReducer([], {
      type: "add",
      files: [{ localId: "a", name: "a.eml", size: 20 }],
    });
    expect(items[0]?.status).toBe("queued");
    const upload: ImportUploadDto = {
      id: "u1",
      fileName: "a.eml",
      size: 20,
      segmentSize: 8,
      segmentCount: 3,
      status: "ready",
      receivedSegments: [0, 1, 2],
      detectedFormat: "eml",
      refusal: null,
      expiresAt: "",
    };
    const events = [
      { type: "opening", localId: "a" },
      {
        type: "started",
        localId: "a",
        uploadId: "u1",
        segmentSize: 8,
        segmentCount: 3,
        receivedBytes: 8,
        receivedSegments: 1,
        resumed: true,
      },
      { type: "segment", localId: "a", index: 1, bytes: 8 },
      { type: "retrying", localId: "a", index: 2, attempt: 1, delayMs: 500 },
    ] as const;
    for (const event of events) {
      items = uploadReducer(items, { type: "event", event });
    }
    expect(items[0]).toMatchObject({
      status: "uploading",
      uploadedBytes: 16,
      segmentsDone: 2,
      resumed: true,
      retrying: { index: 2, attempt: 1, delayMs: 500 },
    });

    items = uploadReducer(items, { type: "event", event: { type: "completing", localId: "a" } });
    items = uploadReducer(items, { type: "event", event: { type: "ready", localId: "a", upload } });
    expect(items[0]).toMatchObject({
      status: "ready",
      uploadedBytes: 20,
      detectedFormat: "eml",
      retrying: null,
    });
    expect(readyUploadIds(items)).toEqual(["u1"]);
  });

  it("keeps a refused file out of the import", () => {
    let items = uploadReducer([], {
      type: "add",
      files: [{ localId: "a", name: "x.pst", size: 20 }],
    });
    items = uploadReducer(items, {
      type: "event",
      event: {
        type: "refused",
        localId: "a",
        upload: {
          id: "u1",
          fileName: "x.pst",
          size: 20,
          segmentSize: 8,
          segmentCount: 3,
          status: "ready",
          receivedSegments: [],
          detectedFormat: "pst",
          refusal: { code: "pst_not_supported", message: "later" },
          expiresAt: "",
        },
      },
    });
    expect(items[0]).toMatchObject({ status: "refused", refusal: { code: "pst_not_supported" } });
    expect(readyUploadIds(items)).toEqual([]);
  });

  it("resets, removes and clears", () => {
    let items = uploadReducer([], {
      type: "add",
      files: [
        { localId: "a", name: "a.eml", size: 1 },
        { localId: "b", name: "b.eml", size: 1 },
      ],
    });
    items = uploadReducer(items, {
      type: "event",
      event: { type: "failed", localId: "a", code: "network" },
    });
    expect(items[0]?.error).toBe("network");
    items = uploadReducer(items, { type: "reset", localId: "a" });
    expect(items[0]).toMatchObject({ status: "queued", error: null });
    items = uploadReducer(items, { type: "remove", localId: "a" });
    expect(items.map((entry) => entry.localId)).toEqual(["b"]);
    expect(uploadReducer(items, { type: "clear" })).toEqual([]);
  });

  it("adds an upload that is complete on the server", () => {
    const items = uploadReducer([], {
      type: "addReady",
      localId: "x",
      upload: {
        id: "u9",
        fileName: "big.mbox",
        size: 5000,
        segmentSize: 1000,
        segmentCount: 5,
        status: "ready",
        receivedSegments: [0, 1, 2, 3, 4],
        detectedFormat: "mbox",
        refusal: null,
        expiresAt: "",
      },
    });
    expect(items[0]).toMatchObject({
      status: "ready",
      uploadId: "u9",
      uploadedBytes: 5000,
      resumed: true,
    });
  });
});

describe("resuming by name and size", () => {
  const upload = (overrides: Partial<ImportUploadDto>): ImportUploadDto => ({
    id: "u",
    fileName: "a.mbox",
    size: 100,
    segmentSize: 10,
    segmentCount: 10,
    status: "uploading",
    receivedSegments: [],
    detectedFormat: null,
    refusal: null,
    expiresAt: "",
    ...overrides,
  });

  it("keeps unfinished and complete uploads, not refused or consumed ones", () => {
    const list = [
      upload({ id: "1" }),
      upload({ id: "2", status: "ready" }),
      upload({ id: "3", status: "consumed" }),
      upload({ id: "4", status: "cancelled" }),
      upload({ id: "5", status: "ready", refusal: { code: "pst_not_supported", message: "" } }),
    ];
    expect(resumableUploads(list).map((entry) => entry.id)).toEqual(["1", "2"]);
  });

  it("matches a picked file to the furthest upload of the same name and size", () => {
    const candidates = [
      upload({ id: "near", receivedSegments: [0, 1] }),
      upload({ id: "far", receivedSegments: [0, 1, 2, 3] }),
      upload({ id: "other-size", size: 99, receivedSegments: [0, 1, 2, 3, 4, 5] }),
    ];
    const [match] = assignResumes([{ name: "a.mbox", size: 100 }], candidates);
    expect(match?.resume?.id).toBe("far");
  });

  it("prefers a complete upload and uses each upload once", () => {
    const candidates = [
      upload({ id: "partial", receivedSegments: [0, 1, 2] }),
      upload({ id: "done", status: "ready" }),
    ];
    const matches = assignResumes(
      [
        { name: "a.mbox", size: 100 },
        { name: "a.mbox", size: 100 },
        { name: "a.mbox", size: 100 },
      ],
      candidates,
    );
    expect(matches.map((entry) => entry.resume?.id ?? null)).toEqual(["done", "partial", null]);
  });

  it("does not match by name alone", () => {
    const [match] = assignResumes([{ name: "b.mbox", size: 100 }], [upload({ id: "1" })]);
    expect(match?.resume).toBeNull();
  });

  it("reports how much the server holds", () => {
    expect(receivedRatio(upload({ receivedSegments: [0, 1, 2] }))).toBe(0.3);
    expect(receivedRatio(upload({ status: "ready" }))).toBe(1);
  });
});
