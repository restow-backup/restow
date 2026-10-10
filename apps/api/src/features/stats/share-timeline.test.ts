import { describe, expect, it } from "vitest";
import { shareBackupStatus } from "./share-facts.js";
import { ShareTimeline } from "./share-timeline.js";

const at = (date: string, hour = 12) =>
  new Date(`${date}T${String(hour).padStart(2, "0")}:00:00.000Z`);

describe("ShareTimeline", () => {
  const share = { id: "s", createdAt: at("2026-09-01"), inJob: true };

  it("takes the newest restore point kept at the moment and its newest check before it", () => {
    const timeline = new ShareTimeline(
      [share],
      [
        {
          shareId: "s",
          sequence: 1,
          at: at("2026-09-10"),
          prunedAt: at("2026-09-20"),
          checks: [{ at: at("2026-09-11"), readiness: "green" }],
        },
        {
          shareId: "s",
          sequence: 2,
          at: at("2026-09-15"),
          prunedAt: null,
          checks: [
            { at: at("2026-09-16"), readiness: "red" },
            { at: at("2026-09-18"), readiness: "green" },
          ],
        },
      ],
    );
    // Before anything: protected without a backup.
    expect(timeline.at(at("2026-09-05")).states.get("s")).toBe("no_backup");
    // Point 1, checked green.
    expect(timeline.at(at("2026-09-12")).states.get("s")).toBe("green");
    // Point 2, not checked yet.
    expect(timeline.at(at("2026-09-15", 18)).states.get("s")).toBe("unverified");
    expect(timeline.at(at("2026-09-17")).states.get("s")).toBe("red");
    expect(timeline.at(at("2026-09-19")).states.get("s")).toBe("green");
  });

  it("counts a share out of every job only while it holds a restore point, and marks it", () => {
    const left = { id: "l", createdAt: at("2026-09-01"), inJob: false };
    const timeline = new ShareTimeline(
      [left],
      [{ shareId: "l", sequence: 1, at: at("2026-09-10"), prunedAt: at("2026-09-20"), checks: [] }],
    );
    expect(timeline.at(at("2026-09-05")).total).toBe(0);
    const during = timeline.at(at("2026-09-12"));
    expect(during.total).toBe(1);
    expect(during.counts.unverified).toBe(1);
    expect(during.rated[0]).toMatchObject({ withoutJob: true, share: true });
    expect(timeline.at(at("2026-09-21")).total).toBe(0);
  });

  it("does not count a share before it was added", () => {
    const later = { id: "n", createdAt: at("2026-09-15"), inJob: true };
    const timeline = new ShareTimeline([later], []);
    expect(timeline.at(at("2026-09-10")).total).toBe(0);
    expect(timeline.at(at("2026-09-16")).total).toBe(1);
  });
});

describe("shareBackupStatus", () => {
  it("counts a backup with warnings as succeeded and leaves running ones out", () => {
    expect(shareBackupStatus("succeeded")).toBe("succeeded");
    expect(shareBackupStatus("warning")).toBe("succeeded");
    expect(shareBackupStatus("failed")).toBe("failed");
    expect(shareBackupStatus("cancelled")).toBe("cancelled");
    expect(shareBackupStatus("running")).toBeNull();
  });
});
