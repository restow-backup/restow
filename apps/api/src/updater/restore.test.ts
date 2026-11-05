import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redactor } from "./redact.js";
import { DatabaseRestorer, parseReport, RestoreRefusedError } from "./restore.js";
import type { RestoreCliResult, RestoreOps } from "./restore-ops.js";
import { emptyReport, type RestoreReport } from "./restore-report.js";
import { FakeClock } from "./testing.js";

/**
 * The restore from a dump (restore.ts) with fake Docker commands: worker and scheduler stop
 * before the dump is restored and start only after the activation, on a healthy api; a wrong
 * master key, a failed step and an abort drop the scratch database and start them again; an
 * updater restart in the middle starts nothing; unreachable targets must be accepted.
 */

const DUMP = "restow-20261105-120000-uploaded-to-0.5.0.dump";
const ACTOR = { userId: "u1", label: "setup wizard", ip: "203.0.113.7" };

function okReport(overrides: Partial<RestoreReport> = {}): RestoreReport {
  return {
    ...emptyReport({ dumpName: DUMP, shipped: 80, restored: 79, at: new Date(0) }),
    ok: true,
    restoreMode: { id: "rm-1", created: true },
    ...overrides,
  };
}

interface World {
  calls: string[];
  restorer: DatabaseRestorer;
  prepare: { report: RestoreReport | null; exitCode: number };
  make(): DatabaseRestorer;
}

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "restow-restore-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function world(): World {
  const calls: string[] = [];
  const prepare = { report: okReport() as RestoreReport | null, exitCode: 0 };
  const clock = new FakeClock();
  const restore: RestoreOps = {
    createScratch: async () => void calls.push("createScratch"),
    dropScratch: async () => void calls.push("dropScratch"),
    restoreDump: async (file) => void calls.push(`restoreDump ${path.basename(file)}`),
    restoreCli: async (action): Promise<RestoreCliResult> => {
      calls.push(`cli ${action}`);
      if (action === "prepare") {
        return {
          exitCode: prepare.exitCode,
          stdout: prepare.report ? `${JSON.stringify(prepare.report)}\n` : "",
          errorTail: "",
        };
      }
      return { exitCode: 0, stdout: '{"status":"activated","previous":null}\n', errorTail: "" };
    },
  };
  const make = () =>
    new DatabaseRestorer({
      ops: {
        composeStop: async (services) => void calls.push(`stop ${services.join(",")}`),
        composeUp: async (services) => void calls.push(`up ${services.join(",")}`),
        servicesState: async () => [
          { service: "api", state: "running", health: "healthy", exitCode: null },
        ],
      },
      restore,
      dumps: {
        pathOf: (name) => {
          if (!name.endsWith(".dump")) {
            throw new Error("not a dump");
          }
          return path.join(dir, name);
        },
        sizeOf: async (name) => (name === DUMP ? 1024 : null),
      },
      stateFile: path.join(dir, "restore.json"),
      clock,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      redactor: new Redactor(),
      otherActivity: () => null,
      healthTimeoutSeconds: 30,
    });
  return { calls, restorer: make(), prepare, make };
}

