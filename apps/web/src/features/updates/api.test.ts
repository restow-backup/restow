import { afterEach, describe, expect, it, vi } from "vitest";

import {
  UPDATE_MESSAGE_CODES,
  fetchEdgeStatus,
  idleMaintenance,
  parseMaintenance,
  parsePublicStatus,
} from "./api";

const STATUS = {
  phase: "running",
  runId: "r-1",
  outcome: null,
  targetVersion: "0.2.0",
  fromVersion: "0.1.0",
  startsAt: "2026-09-30T12:00:00.000Z",
  startedAt: "2026-09-30T12:00:01.000Z",
  finishedAt: null,
  step: "fetch",
  steps: [
    { id: "prepare", status: "done" },
    { id: "fetch", status: "running" },
  ],
  progress: 22,
  message: { code: "step.fetch.pulling", params: { image: "x", count: 3, bad: { nested: true } } },
  failureCode: null,
  serverTime: "2026-09-30T12:00:05.000Z",
};

describe("parsePublicStatus", () => {
  it("reads a public status", () => {
    expect(parsePublicStatus(STATUS)).toEqual({
      ...STATUS,
      // Only strings and numbers survive as message parameters.
      message: { code: "step.fetch.pulling", params: { image: "x", count: 3 } },
    });
  });

  it("refuses what is not a status (the app shell a dev server answers with, an error page)", () => {
    for (const payload of [null, undefined, "<html>", 42, [], {}, { phase: "bogus" }]) {
      expect(parsePublicStatus(payload), JSON.stringify(payload)).toBeNull();
    }
  });

  it("drops what it does not know and bounds the progress", () => {
    const parsed = parsePublicStatus({
      ...STATUS,
      outcome: "exploded",
      step: "nap",
      failureCode: "made.up",
      steps: [
        { id: "fetch", status: "running" },
        { id: "nap", status: "done" },
        "junk",
        { id: "stop", status: "bogus" },
      ],
      progress: 250,
      message: { code: "" },
    });
    expect(parsed).toMatchObject({
      outcome: null,
      step: null,
      failureCode: null,
      steps: [{ id: "fetch", status: "running" }],
      progress: 100,
      message: null,
    });
    expect(parsePublicStatus({ ...STATUS, progress: -5 })?.progress).toBe(0);
    expect(parsePublicStatus({ ...STATUS, progress: "many" })?.progress).toBe(0);
  });
});

describe("parseMaintenance", () => {
  it("adds the version the answering api runs", () => {
    expect(parseMaintenance({ ...STATUS, runningVersion: "0.1.0" })?.runningVersion).toBe("0.1.0");
    expect(parseMaintenance(STATUS)?.runningVersion).toBeNull();
    expect(parseMaintenance({ nope: true })).toBeNull();
  });

  it("starts from an idle view", () => {
    const idle = idleMaintenance(new Date("2026-09-30T12:00:00.000Z"));
    expect(idle).toMatchObject({ phase: "idle", runId: null, steps: [], runningVersion: null });
    expect(parseMaintenance(idle)).toEqual(idle);
  });
});

describe("fetchEdgeStatus", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(response: () => Promise<Response>) {
    const mock = vi.fn(response);
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  it("reads the status from the edge, outside the api path, without credentials", async () => {
    const mock = stub(
      async () =>
        new Response(JSON.stringify(STATUS), { headers: { "content-type": "application/json" } }),
    );
    expect((await fetchEdgeStatus())?.phase).toBe("running");
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/_maintenance/status");
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
  });

  it("is quiet when the edge is gone, restarting, or absent (development)", async () => {
    stub(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchEdgeStatus()).toBeNull();

    stub(async () => new Response("bad gateway", { status: 502 }));
    expect(await fetchEdgeStatus()).toBeNull();

    // The dev server answers every unknown path with the app shell.
    stub(async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }));
    expect(await fetchEdgeStatus()).toBeNull();

    stub(
      async () => new Response("{not json", { headers: { "content-type": "application/json" } }),
    );
    expect(await fetchEdgeStatus()).toBeNull();

    stub(async () => new Response("{}", { headers: { "content-type": "application/json" } }));
    expect(await fetchEdgeStatus()).toBeNull();
  });
});

describe("the message vocabulary", () => {
  it("lists every code once", () => {
    expect(new Set(UPDATE_MESSAGE_CODES).size).toBe(UPDATE_MESSAGE_CODES.length);
    expect(UPDATE_MESSAGE_CODES.length).toBeGreaterThan(30);
  });
});
