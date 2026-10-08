import { describe, expect, it } from "vitest";

import type { ReportRule } from "./api";
import {
  EVENT_GROUPS,
  emptyRuleForm,
  eventGroupsFor,
  formToInput,
  parseOverdueHours,
  parseRecipients,
  presetCron,
  presetOf,
  ruleToForm,
  validateRuleForm,
} from "./presenters";

describe("cadence presets", () => {
  it("builds daily, weekly and monthly cron expressions and reads them back", () => {
    expect(presetCron("daily", 1, "07:30")).toBe("30 7 * * *");
    expect(presetCron("weekly", 5, "18:00")).toBe("0 18 * * 5");
    expect(presetCron("monthly", 1, "06:05")).toBe("5 6 1 * *");
    expect(presetCron("daily", 1, "25:00")).toBeNull();
    expect(presetOf("30 7 * * *")).toEqual({ frequency: "daily", weekday: 1, time: "07:30" });
    expect(presetOf("0 18 * * 5")).toEqual({ frequency: "weekly", weekday: 5, time: "18:00" });
    expect(presetOf("5 6 1 * *")).toEqual({ frequency: "monthly", weekday: 1, time: "06:05" });
    expect(presetOf("*/15 * * * *")).toBeNull();
    expect(presetOf(null)).toBeNull();
  });
});

describe("parseRecipients", () => {
  it("splits on lines, commas and semicolons, lower-cases and deduplicates", () => {
    expect(parseRecipients("Ops@Example.com, ops@example.com;\nnot-an-address\n\n")).toEqual({
      valid: ["ops@example.com"],
      invalid: ["not-an-address"],
    });
  });
});

describe("validateRuleForm", () => {
  it("needs a name, an event and a channel for an alert", () => {
    const form = { ...emptyRuleForm("event", "UTC"), events: [] };
    expect(validateRuleForm(form)).toEqual({
      name: "editor.errors.name",
      events: "editor.errors.events",
      channels: "editor.errors.channels",
    });
  });

  it("accepts a report that only goes to the bell", () => {
    const form = { ...emptyRuleForm("schedule", "UTC"), name: "Weekly" };
    expect(validateRuleForm(form)).toEqual({});
  });

  it("does not count the bell as a channel for alerts, which reach it anyway", () => {
    const form = { ...emptyRuleForm("event", "UTC"), name: "Alerts", inApp: true };
    expect(validateRuleForm(form).channels).toBe("editor.errors.channels");
  });
});

describe("formToInput / ruleToForm", () => {
  it("turns a weekly report into a cron rule and back", () => {
    const form = {
      ...emptyRuleForm("schedule", "Europe/Berlin"),
      name: " Weekly report ",
      recipientsText: "a@x.de\nb@x.de",
    };
    const input = formToInput(form);
    expect(input).toMatchObject({
      trigger: "schedule",
      name: "Weekly report",
      cron: "0 7 * * 1",
      intervalMinutes: null,
      timezone: "Europe/Berlin",
      events: [],
      emailRecipients: ["a@x.de", "b@x.de"],
      inApp: true,
    });
    const rule = {
      ...input,
      id: "r1",
      nextRunAt: null,
      lastRunAt: null,
      locked: false,
      lastDelivery: null,
      createdAt: "",
      updatedAt: "",
    } as ReportRule;
    expect(ruleToForm(rule)).toMatchObject({ frequency: "weekly", weekday: 1, time: "07:00" });
  });

  it("keeps an alert's events in catalog order and drops report-only fields", () => {
    const form = {
      ...emptyRuleForm("event", "UTC"),
      name: "Alerts",
      events: ["verify.red", "backup.failed"] as const,
      recipientsText: "ops@example.com",
      inApp: true,
    };
    expect(formToInput({ ...form, events: [...form.events] })).toMatchObject({
      events: ["backup.failed", "verify.red"],
      cron: null,
      sections: [],
      inApp: false,
    });
  });
});

describe("a rule's own deadline for missing backups", () => {
  const overdue = {
    ...emptyRuleForm("event", "UTC"),
    name: "Overdue",
    events: ["backup.overdue" as const],
    recipientsText: "ops@example.com",
  };

  it("follows the schedules unless the rule sets its own deadline", () => {
    expect(formToInput(overdue).overdueAfterHours).toBeNull();
    expect(formToInput({ ...overdue, overdueCustom: true, overdueHours: "48" })).toMatchObject({
      overdueAfterHours: 48,
    });
    // Without the event the deadline belongs to, nothing is sent.
    expect(
      formToInput({
        ...overdue,
        events: ["backup.failed"],
        overdueCustom: true,
        overdueHours: "48",
      }).overdueAfterHours,
    ).toBeNull();
  });

  it("takes whole hours from a day to 30 days only", () => {
    for (const text of ["23", "721", "36.5", "", "abc"]) {
      expect(
        validateRuleForm({ ...overdue, overdueCustom: true, overdueHours: text }).overdueHours,
        text,
      ).toBe("editor.errors.overdueHours");
    }
    expect(validateRuleForm({ ...overdue, overdueCustom: true, overdueHours: " 720 " })).toEqual(
      {},
    );
    expect(parseOverdueHours("24")).toBe(24);
    // Not checked while the rule follows the schedules.
    expect(validateRuleForm({ ...overdue, overdueHours: "1" })).toEqual({});
  });

  it("reads a rule's deadline back into the form", () => {
    const rule = {
      ...formToInput({ ...overdue, overdueCustom: true, overdueHours: "96" }),
      id: "r1",
      nextRunAt: null,
      lastRunAt: null,
      locked: false,
      lastDelivery: null,
      recipientCategory: null,
      createdAt: "",
      updatedAt: "",
    } as ReportRule;
    expect(ruleToForm(rule)).toMatchObject({ overdueCustom: true, overdueHours: "96" });
    expect(ruleToForm({ ...rule, overdueAfterHours: null })).toMatchObject({
      overdueCustom: false,
      overdueHours: "72",
    });
  });
});

describe("event groups", () => {
  it("offers the installation's own events to provider administrators only", () => {
    expect(eventGroupsFor(true)).toContain("system");
    expect(eventGroupsFor(false)).not.toContain("system");
    expect(eventGroupsFor(false)).toEqual(["jobs", "recoverability", "storage"]);
    expect(EVENT_GROUPS.system).toEqual(["update.available"]);
  });
});
