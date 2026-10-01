import { describe, expect, it } from "vitest";

import { rulesFromRecipients } from "./defaults.js";

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
        { email: "IT@kanzlei.test", categories: ["jobFailures", "weeklyReport", "readinessRed"] },
        { email: "it@kanzlei.test", categories: ["jobFailures"] },
        { email: "chef@kanzlei.test", categories: ["jobFailures", "licenseUpdates"] },
      ],
    });
    expect(rules.map((rule) => [rule.name, rule.trigger, rule.emailRecipients])).toEqual([
      ["Fehlgeschlagene Aufträge", "event", ["it@kanzlei.test", "chef@kanzlei.test"]],
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
        recipients: [{ email: "a@x.test", categories: ["weeklyReport", "licenseUpdates"] }],
      }),
    ).toEqual([]);
  });

  it("names rules in English for any other language and falls back to UTC", () => {
    const [rule] = rulesFromRecipients({
      ...base,
      language: null,
      timeZone: null,
      recipients: [{ email: "a@x.test", categories: ["weeklyReport"] }],
    });
    expect(rule).toMatchObject({ name: "Weekly report", timezone: "UTC" });
  });
});
