import { describe, expect, it } from "vitest";

import {
  FAILED_JOB_EVENTS,
  INSTALLATION_REPORT_EVENTS,
  REPORT_EVENTS,
  REPORT_EVENT_INFO,
  isInstallationReportEvent,
  isReportEvent,
} from "./catalog.js";
import {
  MAX_REPORT_ATTEMPTS,
  type RuleForDelivery,
  isAlertThrottled,
  nextAttemptAfter,
  plannedDeliveries,
  rulesForEvent,
  subjectKeyOf,
} from "./rules.js";

function rule(overrides: Partial<RuleForDelivery> = {}): RuleForDelivery {
  return {
    id: "r1",
    name: "Failed jobs",
    enabled: true,
    trigger: "event",
    events: ["backup.failed"],
    throttleMinutes: 60,
    emailRecipients: ["ops@example.com"],
    inApp: false,
    webhookId: null,
    language: null,
    ...overrides,
  };
}

describe("catalog", () => {
  it("describes every event and maps failed queues to events of the catalog", () => {
    for (const event of REPORT_EVENTS) {
      expect(REPORT_EVENT_INFO[event]).toBeDefined();
    }
    for (const event of Object.values(FAILED_JOB_EVENTS)) {
      expect(isReportEvent(event)).toBe(true);
    }
    expect(isReportEvent("job.exploded")).toBe(false);
  });
});

describe("rulesForEvent", () => {
  it("picks enabled event rules that list the event", () => {
    const rules = [
      rule({ id: "match" }),
      rule({ id: "disabled", enabled: false }),
      rule({ id: "other-event", events: ["verify.red"] }),
      rule({ id: "report", trigger: "schedule" }),
    ];
    expect(rulesForEvent(rules, "backup.failed").map((r) => r.id)).toEqual(["match"]);
  });
});

describe("isAlertThrottled", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  it("holds back a repeat within the window and lets it through after", () => {
    expect(isAlertThrottled(null, now, 60)).toBe(false);
    expect(isAlertThrottled(new Date("2026-09-30T11:30:00Z"), now, 60)).toBe(true);
    expect(isAlertThrottled(new Date("2026-09-30T11:00:00Z"), now, 60)).toBe(false);
    expect(isAlertThrottled(new Date("2026-09-30T11:59:00Z"), now, 0)).toBe(false);
  });
});

describe("plannedDeliveries", () => {
  it("sends one mail per distinct address, and to the webhook", () => {
    expect(
      plannedDeliveries(
        rule({ emailRecipients: ["a@x.de", "A@X.de ", " ", "b@x.de"], webhookId: "w1" }),
        "event",
      ),
    ).toEqual([
      { channel: "email", recipient: "a@x.de" },
      { channel: "email", recipient: "b@x.de" },
      { channel: "webhook", recipient: "w1" },
    ]);
  });

  it("adds a bell entry for a summary report only; alerts reach the bell anyway", () => {
    expect(plannedDeliveries(rule({ inApp: true, emailRecipients: [] }), "event")).toEqual([]);
    expect(plannedDeliveries(rule({ inApp: true, emailRecipients: [] }), "summary")).toEqual([
      { channel: "in_app", recipient: null },
    ]);
  });
});

describe("subjectKeyOf", () => {
  it("throttles per object, else per queue, else per event", () => {
    expect(subjectKeyOf("verify.red", { protectedObjectId: "o1" })).toBe("object:o1");
    expect(subjectKeyOf("file_share.storage_quota", { fileShareId: "f1" })).toBe("file_share:f1");
    expect(subjectKeyOf("directory.failed", { queue: "directory" })).toBe("queue:directory");
    expect(subjectKeyOf("scrub.corrupt", {})).toBe("event:scrub.corrupt");
  });

  it("makes every version its own subject for the update alert", () => {
    expect(subjectKeyOf("update.available", { version: "0.2.0" })).toBe("update:0.2.0");
    expect(subjectKeyOf("update.available", { version: "0.3.0" })).toBe("update:0.3.0");
    expect(subjectKeyOf("update.available", {})).toBe("event:update.available");
  });
});

describe("installation events", () => {
  it("are events about the installation, not a tenant's data, and only those", () => {
    expect(INSTALLATION_REPORT_EVENTS).toEqual(["update.available"]);
    expect(isInstallationReportEvent("update.available")).toBe(true);
    expect(isInstallationReportEvent("backup.failed")).toBe(false);
    for (const event of INSTALLATION_REPORT_EVENTS) {
      expect(REPORT_EVENTS).toContain(event);
      expect(REPORT_EVENT_INFO[event].group).toBe("system");
    }
  });
});

describe("nextAttemptAfter", () => {
  it("backs off and then gives up", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    expect(nextAttemptAfter(1, now)?.toISOString()).toBe("2026-09-30T12:01:00.000Z");
    expect(nextAttemptAfter(4, now)?.toISOString()).toBe("2026-09-30T13:00:00.000Z");
    expect(nextAttemptAfter(MAX_REPORT_ATTEMPTS, now)).toBeNull();
  });
});