describe("restoring a dump through the updater", () => {
  it("stops worker and scheduler before the restore and starts them only after the activation", async () => {
    const w = world();
    await w.restorer.start({ dump: DUMP, requestedBy: ACTOR });
    await w.restorer.settled();
    expect(w.restorer.view()?.status).toBe("awaiting_confirmation");
    expect(w.calls).toEqual([
      "stop worker,scheduler",
      "createScratch",
      `restoreDump ${DUMP}`,
      "cli prepare",
    ]);
    await w.restorer.activate({ acceptUnreachable: false, requestedBy: ACTOR });
    await w.restorer.settled();
    expect(w.restorer.view()?.status).toBe("done");
    expect(w.calls.slice(4)).toEqual(["stop api", "cli activate", "up api", "up worker,scheduler"]);
    expect(w.restorer.active()).toBe(false);
  });

  it("refuses a wrong master key: the scratch database is dropped and the fresh installation runs again", async () => {
    const w = world();
    w.prepare.exitCode = 3;
    w.prepare.report = {
      ...okReport(),
      ok: false,
      refusal: { code: "master_key_mismatch", message: "RESTOW_MASTER_KEY does not open them." },
    };
    await w.restorer.start({ dump: DUMP, requestedBy: ACTOR });
    await w.restorer.settled();
    const record = w.restorer.view();
    expect(record?.status).toBe("refused");
    expect(record?.report?.refusal?.code).toBe("master_key_mismatch");
    expect(w.calls.slice(-2)).toEqual(["dropScratch", "up worker,scheduler"]);
    expect(w.calls).not.toContain("cli activate");
  });

  it("rolls back a failed prepare that printed no report", async () => {
    const w = world();
    w.prepare.report = null;
    w.prepare.exitCode = 1;
    await w.restorer.start({ dump: DUMP, requestedBy: ACTOR });
    await w.restorer.settled();
    expect(w.restorer.view()?.status).toBe("failed");
    expect(w.calls.slice(-2)).toEqual(["dropScratch", "up worker,scheduler"]);
  });

  it("aborts at the confirmation", async () => {
    const w = world();
    await w.restorer.start({ dump: DUMP, requestedBy: ACTOR });
    await w.restorer.settled();
    await w.restorer.abort({ requestedBy: ACTOR });
    await w.restorer.settled();
    expect(w.restorer.view()?.status).toBe("aborted");
    expect(w.calls.slice(-2)).toEqual(["dropScratch", "up worker,scheduler"]);
  });

  it("needs unreachable targets accepted before it activates", async () => {
    const w = world();
    w.prepare.report = okReport({
      storage: { checked: true, targets: [], unreachable: 1, ahead: 0, error: null },
    });
    await w.restorer.start({ dump: DUMP, requestedBy: ACTOR });
    await w.restorer.settled();
    await expect(
      w.restorer.activate({ acceptUnreachable: false, requestedBy: ACTOR }),
    ).rejects.toMatchObject({ code: "blocked" });
    await w.restorer.activate({ acceptUnreachable: true, requestedBy: ACTOR });
    await w.restorer.settled();
    expect(w.restorer.view()?.status).toBe("done");
  });

  it("starts nothing by itself after an updater restart in the middle of a step", async () => {
    const w = world();
    await w.restorer.start({ dump: DUMP, requestedBy: ACTOR });
    await w.restorer.settled();
    const record = { ...w.restorer.view(), status: "running", phase: "activating" };
    await fs.writeFile(path.join(dir, "restore.json"), JSON.stringify(record));
    const before = w.calls.length;
    const restarted = w.make();
    await restarted.init();
    expect(restarted.view()?.status).toBe("needs_attention");
    expect(w.calls.length).toBe(before);
    await expect(
      restarted.activate({ acceptUnreachable: false, requestedBy: ACTOR }),
    ).rejects.toBeInstanceOf(RestoreRefusedError);
  });

  it("refuses an unknown dump and a second restore", async () => {
    const w = world();
    await expect(
      w.restorer.start({ dump: "restow-20261105-120000-x-to-y.dump", requestedBy: ACTOR }),
    ).rejects.toMatchObject({ code: "not_found" });
    await w.restorer.start({ dump: DUMP, requestedBy: ACTOR });
    await expect(w.restorer.start({ dump: DUMP, requestedBy: ACTOR })).rejects.toMatchObject({
      code: "busy",
    });
    await w.restorer.settled();
  });

  it("reads the report from the last JSON line", () => {
    const report = okReport();
    expect(parseReport(`restow: applying\n${JSON.stringify(report)}\n`)).toEqual(report);
    expect(parseReport("no json")).toBeNull();
    expect(parseReport('{"ok": "maybe"}')).toBeNull();
  });
});
