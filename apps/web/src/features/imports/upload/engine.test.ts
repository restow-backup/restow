import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createUploadTransport } from "../api";
import { type FakeImportApi, createFakeImportApi, textFile } from "../testing/fake-import-api";
import type { ImportUploadDto } from "../types";
import { UploadEngine, bytesOfSegments, defaultBackoffMs } from "./engine";
import type { UploadEvent } from "./types";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

let fake: FakeImportApi;
let events: UploadEvent[];
let sleeps: number[];

function makeEngine(overrides: Partial<ConstructorParameters<typeof UploadEngine>[0]> = {}) {
  return new UploadEngine({
    transport: createUploadTransport("tenant-1"),
    onEvent: (event) => events.push(event),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
}

const kinds = () => events.map((event) => event.type);
const last = () => events[events.length - 1];

/** An MBOX-looking text of exactly `size` bytes (a multiple of the 8 byte test segments gives whole segments). */
function bigMbox(size: number): string {
  return `From x\n${"a".repeat(size - 8)}\n`;
}

beforeEach(() => {
  fake = createFakeImportApi();
  events = [];
  sleeps = [];
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("segmenting", () => {
  it("cuts a file into segments of the size the server chose and hashes every one", async () => {
    const engine = makeEngine();
    // 21 bytes at 8 per segment: 8 + 8 + 5.
    engine.enqueue({ localId: "a", file: textFile("mail.eml", "Subject: hello world\n") });
    await engine.idle();

    const puts = fake.callsTo(/^PUT \/imports\/uploads\/u1\/segments\/\d+$/);
    // Three slots run side by side, so the order they arrive in is not fixed.
    expect(puts.map((call) => call.path.split("/").pop()).sort()).toEqual(["0", "1", "2"]);
    expect(puts.map((call) => call.bytes).sort((a, b) => a - b)).toEqual([5, 8, 8]);
    const text = "Subject: hello world\n";
    const byIndex = new Map(puts.map((call) => [Number(call.path.split("/").pop()), call]));
    expect(byIndex.get(0)?.headers["x-segment-sha256"]).toBe(sha256(text.slice(0, 8)));
    expect(byIndex.get(1)?.headers["x-segment-sha256"]).toBe(sha256(text.slice(8, 16)));
    expect(byIndex.get(2)?.headers["x-segment-sha256"]).toBe(sha256(text.slice(16)));
    expect(puts[0]?.headers["content-type"]).toBe("application/octet-stream");
    expect(puts[0]?.headers["x-restow-tenant"]).toBe("tenant-1");

    expect(kinds()).toEqual([
      "opening",
      "started",
      "segment",
      "segment",
      "segment",
      "completing",
      "ready",
    ]);
    const done = events.filter((event) => event.type === "segment");
    expect(done.reduce((sum, event) => sum + (event.type === "segment" ? event.bytes : 0), 0)).toBe(
      21,
    );
    expect(last()).toMatchObject({ type: "ready", upload: { detectedFormat: "eml" } });
  });

  it("asks for the configured segment size when creating the upload", async () => {
    const engine = makeEngine({ segmentSize: 8 });
    engine.enqueue({ localId: "a", file: textFile("mail.eml", "Subject: x\n") });
    await engine.idle();
    const create = fake.callsTo(/^POST \/imports\/uploads$/);
    expect(create).toHaveLength(1);
  });

  it("computes the byte size of segments including a short last one", () => {
    expect(bytesOfSegments([0, 1, 2], 20, 8)).toBe(20);
    expect(bytesOfSegments([2], 20, 8)).toBe(4);
    expect(bytesOfSegments([], 20, 8)).toBe(0);
  });

  it("sends without the hash header when no hash can be computed", async () => {
    const engine = makeEngine({ hash: async () => null });
    engine.enqueue({ localId: "a", file: textFile("mail.eml", "Subject: x\n") });
    await engine.idle();
    const puts = fake.callsTo(/^PUT /);
    expect(puts.length).toBeGreaterThan(0);
    for (const call of puts) {
      expect(call.headers["x-segment-sha256"]).toBeUndefined();
    }
    expect(last()?.type).toBe("ready");
  });
});

describe("concurrency", () => {
  it("keeps at most three segments in flight, and uses all three", async () => {
    const engine = makeEngine();
    // 96 bytes: 12 segments.
    engine.enqueue({ localId: "a", file: textFile("big.mbox", bigMbox(96)) });
    await engine.idle();
    expect(fake.callsTo(/^PUT /)).toHaveLength(12);
    expect(fake.maxInFlight).toBe(3);
    expect(last()?.type).toBe("ready");
  });

  it("shares the three slots between files", async () => {
    const engine = makeEngine();
    for (const name of ["a.eml", "b.eml", "c.eml", "d.eml"]) {
      engine.enqueue({
        localId: name,
        file: textFile(name, `Subject: ${name}${"x".repeat(40)}\n`),
      });
    }
    await engine.idle();
    expect(fake.maxInFlight).toBeLessThanOrEqual(3);
    expect(events.filter((event) => event.type === "ready")).toHaveLength(4);
  });
});

describe("retries", () => {
  it("retries a segment with a growing pause and then succeeds", async () => {
    fake.failWith({ match: /^PUT .*\/segments\/1$/, times: 2, respond: 503 });
    const engine = makeEngine();
    engine.enqueue({ localId: "a", file: textFile("mail.eml", "Subject: hello world\n") });
    await engine.idle();

    expect(fake.callsTo(/^PUT .*\/segments\/1$/)).toHaveLength(3);
    expect(sleeps).toEqual([defaultBackoffMs(0), defaultBackoffMs(1)]);
    expect(sleeps).toEqual([500, 1000]);
    const retrying = events.filter((event) => event.type === "retrying");
    expect(retrying).toMatchObject([
      { index: 1, attempt: 1, delayMs: 500 },
      { index: 1, attempt: 2, delayMs: 1000 },
    ]);
    expect(last()?.type).toBe("ready");
  });

  it("retries after a lost connection", async () => {
    fake.failWith({ match: /^PUT .*\/segments\/0$/, respond: "network" });
    const engine = makeEngine();
    engine.enqueue({ localId: "a", file: textFile("mail.eml", "Subject: hi\n") });
    await engine.idle();
    expect(fake.callsTo(/^PUT .*\/segments\/0$/)).toHaveLength(2);
    expect(last()?.type).toBe("ready");
  });

  it("retries a segment the server found damaged in transit", async () => {
    fake.failWith({
      match: /^PUT .*\/segments\/0$/,
      respond: 422,
      problemType: "urn:restow:problem:import-segment-corrupt",
    });
    const engine = makeEngine();
    engine.enqueue({ localId: "a", file: textFile("mail.eml", "Subject: hi\n") });
    await engine.idle();
    expect(fake.callsTo(/^PUT .*\/segments\/0$/)).toHaveLength(2);
    expect(last()?.type).toBe("ready");
  });

  it("gives up after three retries and reports why", async () => {
    fake.failWith({ match: /^PUT .*\/segments\/0$/, times: 10, respond: 503 });
    const engine = makeEngine();
    engine.enqueue({ localId: "a", file: textFile("mail.eml", "Subject: hi\n") });
    await engine.idle();
    // The first try plus three retries.
    expect(fake.callsTo(/^PUT .*\/segments\/0$/)).toHaveLength(4);
    expect(last()).toEqual({ type: "failed", localId: "a", code: "network" });
    expect(kinds()).not.toContain("ready");
  });

  it("reports a server error after the retries when the API answers 500", async () => {
    fake.failWith({ match: /^PUT .*\/segments\/0$/, times: 10, respond: 500 });
    const engine = makeEngine();
    engine.enqueue({ localId: "a", file: textFile("mail.eml", "Subject: hi\n") });
    await engine.idle();
    expect(last()).toEqual({ type: "failed", localId: "a", code: "server" });
  });

  it("does not retry an expired session", async () => {
    fake.failWith({ match: /^PUT /, times: 10, respond: 401 });
    const engine = makeEngine();
    engine.enqueue({ localId: "a", file: textFile("mail.eml", "Subject: hi\n") });
    await engine.idle();
    // Two segments start together; neither is tried a second time.
    expect(fake.callsTo(/^PUT /).length).toBeLessThanOrEqual(2);
    expect(sleeps).toEqual([]);
    expect(last()).toEqual({ type: "failed", localId: "a", code: "unauthorized" });
  });

  it("stops the other segments of a file once one fails for good", async () => {
    fake.failWith({ match: /^PUT .*\/segments\/0$/, times: 10, respond: 401 });
    const engine = makeEngine();
    engine.enqueue({ localId: "a", file: textFile("big.mbox", bigMbox(96)) });
    await engine.idle();
    // Three segments were already in flight; no further one starts after the failure.
    expect(fake.callsTo(/^PUT /).length).toBeLessThanOrEqual(3);
    expect(events.filter((event) => event.type === "failed")).toHaveLength(1);
  });
});

describe("refusals before and after sending", () => {
  it("reports a full staging area as its own code, without trying again", async () => {
    fake.failWith({
      match: /^POST \/imports\/uploads$/,
      times: 5,
      respond: 422,
      problemType: "urn:restow:problem:import-staging-full",
    });
    const engine = makeEngine();
    engine.enqueue({ localId: "a", file: textFile("mail.eml", "Subject: hi\n") });
    await engine.idle();
    expect(last()).toEqual({ type: "failed", localId: "a", code: "staging_full" });
    expect(fake.callsTo(/^POST \/imports\/uploads$/)).toHaveLength(1);
    expect(fake.callsTo(/^PUT /)).toHaveLength(0);
  });

  it("shows the limit when the server answers 413", async () => {
    fake = createFakeImportApi({ maxFileBytes: 4 });
    vi.stubGlobal("fetch", fake.fetch);
    const engine = makeEngine();
    engine.enqueue({ localId: "a", file: textFile("mail.eml", "Subject: hi\n") });
    await engine.idle();
    expect(last()).toEqual({ type: "failed", localId: "a", code: "too_large" });
    expect(fake.callsTo(/^PUT /)).toHaveLength(0);
  });

  it("does not send a file above the known limit at all", async () => {
    const engine = makeEngine({ maxFileBytes: 4 });
    engine.enqueue({ localId: "a", file: textFile("mail.eml", "Subject: hi\n") });
    await engine.idle();
    expect(last()).toEqual({ type: "failed", localId: "a", code: "too_large" });
    expect(fake.calls).toHaveLength(0);
  });

  it("does not send an empty file", async () => {
    const engine = makeEngine();
    engine.enqueue({ localId: "a", file: textFile("empty.eml", "") });
    await engine.idle();
    expect(last()).toEqual({ type: "failed", localId: "a", code: "empty" });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a PST file after upload, with the reason, and frees its staging area", async () => {
    const engine = makeEngine();
    engine.enqueue({ localId: "a", file: textFile("archive.pst", "!BDN....binary....") });
    await engine.idle();

    const refused = events.find((event) => event.type === "refused");
    expect(refused).toMatchObject({
      type: "refused",
      localId: "a",
      upload: { detectedFormat: "pst", refusal: { code: "pst_not_supported" } },
    });
    expect(kinds()).not.toContain("ready");
    expect(fake.callsTo(/^DELETE \/imports\/uploads\/u1$/)).toHaveLength(1);
  });

  it("refuses a file that is not a mail file", async () => {
    const engine = makeEngine();
    engine.enqueue({ localId: "a", file: textFile("photo.jpg", "\u0000\u0001\u0002 not mail") });
    await engine.idle();
    expect(events.find((event) => event.type === "refused")).toMatchObject({
      upload: { refusal: { code: "unrecognised" } },
    });
  });
});

describe("resuming", () => {
  const partial = (overrides: Partial<ImportUploadDto> = {}): ImportUploadDto => ({
    id: "old",
    fileName: "mail.eml",
    size: 21,
    segmentSize: 8,
    segmentCount: 3,
    status: "uploading",
    receivedSegments: [0, 1],
    detectedFormat: null,
    refusal: null,
    expiresAt: "2026-10-02T10:00:00.000Z",
    ...overrides,
  });

  function seed(dto: ImportUploadDto, text: string) {
    fake = createFakeImportApi({ uploads: [dto] });
    const stored = fake.uploads.get(dto.id);
    for (const index of dto.receivedSegments) {
      stored?.segments.set(index, new TextEncoder().encode(text.slice(index * 8, index * 8 + 8)));
    }
    vi.stubGlobal("fetch", fake.fetch);
  }

  it("skips the segments the server already holds", async () => {
    const text = "Subject: hello world\n";
    seed(partial(), text);
    const engine = makeEngine();
    engine.enqueue({ localId: "a", file: textFile("mail.eml", text), resume: partial() });
    await engine.idle();

    expect(fake.callsTo(/^PUT /).map((call) => call.path)).toEqual([
      "/imports/uploads/old/segments/2",
    ]);
    expect(fake.callsTo(/^POST \/imports\/uploads$/)).toHaveLength(0);
    expect(events.find((event) => event.type === "started")).toMatchObject({
      uploadId: "old",
      resumed: true,
      receivedBytes: 16,
      receivedSegments: 2,
    });
    expect(last()).toMatchObject({ type: "ready", upload: { id: "old" } });
  });

  it("uses a finished upload as it is", async () => {
    const text = "Subject: hello world\n";
    seed(partial({ status: "ready", receivedSegments: [0, 1, 2], detectedFormat: "eml" }), text);
    const engine = makeEngine();
    engine.enqueue({
      localId: "a",
      file: textFile("mail.eml", text),
      resume: partial({ status: "ready", receivedSegments: [0, 1, 2], detectedFormat: "eml" }),
    });
    await engine.idle();
    expect(fake.callsTo(/^(PUT|POST) /)).toHaveLength(0);
    expect(last()).toMatchObject({ type: "ready", upload: { id: "old" } });
  });

  it("starts over when the earlier upload has expired", async () => {
    const engine = makeEngine();
    engine.enqueue({
      localId: "a",
      file: textFile("mail.eml", "Subject: hello world\n"),
      resume: partial({ id: "gone" }),
    });
    await engine.idle();
    expect(fake.callsTo(/^POST \/imports\/uploads$/)).toHaveLength(1);
    expect(fake.callsTo(/^PUT /)).toHaveLength(3);
    expect(events.find((event) => event.type === "started")).toMatchObject({ resumed: false });
    expect(last()?.type).toBe("ready");
  });

  it("does not continue an upload of a different size", async () => {
    seed(partial({ size: 99 }), "x");
    const engine = makeEngine();
    engine.enqueue({
      localId: "a",
      file: textFile("mail.eml", "Subject: hello world\n"),
      resume: partial({ size: 99 }),
    });
    await engine.idle();
    expect(fake.callsTo(/^POST \/imports\/uploads$/)).toHaveLength(1);
  });

  it("sends segments the server reports missing when completing, then completes again", async () => {
    fake.failWith({
      match: /^POST .*\/complete$/,
      respond: 409,
      problemType: "urn:restow:problem:import-upload-incomplete",
      extensions: { missing: [1] },
    });
    const engine = makeEngine();
    engine.enqueue({ localId: "a", file: textFile("mail.eml", "Subject: hello world\n") });
    await engine.idle();
    expect(fake.callsTo(/^PUT .*\/segments\/1$/)).toHaveLength(2);
    expect(fake.callsTo(/^POST .*\/complete$/)).toHaveLength(2);
    expect(last()?.type).toBe("ready");
  });
});

describe("cancelling", () => {
  it("aborts, deletes the upload on the server and reports it", async () => {
    const engine = makeEngine({
      onEvent: (event) => {
        events.push(event);
        if (event.type === "segment" && events.filter((e) => e.type === "segment").length === 1) {
          void engine.cancel("a");
        }
      },
    });
    engine.enqueue({ localId: "a", file: textFile("big.mbox", bigMbox(96)) });
    await engine.idle();
    await engine.cancel("a");

    expect(fake.callsTo(/^DELETE \/imports\/uploads\/u1$/)).toHaveLength(1);
    expect(kinds()).toContain("cancelled");
    expect(kinds()).not.toContain("ready");
    expect(kinds()).not.toContain("failed");
    expect(fake.callsTo(/^POST .*\/complete$/)).toHaveLength(0);
  });

  it("drops a queued file without touching the server", async () => {
    const engine = makeEngine({ concurrency: 1 });
    engine.enqueue({ localId: "a", file: textFile("a.eml", "Subject: a\n") });
    engine.enqueue({ localId: "b", file: textFile("b.eml", "Subject: b\n") });
    await engine.cancel("b");
    await engine.idle();
    expect(events.filter((event) => event.localId === "b").map((event) => event.type)).toEqual([
      "cancelled",
    ]);
    expect(fake.callsTo(/^POST \/imports\/uploads$/)).toHaveLength(1);
  });

  it("cancelAll deletes every unfinished upload", async () => {
    const engine = makeEngine({
      onEvent: (event) => {
        events.push(event);
        if (event.type === "started") {
          void engine.cancelAll();
        }
      },
    });
    engine.enqueue({ localId: "a", file: textFile("a.mbox", `From x\n${"a".repeat(60)}\n`) });
    engine.enqueue({ localId: "b", file: textFile("b.mbox", `From x\n${"b".repeat(60)}\n`) });
    await engine.idle();
    await engine.cancelAll();
    expect(fake.callsTo(/^DELETE /).length).toBeGreaterThanOrEqual(1);
    expect(kinds()).not.toContain("ready");
  });

  it("suspend stops the requests but leaves the upload on the server to resume", async () => {
    const engine = makeEngine({
      onEvent: (event) => {
        events.push(event);
        if (event.type === "segment") {
          engine.suspend();
        }
      },
    });
    engine.enqueue({ localId: "a", file: textFile("big.mbox", bigMbox(96)) });
    await engine.idle();
    expect(fake.callsTo(/^DELETE /)).toHaveLength(0);
    expect(fake.callsTo(/^POST .*\/complete$/)).toHaveLength(0);
    expect(fake.uploads.get("u1")?.dto.status).toBe("uploading");
  });
});

describe("running a failed file again", () => {
  it("continues the same upload where it stopped", async () => {
    // Fails for good on segment 2: the first try plus three retries.
    fake.failWith({ match: /^PUT .*\/segments\/2$/, times: 4, respond: 500 });
    const engine = makeEngine();
    const file = textFile("mail.eml", "Subject: hello world\n");
    engine.enqueue({ localId: "a", file });
    await engine.idle();
    expect(last()).toEqual({ type: "failed", localId: "a", code: "server" });

    events.length = 0;
    fake.calls.length = 0;
    engine.enqueue({ localId: "a", file });
    await engine.idle();

    expect(fake.callsTo(/^POST \/imports\/uploads$/)).toHaveLength(0);
    expect(fake.callsTo(/^PUT /).map((call) => call.path)).toEqual([
      "/imports/uploads/u1/segments/2",
    ]);
    expect(events.find((event) => event.type === "started")).toMatchObject({
      uploadId: "u1",
      resumed: true,
      receivedBytes: 16,
    });
    expect(last()?.type).toBe("ready");
  });

  it("ignores an enqueue for a file that is still running", async () => {
    const engine = makeEngine();
    const file = textFile("mail.eml", "Subject: hello world\n");
    engine.enqueue({ localId: "a", file });
    engine.enqueue({ localId: "a", file });
    await engine.idle();
    expect(fake.callsTo(/^POST \/imports\/uploads$/)).toHaveLength(1);
  });
});
