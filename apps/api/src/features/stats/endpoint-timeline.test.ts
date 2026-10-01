import { describe, expect, it } from "vitest";
import type { EndpointBackup, EndpointReportRow, EndpointRow } from "./endpoint-facts.js";
import { EndpointTimeline } from "./endpoint-timeline.js";
import { mergeReadiness } from "./readiness.js";

/** Midnight UTC of a September day, plus hours. */
const day = (n: number, hour = 0) => new Date(Date.UTC(2026, 8, n, hour));

function endpoint(id: string, createdDay: number, revokedDay: number | null = null): EndpointRow {
  return {
    id,
    createdAt: day(createdDay),
    revokedAt: revokedDay === null ? null : day(revokedDay, 12),
  };
}

/** A good backup of `id` finished at noon of `finishedDay`; its snapshot is `id-<n>`. */
function backup(id: string, n: number, finishedDay: number, partial = false): EndpointBackup {
  return { endpointId: id, snapshotId: `${id}-${n}`, partial, finishedAt: day(finishedDay, 12) };
}

/** A restore test of snapshot `id-<n>`, checked at 18:00 of `checkedDay`. */
function test(
  id: string,
  n: number,
  checkedDay: number,
  readiness: EndpointReportRow["readiness"],
  origin: EndpointReportRow["origin"] = "server",
): EndpointReportRow {
  return {
    endpointId: id,
    kind: "restore_test",
    origin,
    snapshotId: `${id}-${n}`,
    readiness,
    checkedAt: day(checkedDay, 18),
  };
}

/** A repository check of the endpoint, at 20:00 of `checkedDay`. */
function check(
  id: string,
  checkedDay: number,
  readiness: EndpointReportRow["readiness"],
): EndpointReportRow {
  return {
    endpointId: id,
    kind: "repository_check",
    origin: "server",
    snapshotId: null,
    readiness,
    checkedAt: day(checkedDay, 20),
  };
}

