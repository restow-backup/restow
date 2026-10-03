import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryLogger } from "./logger.js";
import { pendingSteps } from "./protocol.js";
import type { Run } from "./protocol.js";
import { Redactor } from "./redact.js";
import {
  EVENT_LIMIT,
  HISTORY_LIMIT,
  STATE_FILE,
  StatusStore,
  initialState,
  parseState,
} from "./store.js";

let dir: string;
const redactor = new Redactor();

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "restow-updater-store-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function sampleRun(id: string): Run {
  const at = "2026-09-30T10:00:00.000Z";
  return {
    id,
    mode: "image",
    switchTo: null,
    fromVersion: "0.1.0",
    targetVersion: "0.2.0",
    targetTag: "v0.2.0",
    releaseUrl: null,
    requestedBy: { userId: null, label: "system", ip: null },
    scheduledAt: at,
    leadSeconds: 0,
    startsAt: at,
    startedAt: null,
    finishedAt: null,
    cancelledAt: null,
    outcome: null,
    step: null,
    steps: pendingSteps(),
    progress: 0,
    message: null,
    failure: null,
    recovery: null,
    images: { app: null, web: null },
    digestVerified: null,
    signatureVerified: null,
    log: ["line"],
    cancelled: false,
  };
}

async function open(): Promise<StatusStore> {
  return await StatusStore.open(
    dir,
    memoryLogger(redactor),
    () => new Date("2026-09-30T10:00:00Z"),
  );
}

describe("StatusStore", () => {
  it("starts idle when there is no file and does not create one until saved", async () => {
    const store = await open();
    expect(store.state).toEqual(initialState());
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("writes atomically, readable with mode 0600, and reads back what it wrote", async () => {
    const store = await open();
    store.state.run = sampleRun("r-1");
    store.state.phase = "scheduled";
    await store.save();
    expect(await fs.readdir(dir)).toEqual([STATE_FILE]);
    expect((await fs.stat(path.join(dir, STATE_FILE))).mode & 0o777).toBe(0o600);
    const reopened = await open();
    expect(reopened.state.phase).toBe("scheduled");
    expect(reopened.state.run?.id).toBe("r-1");
    expect(reopened.state.run?.log).toEqual(["line"]);
  });

  it("keeps writes in order even when they are started together", async () => {
    const store = await open();
    const writes: Promise<void>[] = [];
    for (let index = 0; index < 20; index++) {
      store.state.eventCounter = index;
      writes.push(store.save());
    }
    await Promise.all(writes);
    expect((await open()).state.eventCounter).toBe(19);
    expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("limits history and events on save", async () => {
    const store = await open();
    for (let index = 0; index < 15; index++) {
      store.recordHistory(sampleRun(`r-${index}`));
    }
    for (let index = 0; index < 260; index++) {
      store.addEvent(
        {
          at: "2026-09-30T10:00:00.000Z",
          action: "update.started",
          runId: "r-1",
          actor: { userId: null, label: "system", ip: null },
          target: "0.2.0",
          details: {},
        },
        1_000 + index,
      );
    }
    await store.save();
    const reopened = await open();
    expect(reopened.state.history).toHaveLength(HISTORY_LIMIT);
    expect(reopened.state.history[0]?.id).toBe("r-14");
    expect("log" in (reopened.state.history[0] ?? {})).toBe(false);
    expect(reopened.state.events).toHaveLength(EVENT_LIMIT);
    expect(reopened.state.eventCounter).toBe(260);
  });

  it("replaces a history entry with the same id instead of duplicating it", async () => {
    const store = await open();
    store.recordHistory(sampleRun("r-1"));
    const changed = sampleRun("r-1");
    changed.outcome = "succeeded";
    store.recordHistory(changed);
    expect(store.state.history).toHaveLength(1);
    expect(store.state.history[0]?.outcome).toBe("succeeded");
  });

  it("generates event ids that sort chronologically, also when the clock steps back", async () => {
    const store = await open();
    const base = {
      at: "2026-09-30T10:00:00.000Z",
      action: "update.started" as const,
      runId: "r-1",
      actor: { userId: null, label: "system", ip: null },
      target: "0.2.0",
      details: {},
    };
    const ids = [
      store.addEvent(base, 1_790_000_000_000).id,
      store.addEvent(base, 1_790_000_000_000).id,
      store.addEvent(base, 1_789_000_000_000).id,
      store.addEvent(base, 1_790_000_005_000).id,
    ];
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(4);
    expect(ids[0]).toMatch(/^\d{15}-\d{6}$/);
  });

  describe("unreadable state", () => {
    const cases: [string, string][] = [
      ["truncated JSON", '{"schemaVersion":1,"pha'],
      ["not JSON at all", "garbage \u0000\u0001"],
      ["a wrong schema version", JSON.stringify({ ...initialState(), schemaVersion: 2 })],
      ["a running phase without a run", JSON.stringify({ ...initialState(), phase: "running" })],
      ["an unknown phase", JSON.stringify({ ...initialState(), phase: "exploded" })],
      ["an empty file", ""],
    ];

    it.each(cases)("moves aside %s and continues idle", async (_name, content) => {
      await fs.writeFile(path.join(dir, STATE_FILE), content);
      const logger = memoryLogger(redactor);
      const store = await StatusStore.open(dir, logger, () => new Date("2026-09-30T10:00:00Z"));
      expect(store.state).toEqual(initialState());
      expect(store.recoveredFrom).toBe(
        `${STATE_FILE}.corrupt-${Date.parse("2026-09-30T10:00:00Z")}`,
      );
      expect(await fs.readFile(path.join(dir, store.recoveredFrom as string), "utf8")).toBe(
        content,
      );
      expect(
        logger.lines.some((line) => line.startsWith("ERROR") && line.includes("Continuing idle")),
      ).toBe(true);
      // A later save creates a fresh file next to the preserved one.
      await store.save();
      expect((await open()).state.phase).toBe("idle");
    });

    it("keeps only the newest five broken files", async () => {
      for (let index = 0; index < 8; index++) {
        await fs.writeFile(path.join(dir, `${STATE_FILE}.corrupt-${1000 + index}`), "x");
      }
      await fs.writeFile(path.join(dir, STATE_FILE), "broken");
      await open();
      const names = (await fs.readdir(dir)).filter((name) => name.includes(".corrupt-"));
      expect(names).toHaveLength(5);
      expect(names).toContain(`${STATE_FILE}.corrupt-${Date.parse("2026-09-30T10:00:00Z")}`);
    });
  });

  it("parseState explains where the document is wrong without echoing values", () => {
    const result = parseState(JSON.stringify({ ...initialState(), phase: "secret-value-here" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("phase");
      expect(result.reason).not.toContain("secret-value-here");
    }
  });
});
