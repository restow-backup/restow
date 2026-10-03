import { describe, expect, it } from "vitest";
import type { AgentStateEntry } from "./agent-state.js";
import { mulberry32 } from "./prng.js";
import {
  MAX_CONCURRENT_RUNS,
  MIN_REST_MS,
  type MachineSlot,
  SIM_DEFAULTS,
  backoffMs,
  datasetOf,
  finishOf,
  initialSlots,
  interruptedFinish,
  nextToStart,
  paceOf,
  parseSimConfig,
  planRun,
  restAfterRun,
} from "./run-sim.js";

const SERVER: Pick<AgentStateEntry, "hostname" | "profile" | "paths"> = {
  hostname: "fileserver-01",
  profile: "server",
  paths: ["/srv/share", "/etc/samba", "/var/log/samba"],
};
const LAPTOP: Pick<AgentStateEntry, "hostname" | "profile" | "paths"> = {
  hostname: "laptop-jdoe",
  profile: "client",
  paths: ["/Users/jdoe"],
};
const SNAPSHOT = "a".repeat(64);

describe("parseSimConfig", () => {
  it("is on with safe defaults when nothing is set", () => {
    expect(parseSimConfig({})).toEqual(SIM_DEFAULTS);
    expect(SIM_DEFAULTS).toMatchObject({
      enabled: true,
      minDurationMs: 120_000,
      maxDurationMs: 360_000,
      progressMs: 5_000,
    });
  });

  it("reads the switch and the seconds", () => {
    expect(
      parseSimConfig({
        RESTOW_DEMO_SIM_RUNS: "false",
        RESTOW_DEMO_SIM_INTERVAL_SECONDS: "60",
        RESTOW_DEMO_SIM_MIN_DURATION_SECONDS: "90",
        RESTOW_DEMO_SIM_MAX_DURATION_SECONDS: "180",
        RESTOW_DEMO_SIM_PROGRESS_SECONDS: "3",
      }),
    ).toEqual({
      enabled: false,
      intervalMs: 60_000,
      minDurationMs: 90_000,
      maxDurationMs: 180_000,
      progressMs: 3_000,
      partialRate: SIM_DEFAULTS.partialRate,
    });
    expect(parseSimConfig({ RESTOW_DEMO_SIM_RUNS: "0" }).enabled).toBe(false);
    expect(parseSimConfig({ RESTOW_DEMO_SIM_RUNS: " TRUE " }).enabled).toBe(true);
  });

  it("clamps what would break the agent API's limits or the run itself", () => {
    const config = parseSimConfig({
      RESTOW_DEMO_SIM_PROGRESS_SECONDS: "0.1",
      RESTOW_DEMO_SIM_MIN_DURATION_SECONDS: "1",
      RESTOW_DEMO_SIM_MAX_DURATION_SECONDS: "999999",
    });
    expect(config.progressMs).toBe(2_000);
    expect(config.minDurationMs).toBe(20_000);
    expect(config.maxDurationMs).toBe(60 * 60_000);
    // A maximum below the minimum becomes the minimum.
    expect(
      parseSimConfig({
        RESTOW_DEMO_SIM_MIN_DURATION_SECONDS: "200",
        RESTOW_DEMO_SIM_MAX_DURATION_SECONDS: "100",
      }).maxDurationMs,
    ).toBe(200_000);
  });

  it("refuses a typo instead of falling back silently", () => {
    expect(() => parseSimConfig({ RESTOW_DEMO_SIM_RUNS: "maybe" })).toThrow(/true or false/);
    expect(() => parseSimConfig({ RESTOW_DEMO_SIM_INTERVAL_SECONDS: "5m" })).toThrow(/seconds/);
    expect(() => parseSimConfig({ RESTOW_DEMO_SIM_PROGRESS_SECONDS: "-5" })).toThrow(/seconds/);
  });
});

describe("datasetOf", () => {
  it("is fixed per machine and larger for a server than for a laptop", () => {
    expect(datasetOf(SERVER)).toEqual(datasetOf(SERVER));
    expect(datasetOf(SERVER).bytes).toBeGreaterThan(datasetOf(LAPTOP).bytes);
    expect(datasetOf(SERVER).files).toBeGreaterThan(datasetOf(LAPTOP).files);
  });
});