describe("EndpointTimeline", () => {
  it("rates green only after a restore test of the newest backup", () => {
    const timeline = new EndpointTimeline(
      [endpoint("web", 1)],
      [backup("web", 1, 2)],
      [test("web", 1, 3, "green")],
    );
    // Backed up on day 2, not tested until 18:00 of day 3.
    expect(timeline.at(day(3)).states.get("web")).toBe("unverified");
    expect(timeline.at(day(3, 12)).states.get("web")).toBe("unverified");
    const proven = timeline.at(day(4));
    expect(proven.states.get("web")).toBe("green");
    expect(proven.counts).toEqual({ green: 1, yellow: 0, red: 0, unverified: 0 });
    expect(proven.total).toBe(1);
  });

  it("counts an endpoint that never delivered a backup as unverified", () => {
    const moment = new EndpointTimeline([endpoint("web", 1)], [], []).at(day(5));
    expect(moment.states.get("web")).toBe("no_backup");
    expect(moment.counts).toEqual({ green: 0, yellow: 0, red: 0, unverified: 1 });
    expect(moment.rated).toEqual([{ state: "no_backup", overdue: false, checkedAt: null }]);
  });

  it("makes a newer backup unverified again until a test of that backup ran", () => {
    const timeline = new EndpointTimeline(
      [endpoint("web", 1)],
      [backup("web", 1, 2), backup("web", 2, 5), backup("web", 3, 9)],
      [test("web", 1, 3, "green"), test("web", 3, 10, "green")],
    );
    expect(timeline.at(day(4)).states.get("web")).toBe("green");
    // Backup 2 replaced backup 1 on day 5 and is never tested: the old green does not carry over.
    expect(timeline.at(day(6)).states.get("web")).toBe("unverified");
    expect(timeline.at(day(9)).states.get("web")).toBe("unverified");
    // Backup 3 of day 9, tested on day 10.
    expect(timeline.at(day(10)).states.get("web")).toBe("unverified");
    expect(timeline.at(day(11)).states.get("web")).toBe("green");
  });

  it("ignores tests of another snapshot, tests not yet run and runs that finished at the moment", () => {
    const timeline = new EndpointTimeline(
      [endpoint("web", 1)],
      [backup("web", 1, 2)],
      [test("web", 99, 3, "green"), test("web", 1, 8, "green")],
    );
    expect(timeline.at(day(5)).states.get("web")).toBe("unverified");
    expect(timeline.at(day(9)).states.get("web")).toBe("green");
    // The backup finished at 12:00 of day 2: a moment at that instant does not include it.
    expect(timeline.at(day(2, 12)).states.get("web")).toBe("no_backup");
    expect(timeline.at(day(2, 13)).states.get("web")).toBe("unverified");
  });

  it("rates red when a restore test of the newest backup failed, from either side", () => {
    const timeline = new EndpointTimeline(
      [endpoint("server", 1), endpoint("client", 1)],
      [backup("server", 1, 2), backup("client", 1, 2)],
      [
        test("server", 1, 3, "red"),
        // The server reads the repository green, the agent's own restore fails.
        test("client", 1, 3, "green", "server"),
        test("client", 1, 3, "red", "agent"),
      ],
    );
    const moment = timeline.at(day(4));
    expect(moment.states.get("server")).toBe("red");
    expect(moment.states.get("client")).toBe("red");
    expect(moment.counts).toEqual({ green: 0, yellow: 0, red: 2, unverified: 0 });
  });

  it("rates red when a repository check found damage after the last test, and not before it", () => {
    const after = new EndpointTimeline(
      [endpoint("web", 1)],
      [backup("web", 1, 2)],
      [test("web", 1, 3, "green"), check("web", 5, "red")],
    );
    expect(after.at(day(5)).states.get("web")).toBe("green");
    expect(after.at(day(6)).states.get("web")).toBe("red");

    // The damage was found first and the test came after it: the test already accounted for it.
    const before = new EndpointTimeline(
      [endpoint("web", 1)],
      [backup("web", 1, 2)],
      [check("web", 3, "red"), test("web", 1, 5, "green")],
    );
    expect(before.at(day(4)).states.get("web")).toBe("red");
    expect(before.at(day(6)).states.get("web")).toBe("green");
  });

  it("rates a green check of the repository as no evidence for a backup that was not tested", () => {
    const timeline = new EndpointTimeline(
      [endpoint("web", 1)],
      [backup("web", 1, 2)],
      [check("web", 3, "green")],
    );
    expect(timeline.at(day(5)).states.get("web")).toBe("unverified");
  });

  it("rates a partial backup yellow once it was tested, not green", () => {
    const timeline = new EndpointTimeline(
      [endpoint("web", 1)],
      [backup("web", 1, 2, true)],
      [test("web", 1, 3, "green")],
    );
    expect(timeline.at(day(3)).states.get("web")).toBe("unverified");
    const moment = timeline.at(day(4));
    expect(moment.states.get("web")).toBe("yellow");
    expect(moment.counts).toEqual({ green: 0, yellow: 1, red: 0, unverified: 0 });
  });

  it("leaves out endpoints that did not exist yet and those revoked before the moment", () => {
    const timeline = new EndpointTimeline(
      [endpoint("old", 1), endpoint("later", 10), endpoint("gone", 1, 6)],
      [backup("old", 1, 2), backup("gone", 1, 2)],
      [test("old", 1, 3, "green"), test("gone", 1, 3, "green")],
    );
    const early = timeline.at(day(5));
    expect([...early.states.keys()].sort()).toEqual(["gone", "old"]);
    expect(early.total).toBe(2);
    // Revoked at noon of day 6: still protected at the midnight before, gone at the one after.
    expect(timeline.at(day(6)).total).toBe(2);
    const late = timeline.at(day(8));
    expect([...late.states.keys()]).toEqual(["old"]);
    expect(late.total).toBe(1);
    // Created at midnight of day 10: not there at that instant, there after it.
    expect(timeline.at(day(10)).states.has("later")).toBe(false);
    expect(timeline.at(day(11)).states.get("later")).toBe("no_backup");
    expect(timeline.at(day(11)).total).toBe(2);
  });

  it("keeps a revoked endpoint protected at a moment that is exactly its revocation", () => {
    const revokedAtMidnight: EndpointRow = {
      id: "web",
      createdAt: day(1),
      revokedAt: day(6),
    };
    const timeline = new EndpointTimeline([revokedAtMidnight], [], []);
    // Not revoked *before* the moment: what happens at the moment itself is not included.
    expect(timeline.at(day(6)).total).toBe(1);
    expect(timeline.at(day(6, 1)).total).toBe(0);
  });

  it("rates an old test as overdue, so a tenant of green endpoints turns yellow", () => {
    const timeline = new EndpointTimeline(
      [endpoint("web", 1)],
      [backup("web", 1, 2)],
      [test("web", 1, 3, "green")],
    );
    const fresh = timeline.at(day(5));
    expect(fresh.rated).toEqual([{ state: "green", overdue: false, checkedAt: day(3, 18) }]);
    // More than 8 days after the test at 18:00 of day 3.
    const stale = timeline.at(day(20));
    expect(stale.rated).toEqual([{ state: "green", overdue: true, checkedAt: day(3, 18) }]);
    expect(stale.counts.green).toBe(1);
  });

  it("finds the newest good backup of an endpoint at a moment", () => {
    const timeline = new EndpointTimeline(
      [endpoint("web", 1)],
      [backup("web", 2, 6), backup("web", 1, 3)],
      [],
    );
    expect(timeline.latestBackupAt("web", day(3))).toBeNull();
    expect(timeline.latestBackupAt("web", day(4))?.snapshotId).toBe("web-1");
    expect(timeline.latestBackupAt("web", day(7))?.snapshotId).toBe("web-2");
    expect(timeline.latestBackupAt("nobody", day(7))).toBeNull();
  });

  it("is an empty moment for no endpoints", () => {
    const moment = new EndpointTimeline([], [], []).at(day(5));
    expect(moment).toEqual({
      counts: { green: 0, yellow: 0, red: 0, unverified: 0 },
      total: 0,
      rated: [],
      states: new Map(),
    });
  });
});

