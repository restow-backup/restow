import { describe, expect, it } from "vitest";

import {
  bellEventsOf,
  DEFAULT_BELL_EVENTS,
  defaultWebhookEvents,
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

  it("keeps the bell as it was until the tenant chooses", () => {
    expect(bellEventsOf(null)).toEqual([...DEFAULT_BELL_EVENTS]);
    for (const routine of ROUTINE_REPORT_EVENTS) {
      expect(DEFAULT_BELL_EVENTS).not.toContain(routine);
    }
    expect(bellEventsOf(["verify.red", "nonsense"])).toEqual(["verify.red"]);
    expect(bellEventsOf([])).toEqual([]);
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