describe("paceOf", () => {
  it("varies, with bursts and slow stretches, and starts slowly", () => {
    const pace = paceOf(400, mulberry32(7));
    expect(pace.bytes).toHaveLength(400);
    expect(pace.bytes.every((weight) => weight > 0)).toBe(true);
    expect(pace.files.every((weight) => weight > 0)).toBe(true);
    const sorted = [...pace.bytes].sort((a, b) => a - b);
    const median = sorted[200] as number;
    expect(Math.max(...pace.bytes)).toBeGreaterThan(2 * median);
    expect(Math.min(...pace.bytes)).toBeLessThan(0.5 * median);
    expect(pace.bytes[0]).toBeLessThan(median);
  });
});

describe("planRun", () => {
  const config = SIM_DEFAULTS;

  it("is deterministic for a seed", () => {
    expect(planRun(SERVER, config, mulberry32(1))).toEqual(planRun(SERVER, config, mulberry32(1)));
    expect(planRun(SERVER, config, mulberry32(1))).not.toEqual(
      planRun(SERVER, config, mulberry32(2)),
    );
  });

  it("runs between the shortest and the longest duration, a report every interval", () => {
    for (let seed = 0; seed < 50; seed++) {
      const plan = planRun(LAPTOP, config, mulberry32(seed));
      expect(plan.durationMs).toBeGreaterThanOrEqual(config.minDurationMs);
      expect(plan.durationMs).toBeLessThanOrEqual(config.maxDurationMs);
      expect(plan.points.length).toBe(Math.ceil(plan.durationMs / config.progressMs));
      expect(plan.points.at(-1)?.atMs).toBe(plan.durationMs);
      for (const [index, point] of plan.points.entries()) {
        if (index < plan.points.length - 1) {
          expect(point.atMs).toBe((index + 1) * config.progressMs);
        }
      }
    }
  });

  it("only ever counts up, and ends with everything done", () => {
    for (let seed = 0; seed < 50; seed++) {
      const plan = planRun(SERVER, config, mulberry32(seed));
      let files = 0;
      let bytes = 0;
      for (const point of plan.points) {
        expect(point.filesDone).toBeGreaterThanOrEqual(files);
        expect(point.bytesDone).toBeGreaterThanOrEqual(bytes);
        expect(Number.isInteger(point.filesDone) && Number.isInteger(point.bytesDone)).toBe(true);
        files = point.filesDone;
        bytes = point.bytesDone;
        if (point.totalBytes !== undefined) {
          expect(point.bytesDone).toBeLessThanOrEqual(point.totalBytes);
          expect(point.filesDone).toBeLessThanOrEqual(point.totalFiles as number);
        }
      }
      const last = plan.points.at(-1);
      expect(last).toMatchObject({
        filesDone: plan.dataset.files,
        bytesDone: plan.dataset.bytes,
        totalFiles: plan.dataset.files,
        totalBytes: plan.dataset.bytes,
      });
      expect(plan.stats.totalFilesProcessed).toBe(plan.dataset.files);
      expect(plan.stats.totalBytesProcessed).toBe(plan.dataset.bytes);
      // The snapshot it reports is the seed's newest: nothing changed, nothing was added.
      expect(plan.stats).toMatchObject({
        filesNew: 0,
        filesChanged: 0,
        filesUnmodified: plan.dataset.files,
        dataAdded: 0,
      });
      expect(plan.dataset).toEqual(datasetOf(SERVER));
    }
  });

  it("reports no totals before the scanner has counted, totals after", () => {
    const plan = planRun(SERVER, config, mulberry32(3));
    expect(plan.points[0]?.totalBytes).toBeUndefined();
    expect(plan.points[0]?.totalFiles).toBeUndefined();
    expect(plan.points.slice(1).every((point) => point.totalBytes === plan.dataset.bytes)).toBe(
      true,
    );
  });

  it("has a throughput that moves: tens to hundreds of MB/s, never flat", () => {
    const plan = planRun(SERVER, config, mulberry32(11));
    const rates = plan.points.slice(1).map((point, index) => {
      const before = plan.points[index] as (typeof plan.points)[number];
      return (point.bytesDone - before.bytesDone) / ((point.atMs - before.atMs) / 1000);
    });
    const average = plan.dataset.bytes / (plan.durationMs / 1000);
    expect(average).toBeGreaterThan(10 * 1024 ** 2);
    expect(average).toBeLessThan(500 * 1024 ** 2);
    expect(Math.max(...rates)).toBeGreaterThan(1.5 * Math.min(...rates));
  });

  it("names a file below the machine's folders as the current one", () => {
    const server = planRun(SERVER, config, mulberry32(5));
    for (const point of server.points) {
      expect(SERVER.paths?.some((root) => point.currentPath?.startsWith(`${root}/`))).toBe(true);
    }
    const laptop = planRun(LAPTOP, config, mulberry32(5));
    expect(laptop.points.every((point) => point.currentPath?.startsWith("/Users/jdoe/"))).toBe(
      true,
    );
    expect(planRun({ ...LAPTOP, paths: [] }, config, mulberry32(5)).roots).toEqual(["/data"]);
  });

  it("ends partial with a read error now and then, succeeded otherwise", () => {
    const plans = Array.from({ length: 400 }, (_, seed) =>
      planRun(LAPTOP, config, mulberry32(seed)),
    );
    const partial = plans.filter((plan) => plan.status === "partial");
    expect(partial.length).toBeGreaterThan(10);
    expect(partial.length).toBeLessThan(80);
    for (const plan of partial) {
      expect(plan.errors).toEqual([
        expect.objectContaining({ code: "read_error", path: expect.stringMatching(/^\/Users\//) }),
      ]);
    }
    expect(
      plans.filter((plan) => plan.status === "succeeded").every((p) => p.errors.length === 0),
    ).toBe(true);
    expect(planRun(LAPTOP, { ...config, partialRate: 0 }, mulberry32(1)).status).toBe("succeeded");
  });
});

describe("finishOf", () => {
  const startedAt = new Date("2026-10-03T10:00:00Z");
  const finishedAt = new Date("2026-10-03T10:04:00Z");

  it("reports the plan's result, the snapshot it is given and a log", () => {
    const plan = planRun(SERVER, { ...SIM_DEFAULTS, partialRate: 1 }, mulberry32(9));
    const finish = finishOf(plan, {
      startedAt,
      finishedAt,
      agentVersion: "0.2.0",
      snapshotId: SNAPSHOT,
    });
    expect(finish).toMatchObject({
      status: "partial",
      finishedAt: finishedAt.toISOString(),
      snapshotId: SNAPSHOT,
      stats: plan.stats,
      errors: plan.errors,
    });
    expect(finish.logTail).toMatch(/^2026-10-03T10:00:00Z INFO Run started \(backup/);
    expect(finish.logTail).toContain("Backing up: /srv/share, /etc/samba, /var/log/samba");
    expect(finish.logTail).toContain("snapshot aaaaaaaa saved");
    expect(finish.logTail).toContain("WARN Some files could not be read");
    expect(finish.logTail).toMatch(/Run finished: partial\.$/);
  });

  it("leaves the snapshot out when it has none", () => {
    const plan = planRun(LAPTOP, SIM_DEFAULTS, mulberry32(9));
    const finish = finishOf(plan, { startedAt, finishedAt, agentVersion: "0.2.0" });
    expect(finish).not.toHaveProperty("snapshotId");
    expect(finish.logTail).not.toContain("saved");
  });

  it("closes a stopped run as interrupted, which the server does not count as a failure", () => {
    expect(interruptedFinish(finishedAt)).toMatchObject({
      status: "failed",
      finishedAt: finishedAt.toISOString(),
      errors: [{ code: "interrupted" }],
    });
  });
});

describe("scheduling", () => {
  const T0 = 1_000_000;
  const machines = [
    { id: "server", tenant: "example-trading" },
    { id: "laptop", tenant: "birchwood-consulting" },
  ];

  function slot(partial: Partial<MachineSlot> & Pick<MachineSlot, "id">): MachineSlot {
    return { tenant: partial.id, running: false, lastEndedAt: null, restUntil: 0, ...partial };
  }

  it("staggers the machines over one interval, the first at once", () => {
    const slots = initialSlots(machines, T0, 240_000);
    expect(slots.map((s) => s.restUntil)).toEqual([T0, T0 + 120_000]);
    expect(nextToStart(slots, T0)).toBe("server");
  });

  it("starts the first machine at once even while it would still rest, once it rested a little", () => {
    const slots = [
      slot({ id: "a", lastEndedAt: T0 - 5_000, restUntil: T0 + 100_000 }),
      slot({ id: "b", lastEndedAt: T0 - 1_000, restUntil: T0 + 200_000 }),
    ];
    // Nothing runs, but both just finished: their finished runs stay visible for a moment.
    expect(nextToStart(slots, T0)).toBeNull();
    expect(nextToStart(slots, T0 - 5_000 + MIN_REST_MS)).toBe("a");
  });

  it("adds a second run only when that machine's rest is over", () => {
    const slots = [
      slot({ id: "a", running: true }),
      slot({ id: "b", lastEndedAt: T0 - 60_000, restUntil: T0 + 30_000 }),
    ];
    expect(nextToStart(slots, T0)).toBeNull();
    expect(nextToStart(slots, T0 + 30_000)).toBe("b");
  });

  it("never runs a machine twice, nor two machines of one tenant at once", () => {
    expect(nextToStart([slot({ id: "a", running: true })], T0 + 10_000_000)).toBeNull();
    const sameTenant = [
      slot({ id: "a", tenant: "t", running: true }),
      slot({ id: "b", tenant: "t" }),
    ];
    expect(nextToStart(sameTenant, T0)).toBeNull();
  });

  it("runs at most two at once", () => {
    const slots = [
      slot({ id: "a", running: true }),
      slot({ id: "b", running: true }),
      slot({ id: "c" }),
    ];
    expect(MAX_CONCURRENT_RUNS).toBe(2);
    expect(nextToStart(slots, T0)).toBeNull();
    expect(nextToStart([slots[0] as MachineSlot, slots[2] as MachineSlot], T0)).toBe("c");
  });

  it("keeps a run going almost all the time with two machines and the defaults", () => {
    // Play a day of the scheduler with the default durations and rests, in one-second steps.
    const rng = mulberry32(42);
    const slots = initialSlots(machines, 0, SIM_DEFAULTS.intervalMs);
    const endsAt = new Map<string, number>();
    let idle = 0;
    let overlapping = 0;
    const day = 24 * 60 * 60;
    for (let second = 0; second < day; second++) {
      const now = second * 1000;
      for (const s of slots) {
        if (s.running && (endsAt.get(s.id) ?? 0) <= now) {
          s.running = false;
          s.lastEndedAt = now;
          s.restUntil = now + restAfterRun(SIM_DEFAULTS.intervalMs, rng);
        }
      }
      for (let id = nextToStart(slots, now); id; id = nextToStart(slots, now)) {
        const started = slots.find((s) => s.id === id) as MachineSlot;
        started.running = true;
        const plan = planRun(id === "server" ? SERVER : LAPTOP, SIM_DEFAULTS, rng);
        endsAt.set(id, now + plan.durationMs);
      }
      const running = slots.filter((s) => s.running).length;
      if (running === 0) {
        idle++;
      } else if (running === 2) {
        overlapping++;
      }
    }
    expect(idle / day).toBeLessThan(0.02);
    expect(overlapping / day).toBeGreaterThan(0.1);
  });

  it("rests about the interval, give or take half", () => {
    expect(restAfterRun(240_000, () => 0)).toBe(120_000);
    expect(restAfterRun(240_000, () => 0.5)).toBe(240_000);
    expect(restAfterRun(240_000, () => 0.999999)).toBeLessThanOrEqual(360_000);
  });

  it("backs off from 5 s, doubling, to at most 5 minutes", () => {
    expect([0, 1, 2, 3, 4, 7, 50].map(backoffMs)).toEqual([
      0, 5_000, 10_000, 20_000, 40_000, 300_000, 300_000,
    ]);
  });
});
