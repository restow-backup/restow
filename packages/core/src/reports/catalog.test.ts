import { describe, expect, it } from "vitest";

import {
  BELL_LOCKED_EVENTS,
  bellEventsOf,
  CRITICAL_REPORT_EVENTS,
  cadenceOfSummaryEntry,
  DEFAULT_BELL_EVENTS,
  defaultWebhookEvents,
  FLOOR_REPORT_EVENTS,
  isCriticalReportEvent,
  isFloorReportEvent,
  isReportCadence,
  isSummaryEntry,
  isWebhookEvent,
  presetEvents,
  REPORT_EVENT_INFO,
  REPORT_EVENTS,
  ROUTINE_REPORT_EVENTS,
  reportEventsOfWebhookEvent,
  WEBHOOK_EVENTS,
  webhookColumnUpdate,
  webhookEventRow,
  webhookSubscriptionUpdate,
} from "./catalog.js";

describe("the webhook stream", () => {
  it("derives its events from the catalog, keeping the public names and their order", () => {
    expect(WEBHOOK_EVENTS).toEqual(["job.failed", "job.completed", "verify.completed"]);
    expect(isWebhookEvent("job.completed")).toBe(true);
    expect(isWebhookEvent("backup.succeeded")).toBe(false);
    expect(reportEventsOfWebhookEvent("job.completed")).toEqual([
      "backup.succeeded",
      "restore.completed",
    ]);
    expect(reportEventsOfWebhookEvent("job.failed")).toEqual([
      "backup.failed",
      "restore.failed",
      "archive.failed",
      "directory.failed",
    ]);
  });

  it("knows backup.succeeded and verify.completed with a severity", () => {
    expect(REPORT_EVENT_INFO["backup.succeeded"]).toMatchObject({ group: "jobs", level: "info" });
    expect(REPORT_EVENT_INFO["verify.completed"]).toMatchObject({
      group: "recoverability",
      level: "info",
    });
  });

  it("reads which catalog event a stream delivery is about from its queue", () => {
    const job = (queue: string) => ({ job: { queue } });
    expect(webhookEventRow("job.completed", job("backup"))).toBe("backup.succeeded");
    expect(webhookEventRow("job.completed", job("file-share-backup"))).toBe("backup.succeeded");
    expect(webhookEventRow("job.completed", job("retention"))).toBe("backup.succeeded");
    expect(webhookEventRow("job.completed", job("restore"))).toBe("restore.completed");
    expect(webhookEventRow("job.completed", job("file-share-restore"))).toBe("restore.completed");
    expect(webhookEventRow("job.failed", job("backup"))).toBe("backup.failed");
    expect(webhookEventRow("job.failed", job("endpoint_backup"))).toBe("backup.failed");
    expect(webhookEventRow("job.failed", job("endpoint_restore"))).toBe("restore.failed");
    expect(webhookEventRow("job.failed", job("archive"))).toBe("archive.failed");
    expect(webhookEventRow("job.failed", job("directory"))).toBe("directory.failed");
    expect(webhookEventRow("job.failed", {})).toBe("backup.failed");
    expect(webhookEventRow("verify.completed", { readiness: "green" })).toBe("verify.completed");
  });
});