describe("mergeReadiness", () => {
  const objects = {
    counts: { green: 1, yellow: 0, red: 0, unverified: 1 },
    total: 2,
    overall: "red" as const,
    states: new Map([["anna", "green" as const]]),
    rated: [
      { state: "green" as const, overdue: false, checkedAt: day(3) },
      { state: "unverified" as const, overdue: false, checkedAt: null },
    ],
  };

  it("adds the counts and rates the union of everything counted", () => {
    const timeline = new EndpointTimeline(
      [endpoint("web", 1)],
      [backup("web", 1, 2)],
      [test("web", 1, 3, "red")],
    );
    const merged = mergeReadiness(objects, timeline.at(day(5)));
    expect(merged.counts).toEqual({ green: 1, yellow: 0, red: 1, unverified: 1 });
    expect(merged.total).toBe(3);
    expect(merged.overall).toBe("red");
    expect(merged.rated).toHaveLength(3);
    // The states stay those of the protected objects.
    expect([...merged.states.keys()]).toEqual(["anna"]);
  });

  it("lets a healthy endpoint neither mask an unproven object nor turn a healthy tenant red", () => {
    const healthy = new EndpointTimeline(
      [endpoint("web", 1)],
      [backup("web", 1, 2)],
      [test("web", 1, 3, "green")],
    ).at(day(5));
    expect(mergeReadiness(objects, healthy).overall).toBe("red");

    const greenObjects = {
      ...objects,
      counts: { green: 1, yellow: 0, red: 0, unverified: 0 },
      total: 1,
      overall: "green" as const,
      rated: [{ state: "green" as const, overdue: false, checkedAt: day(3) }],
    };
    expect(mergeReadiness(greenObjects, healthy).overall).toBe("green");
    // An unproven endpoint is enough to make the whole tenant not ready.
    const unproven = new EndpointTimeline([endpoint("web", 1)], [backup("web", 1, 2)], []).at(
      day(5),
    );
    expect(mergeReadiness(greenObjects, unproven).overall).toBe("red");
  });

  it("rates a tenant with endpoints only", () => {
    const empty = {
      counts: { green: 0, yellow: 0, red: 0, unverified: 0 },
      total: 0,
      overall: null,
      states: new Map(),
      rated: [],
    };
    const partial = new EndpointTimeline(
      [endpoint("web", 1)],
      [backup("web", 1, 2, true)],
      [test("web", 1, 3, "green")],
    ).at(day(5));
    const merged = mergeReadiness(empty, partial);
    expect(merged.overall).toBe("yellow");
    expect(merged.total).toBe(1);
    expect(mergeReadiness(empty, new EndpointTimeline([], [], []).at(day(5))).overall).toBeNull();
  });
});
