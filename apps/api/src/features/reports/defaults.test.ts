import { describe, expect, it } from "vitest";

import {
  categoriesOfEvents,
  eventsOfCategories,
  keepInstallationEvents,
  rulesFromRecipients,
} from "./defaults.js";

const base = {
  tenantId: "t1",
  language: "de" as const,
  timeZone: "Europe/Berlin",
  createdBy: "u1",
  scheduledAllowed: true,
  now: new Date("2026-09-30T12:00:00Z"),
};

describe("rulesFromRecipients", () => {
  it("makes one rule per chosen category, named in the tenant's language", () => {
    const rules = rulesFromRecipients({
      ...base,
      recipients: [
        {
          email: "IT@kanzlei.test",
          events: eventsOfCategories(["jobFailures", "weeklyReport", "readinessRed"]),
        },
        { email: "it@kanzlei.test", events: eventsOfCategories(["jobFailures"]) },
        {
          email: "chef@kanzlei.test",
          events: eventsOfCategories(["jobFailures", "licenseUpdates"]),
        },
      ],
    });
    expect(rules.map((rule) => [rule.name, rule.trigger, rule.emailRecipients])).toEqual([
      ["Fehlgeschlagene Läufe", "event", ["it@kanzlei.test", "chef@kanzlei.test"]],
      ["Wiederherstellbarkeit gefährdet", "event", ["it@kanzlei.test"]],
      ["Wochenbericht", "schedule", ["it@kanzlei.test"]],
    ]);
    // Monday 07:00 in Berlin is 05:00 UTC.
    expect(rules[2]?.nextRunAt?.toISOString()).toBe("2026-10-05T05:00:00.000Z");
  });

  it("skips the weekly report while timed reports are off and creates nothing for the legacy notice category", () => {
    expect(
      rulesFromRecipients({
        ...base,
        scheduledAllowed: false,
        recipients: [
          { email: "a@x.test", events: eventsOfCategories(["weeklyReport", "licenseUpdates"]) },
        ],
      }),
    ).toEqual([]);
  });

  it("names rules in English for any other language and falls back to UTC", () => {
    const [rule] = rulesFromRecipients({
      ...base,
      language: null,
      timeZone: null,
      recipients: [{ email: "a@x.test", events: ["report.weekly"] }],
    });
    expect(rule).toMatchObject({ name: "Weekly report", timezone: "UTC" });
  });
});

describe("recipient events", () => {
  it("adds one rule per severity for the events the fixed rules do not cover", () => {
    const rules = rulesFromRecipients({
      ...base,
      language: "en",
      recipients: [
        { email: "a@x.test", events: ["backup.failed", "endpoint.suspicious_snapshot"] },
        { email: "b@x.test", events: ["backup.overdue", "backup.succeeded", "restore.completed"] },
      ],
    });
    expect(
      rules.map((rule) => [rule.recipientCategory, rule.events, rule.emailRecipients]),
    ).toEqual([
      ["jobFailures", RULE_FAILURES, ["a@x.test"]],
      ["errors", ["endpoint.suspicious_snapshot"], ["a@x.test"]],
      ["warnings", ["backup.overdue"], ["b@x.test"]],
      ["notices", ["backup.succeeded", "restore.completed"], ["b@x.test"]],
    ]);
    expect(rules.map((rule) => rule.name)).toEqual([
      "Failed runs",
      "Other errors",
      "Warnings",
      "Notices",
    ]);
  });

  it("translates categories both ways", () => {
    expect(eventsOfCategories(["readinessRed", "weeklyReport"])).toEqual([
      "verify.red",
      "scrub.corrupt",
      "report.weekly",
    ]);
    expect(categoriesOfEvents(["verify.red", "scrub.corrupt", "backup.failed"])).toEqual([
      "readinessRed",
    ]);
  });

  it("keeps the installation events for a save by a tenant administrator", () => {
    expect(
      keepInstallationEvents(["update.available", "verify.red"], ["update.available"]),
    ).toEqual(["verify.red", "update.available"]);
    expect(keepInstallationEvents(["update.available"], undefined)).toEqual([]);
  });
});

const RULE_FAILURES = ["backup.failed", "restore.failed", "archive.failed", "directory.failed"];