describe("channel columns", () => {
  it("offers errors only, errors and warnings, and everything", () => {
    expect(presetEvents("errors").every((e) => REPORT_EVENT_INFO[e].level === "error")).toBe(true);
    expect(presetEvents("warnings")).toContain("backup.overdue");
    expect(presetEvents("warnings")).not.toContain("backup.succeeded");
    expect(presetEvents("all")).toEqual([...REPORT_EVENTS]);
  });

  it("puts the expiry reminders into the warnings, the bell and their groups", () => {
    expect(REPORT_EVENT_INFO["source.app_secret_expiring"]).toEqual({
      group: "jobs",
      level: "warning",
    });
    expect(REPORT_EVENT_INFO["installation.app_secret_expiring"]).toEqual({
      group: "system",
      level: "warning",
    });
    for (const event of [
      "source.app_secret_expiring",
      "installation.app_secret_expiring",
    ] as const) {
      expect(presetEvents("warnings")).toContain(event);
      expect(presetEvents("errors")).not.toContain(event);
      expect(DEFAULT_BELL_EVENTS).toContain(event);
    }
  });

  it("raises a notice per object no longer backed up and a warning when many go at once", () => {
    expect(REPORT_EVENT_INFO["object.inactive"]).toEqual({ group: "jobs", level: "info" });
    expect(REPORT_EVENT_INFO["object.inactive_many"]).toEqual({ group: "jobs", level: "warning" });
    expect(presetEvents("warnings")).toContain("object.inactive_many");
    expect(presetEvents("warnings")).not.toContain("object.inactive");
    expect(presetEvents("all")).toContain("object.inactive");
    expect(DEFAULT_BELL_EVENTS).toContain("object.inactive");
  });

  it("keeps the bell as it was until the tenant chooses", () => {
    expect(bellEventsOf(null)).toEqual([...DEFAULT_BELL_EVENTS]);
    for (const routine of ROUTINE_REPORT_EVENTS) {
      expect(DEFAULT_BELL_EVENTS).not.toContain(routine);
    }
    // The critical events and the failed delivery are always on (0.5.0).
    expect(bellEventsOf(["backup.failed", "nonsense"])).toEqual([
      "backup.failed",
      ...REPORT_EVENTS.filter((event) => FLOOR_REPORT_EVENTS.includes(event)),
    ]);
    expect(bellEventsOf([])).toEqual(
      REPORT_EVENTS.filter((event) => FLOOR_REPORT_EVENTS.includes(event)),
    );
  });

  it("starts a chat webhook with errors and warnings, a signed one with everything", () => {
    const discord = defaultWebhookEvents("discord");
    expect(discord).toContain("backup.failed");
    expect(discord).toContain("job.failed");
    expect(discord).not.toContain("backup.succeeded");
    expect(discord).not.toContain("job.completed");
    const signed = defaultWebhookEvents("restow");
    expect(signed).toEqual([...REPORT_EVENTS, ...WEBHOOK_EVENTS]);
  });

  it("unticking backup succeeded drops job.completed only with its last event", () => {
    const stored = [
      "backup.failed",
      "backup.succeeded",
      "restore.completed",
      "job.failed",
      "job.completed",
    ];
    const withoutBackup = webhookColumnUpdate(stored, ["backup.failed", "restore.completed"]);
    expect(withoutBackup).toEqual([
      "backup.failed",
      "restore.completed",
      "job.failed",
      "job.completed",
    ]);
    expect(webhookColumnUpdate(withoutBackup, ["backup.failed"])).toEqual([
      "backup.failed",
      "job.failed",
    ]);
  });

  it("subscribes the stream for an event switched on, never for one left as it was", () => {
    // A webhook only rules send to: verify.red and backup.failed on, no stream.
    const ruleOnly = ["backup.failed", "verify.red"];
    expect(webhookColumnUpdate(ruleOnly, ["backup.failed", "verify.red"])).toEqual(ruleOnly);
    expect(
      webhookColumnUpdate(ruleOnly, ["backup.failed", "verify.red", "backup.succeeded"]),
    ).toEqual(["backup.failed", "backup.succeeded", "verify.red", "job.completed"]);
  });

  it("switches the events of a newly subscribed stream event on, and keeps them on removal", () => {
    const stored = webhookSubscriptionUpdate(["verify.red"], ["job.completed"]);
    expect(stored).toEqual([
      "backup.succeeded",
      "restore.completed",
      "verify.red",
      "job.completed",
    ]);
    expect(webhookSubscriptionUpdate(stored, [])).toEqual([
      "backup.succeeded",
      "restore.completed",
      "verify.red",
    ]);
  });
});

describe("bare metal recovery events (docs/BAREMETAL.md 12.6)", () => {
  it("are errors of the recoverability group, in the bell by default and off the webhook stream", () => {
    for (const event of [
      "endpoint.recovery.started",
      "endpoint.recovery_code.rejected",
      "endpoint.rebound",
      "endpoint.recovery.failed",
    ] as const) {
      expect(REPORT_EVENTS).toContain(event);
      expect(REPORT_EVENT_INFO[event]).toEqual({ group: "recoverability", level: "error" });
      expect(DEFAULT_BELL_EVENTS).toContain(event);
      expect(ROUTINE_REPORT_EVENTS).not.toContain(event);
      expect(presetEvents("errors")).toContain(event);
    }
  });
});

describe("critical events (0.5.0)", () => {
  it("are the security and data-loss events [ALERT-001]", () => {
    expect(CRITICAL_REPORT_EVENTS).toEqual([
      "backup.suspicious",
      "verify.red",
      "scrub.corrupt",
      "endpoint.suspicious_snapshot",
      // Deleting a revoked machine's backups was asked for (0.5.0): the floor can still stop it.
      "endpoint.backups_deletion_scheduled",
      // A backup held as unusually large (#99): the object's backups stop until someone decides.
      "backup.unusually_large",
      "installation.disk_low",
      // The emergency disk reserve was freed (#98): the disk is almost full.
      "installation.disk_reserve_released",
    ]);
    expect(isCriticalReportEvent("installation.disk_reserve_restored")).toBe(false);
    // A large run that went on (the size check's default, `warn`, #99): a notice, not critical.
    expect(isCriticalReportEvent("backup.unusually_large_notice")).toBe(false);
    expect(isCriticalReportEvent("backup.suspicious")).toBe(true);
    expect(isCriticalReportEvent("endpoint.backups_deleted")).toBe(false);
    expect(isCriticalReportEvent("backup.failed")).toBe(false);
    expect(isCriticalReportEvent("notification.delivery_failed")).toBe(false);
  });

  it("put the failed delivery on the floor and lock both in the bell [ALERT-001]", () => {
    expect(FLOOR_REPORT_EVENTS).toEqual([
      ...CRITICAL_REPORT_EVENTS,
      "notification.delivery_failed",
    ]);
    expect(isFloorReportEvent("notification.delivery_failed")).toBe(true);
    expect(BELL_LOCKED_EVENTS).toEqual(FLOOR_REPORT_EVENTS);
    expect(REPORT_EVENT_INFO["notification.delivery_failed"]).toEqual({
      group: "system",
      level: "error",
    });
  });

  it("knows the summary entries and cadences", () => {
    expect(isSummaryEntry("report.monthly")).toBe(true);
    expect(isSummaryEntry("report.yearly")).toBe(false);
    expect(cadenceOfSummaryEntry("report.daily")).toBe("daily");
    expect(isReportCadence("weekly")).toBe(true);
    expect(isReportCadence("hourly")).toBe(false);
  });
});
