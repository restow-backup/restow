import { describe, expect, it } from "vitest";

import {
  FAILED_JOB_EVENTS,
  INSTALLATION_REPORT_EVENTS,
  isInstallationReportEvent,
  isReportEvent,
  REPORT_EVENT_INFO,
  REPORT_EVENTS,
} from "./catalog.js";
import {
  completeDeliveryModes,
  deliveryFailureExclusion,
  deliveryModeFor,
  digestDueAt,
  isAlertThrottled,
  MAX_REPORT_ATTEMPTS,
  nextAttemptAfter,
  plannedDeliveries,
  type RuleForDelivery,
  rulesForEvent,
  storedDeliveryModes,
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

  it("leaves out the channels whose column has the event off", () => {
    const columns = {
      webhooks: new Map([
        ["discord", ["backup.failed", "job.failed"]],
        ["json", ["backup.failed", "backup.succeeded", "job.failed", "job.completed"]],
      ]),
      recipients: new Map([["ops@x.de", { events: ["backup.failed"], delivery: {} }]]),
    };
    const failing = rule({ emailRecipients: ["Ops@x.de", "adhoc@x.de"], webhookId: "discord" });
    expect(plannedDeliveries(failing, "event", { event: "backup.succeeded", columns })).toEqual([
      { channel: "email", recipient: "adhoc@x.de" },
    ]);
    expect(plannedDeliveries(failing, "event", { event: "backup.failed", columns })).toEqual([
      { channel: "email", recipient: "Ops@x.de" },
      { channel: "email", recipient: "adhoc@x.de" },
      { channel: "webhook", recipient: "discord" },
    ]);
    expect(
      plannedDeliveries(rule({ emailRecipients: [], webhookId: "json" }), "event", {
        event: "backup.succeeded",
        columns,
      }),
    ).toEqual([{ channel: "webhook", recipient: "json" }]);
    // A webhook without a column (deleted meanwhile) is left to the dispatcher.
    expect(
      plannedDeliveries(rule({ emailRecipients: [], webhookId: "gone" }), "event", {
        event: "backup.failed",
        columns,
      }),
    ).toEqual([{ channel: "webhook", recipient: "gone" }]);
  });

  it("never filters a summary report", () => {
    const columns = {
      webhooks: new Map([["w1", []]]),
      recipients: new Map([["a@x.de", { events: [], delivery: {} }]]),
    };
    expect(
      plannedDeliveries(rule({ emailRecipients: ["a@x.de"], webhookId: "w1" }), "summary", {
        event: "backup.failed",
        columns,
      }),
    ).toEqual([
      { channel: "email", recipient: "a@x.de" },
      { channel: "webhook", recipient: "w1" },
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

  it("makes every disk its own subject for the disk warning", () => {
    expect(subjectKeyOf("installation.disk_low", { disk: "database" })).toBe("disk:database");
    expect(subjectKeyOf("installation.disk_low", { disk: "repository" })).toBe("disk:repository");
  });

  it("makes every date and stage its own subject for the expiry reminders", () => {
    const expiresAt = "2027-03-01T00:00:00.000Z";
    expect(
      subjectKeyOf("source.app_secret_expiring", { sourceId: "s1", expiresAt, stage: "soon30" }),
    ).toBe(`source_app:s1:${expiresAt}:soon30`);
    expect(
      subjectKeyOf("source.app_secret_expiring", { sourceId: "s1", expiresAt, stage: "soon7" }),
    ).toBe(`source_app:s1:${expiresAt}:soon7`);
    expect(subjectKeyOf("installation.app_secret_expiring", { expiresAt, stage: "expired" })).toBe(
      `entra_app:${expiresAt}:expired`,
    );
    expect(subjectKeyOf("installation.app_secret_expiring", {})).toBe(
      "event:installation.app_secret_expiring",
    );
  });

  it("makes every restore mode activation its own subject", () => {
    expect(subjectKeyOf("installation.restore_mode", { restoreModeId: "rm-1" })).toBe(
      "restore_mode:rm-1",
    );
    expect(subjectKeyOf("installation.restore_mode", { restoreModeId: "rm-2" })).not.toBe(
      subjectKeyOf("installation.restore_mode", { restoreModeId: "rm-1" }),
    );
  });

  it("makes every tenant, target and key its own subject for a key that differs in storage", () => {
    const finding = { tenantId: "t1", targetId: "target-primary", keyVersion: 2 };
    const key = (details: Record<string, unknown>) =>
      subjectKeyOf("installation.key_mirror_conflict", details);
    expect(key(finding)).toBe("key_mirror:t1:target-primary:2");
    const others = [
      key({ ...finding, targetId: "target-copy" }),
      key({ ...finding, keyVersion: 3 }),
      key({ ...finding, tenantId: "t2" }),
      key({ ...finding, keyVersion: 0, objectKey: "tenants/t1/repo-passwords/a.json" }),
      key({ ...finding, keyVersion: 0, objectKey: "tenants/t1/repo-passwords/b.json" }),
    ];
    expect(new Set([key(finding), ...others]).size).toBe(6);
    expect(others[3]).toBe("key_mirror:t1:target-primary:tenants/t1/repo-passwords/a.json");
  });
});

describe("subjectKeyOf for objects no longer backed up", () => {
  it("keys the notice by its object and the mass warning by tenant and day", () => {
    expect(subjectKeyOf("object.inactive", { protectedObjectId: "po-1" })).toBe("inactive:po-1");
    expect(subjectKeyOf("object.inactive_many", { tenantId: "t1", date: "2026-10-29" })).toBe(
      "inactive_many:t1:2026-10-29",
    );
  });

  it("keeps the warning about many refused IMAP logins apart from the one about inactive objects", () => {
    const day = { tenantId: "t1", date: "2026-10-29" };
    expect(subjectKeyOf("object.inactive_many", { ...day, question: "login" })).toBe(
      "inactive_many:t1:2026-10-29:login",
    );
    expect(subjectKeyOf("object.inactive_many", { ...day, question: "login" })).not.toBe(
      subjectKeyOf("object.inactive_many", day),
    );
  });
});

describe("installation events", () => {
  it("are events about the installation, not a tenant's data, and only those", () => {
    expect(INSTALLATION_REPORT_EVENTS).toEqual([
      "update.available",
      "installation.disk_low",
      "installation.app_secret_expiring",
      "installation.restore_mode",
      "installation.key_mirror_conflict",
    ]);
    expect(isInstallationReportEvent("installation.restore_mode")).toBe(true);
    expect(isInstallationReportEvent("installation.app_secret_expiring")).toBe(true);
    expect(isInstallationReportEvent("source.app_secret_expiring")).toBe(false);
    expect(isInstallationReportEvent("installation.disk_low")).toBe(true);
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

describe("digests (0.5.0)", () => {
  const columns = {
    webhooks: new Map([["hook", ["backup.failed", "verify.red", "notification.delivery_failed"]]]),
    recipients: new Map([
      [
        "ops@x.de",
        {
          events: ["backup.failed", "verify.red", "backup.overdue"],
          delivery: { error: "hourly" as const, warning: "daily" as const },
        },
      ],
    ]),
  };

  it("holds an alert for the recipient's digest of its severity", () => {
    const r = rule({ emailRecipients: ["ops@x.de", "adhoc@x.de"], webhookId: "hook" });
    expect(plannedDeliveries(r, "event", { event: "backup.failed", columns })).toEqual([
      { channel: "email", recipient: "ops@x.de", digest: "hourly" },
      { channel: "email", recipient: "adhoc@x.de" },
      { channel: "webhook", recipient: "hook" },
    ]);
    expect(
      plannedDeliveries(r, "event", { event: "backup.overdue", columns, level: "warning" })[0],
    ).toEqual({ channel: "email", recipient: "ops@x.de", digest: "daily" });
  });

  it("sends critical events at once", () => {
    const r = rule({ emailRecipients: ["ops@x.de"] });
    expect(plannedDeliveries(r, "event", { event: "verify.red", columns })).toEqual([
      { channel: "email", recipient: "ops@x.de" },
    ]);
    expect(deliveryModeFor({ error: "daily" }, "notification.delivery_failed")).toBe("immediate");
    expect(deliveryModeFor({ error: "daily" }, "backup.failed")).toBe("daily");
    expect(deliveryModeFor({ error: "daily" }, "backup.failed", "info")).toBe("immediate");
  });

  it("never digests a summary report", () => {
    const r = rule({ emailRecipients: ["ops@x.de"] });
    expect(plannedDeliveries(r, "summary", { event: "backup.failed", columns })).toEqual([
      { channel: "email", recipient: "ops@x.de" },
    ]);
  });

  it("completes and stores the modes", () => {
    expect(completeDeliveryModes({ warning: "daily" })).toEqual({
      error: "immediate",
      warning: "daily",
      info: "immediate",
    });
    expect(storedDeliveryModes({ error: "immediate", info: "hourly" })).toEqual({ info: "hourly" });
  });

  it("is due at the next full hour, or at the next 07:00 in the zone", () => {
    const now = new Date("2026-03-28T10:15:00Z");
    expect(digestDueAt("hourly", now, "UTC").toISOString()).toBe("2026-03-28T11:00:00.000Z");
    expect(digestDueAt("hourly", new Date("2026-03-28T10:00:00Z"), "UTC").toISOString()).toBe(
      "2026-03-28T11:00:00.000Z",
    );
    // Berlin is UTC+1 on 28 March and UTC+2 from 29 March (daylight saving).
    expect(digestDueAt("daily", now, "Europe/Berlin").toISOString()).toBe(
      "2026-03-29T05:00:00.000Z",
    );
    expect(
      digestDueAt("daily", new Date("2026-03-28T05:00:00Z"), "Europe/Berlin").toISOString(),
    ).toBe("2026-03-28T06:00:00.000Z");
    expect(digestDueAt("daily", now, "Not/AZone").toISOString()).toBe("2026-03-29T07:00:00.000Z");
  });
});

describe("delivery failure exclusion (0.5.0)", () => {
  const columns = {
    webhooks: new Map([["hook", ["notification.delivery_failed"]]]),
    recipients: new Map(),
  };
  const r = rule({ emailRecipients: ["Ops@x.de", "b@x.de"], webhookId: "hook" });
  const plan = (details: Record<string, unknown>) =>
    plannedDeliveries(
      r,
      "event",
      { event: "notification.delivery_failed", columns },
      { exclude: deliveryFailureExclusion("notification.delivery_failed", details) },
    );

  it("never sends the alert through the webhook that failed", () => {
    expect(plan({ channel: "webhook", webhookId: "hook" })).toEqual([
      { channel: "email", recipient: "Ops@x.de" },
      { channel: "email", recipient: "b@x.de" },
    ]);
  });

  it("never mails the address that failed, and no mail while the transport is down", () => {
    expect(plan({ channel: "email", scope: "recipient", recipient: "ops@X.de" })).toEqual([
      { channel: "email", recipient: "b@x.de" },
      { channel: "webhook", recipient: "hook" },
    ]);
    expect(plan({ channel: "email", scope: "transport" })).toEqual([
      { channel: "webhook", recipient: "hook" },
    ]);
  });

  it("excludes nothing for other events", () => {
    expect(
      deliveryFailureExclusion("backup.failed", { channel: "webhook", webhookId: "x" }),
    ).toEqual({});
  });

  it("gives every failing channel its own subject", () => {
    expect(
      subjectKeyOf("notification.delivery_failed", { channel: "webhook", webhookId: "w1" }),
    ).toBe("delivery:webhook:w1");
    expect(
      subjectKeyOf("notification.delivery_failed", { channel: "email", scope: "transport" }),
    ).toBe("delivery:email:transport");
    expect(
      subjectKeyOf("notification.delivery_failed", {
        channel: "email",
        scope: "recipient",
        recipient: " A@X.de ",
      }),
    ).toBe("delivery:email:a@x.de");
  });
});
