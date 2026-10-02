import { describe, expect, it } from "vitest";
import {
  type BackupTargetView,
  automaticFirstBackupJobIds,
  classifyOutcomes,
  demoReportRules,
  isDemoJobInProgress,
  objectsWithoutFirstBackup,
  setupRequest,
} from "./api-seed.js";
import { DEMO_PROVIDER_NAME, DEMO_TENANTS } from "./company.js";

describe("classifyOutcomes", () => {
  it("counts completed jobs as completed", () => {
    const outcomes = new Map([
      ["a", "completed"],
      ["b", "completed"],
    ]);
    expect(classifyOutcomes(["a", "b"], outcomes)).toEqual({ completed: 2, failed: 0 });
  });

  it("counts failed and cancelled jobs as failed", () => {
    const outcomes = new Map([
      ["a", "failed"],
      ["b", "cancelled"],
    ]);
    expect(classifyOutcomes(["a", "b"], outcomes)).toEqual({ completed: 0, failed: 2 });
  });

  it("counts a job that never reached a terminal status (timeout) as failed", () => {
    const outcomes = new Map([["a", undefined]]);
    expect(classifyOutcomes(["a"], outcomes)).toEqual({ completed: 0, failed: 1 });
  });

  it("counts a job missing from the outcomes map as failed", () => {
    expect(classifyOutcomes(["a"], new Map())).toEqual({ completed: 0, failed: 1 });
  });

  it("is empty for no jobs", () => {
    expect(classifyOutcomes([], new Map())).toEqual({ completed: 0, failed: 0 });
  });

  it("mixes completed and failed correctly", () => {
    const outcomes = new Map([
      ["a", "completed"],
      ["b", "failed"],
      ["c", "completed"],
    ]);
    expect(classifyOutcomes(["a", "b", "c"], outcomes)).toEqual({ completed: 2, failed: 1 });
  });
});

function target(overrides: Partial<BackupTargetView> & { id: string }): BackupTargetView {
  return {
    displayName: null,
    status: "active",
    lastSnapshot: null,
    lastJob: null,
    ...overrides,
  };
}

describe("automaticFirstBackupJobIds", () => {
  it("collects the backup job Restow queued for each object, skipping objects without one", () => {
    const objects = [
      target({ id: "info", lastJob: { id: "job-1" } }),
      target({ id: "buchhaltung" }),
      target({ id: "vertrieb", lastJob: { id: "job-2" } }),
    ];
    expect(automaticFirstBackupJobIds(objects)).toEqual(["job-1", "job-2"]);
  });

  it("is empty when nothing was queued", () => {
    expect(automaticFirstBackupJobIds([target({ id: "info" })])).toEqual([]);
  });
});

describe("objectsWithoutFirstBackup", () => {
  it("picks an active object that never had a backup queued", () => {
    const objects = [
      target({ id: "info", lastJob: { id: "job-1" } }),
      target({ id: "buchhaltung" }),
    ];
    expect(objectsWithoutFirstBackup(objects).map((object) => object.id)).toEqual(["buchhaltung"]);
  });

  it("leaves an object alone once it has a completed snapshot", () => {
    const objects = [target({ id: "info", lastSnapshot: { id: "snap-1" } })];
    expect(objectsWithoutFirstBackup(objects)).toEqual([]);
  });

  it("does not retry an object whose automatic first backup failed", () => {
    // No snapshot, but a job: its outcome was already counted, a retry would hide it.
    const objects = [target({ id: "info", lastJob: { id: "job-failed" } })];
    expect(objectsWithoutFirstBackup(objects)).toEqual([]);
  });

  it("ignores objects that are not protected", () => {
    const objects = [
      target({ id: "excluded", status: "excluded" }),
      target({ id: "orphaned", status: "orphaned" }),
    ];
    expect(objectsWithoutFirstBackup(objects)).toEqual([]);
  });
});

describe("isDemoJobInProgress", () => {
  const problem = {
    type: "urn:restow:problem:demo-job-in-progress",
    title: "Demo: one job of this kind at a time",
    status: 409,
    queue: "verify",
  };

  it("recognises the demo mode's one-job-per-queue refusal", () => {
    expect(isDemoJobInProgress(409, problem)).toBe(true);
  });

  it("does not wait out any other conflict", () => {
    expect(isDemoJobInProgress(409, { ...problem, type: "urn:restow:problem:conflict" })).toBe(
      false,
    );
  });

  it("does not wait out the same problem type on a different status", () => {
    expect(isDemoJobInProgress(429, problem)).toBe(false);
  });

  it("does not wait out a body that is not a problem document", () => {
    expect(isDemoJobInProgress(409, null)).toBe(false);
    expect(isDemoJobInProgress(409, "busy")).toBe(false);
  });
});

describe("demoReportRules", () => {
  it("gives every demo tenant one alert and one weekly report on the example domain", () => {
    const rules = demoReportRules("example-trading");
    expect(rules.map((rule) => rule.trigger)).toEqual(["event", "schedule"]);
    for (const rule of rules) {
      expect(rule.emailRecipients).toEqual(["it@example-trading.example"]);
    }
    expect(rules[1]).toMatchObject({ cron: "0 7 * * 1", inApp: true });
  });
});

describe("setupRequest", () => {
  const request = setupRequest({
    publicUrl: "https://demo.restow.example",
    adminName: "Demo",
    adminEmail: "demo@example.com",
    adminPassword: "public-demo-password",
  });

  it("names the demo's own organisation, which the api creates as the first tenant", () => {
    expect(request.providerName).toBe(DEMO_PROVIDER_NAME);
    expect(DEMO_PROVIDER_NAME.trim().length).toBeGreaterThan(0);
    expect(DEMO_PROVIDER_NAME.length).toBeLessThanOrEqual(200);
  });

  it("gives the own organisation a name of its own: no customer shares its name or its slug", () => {
    const slugOfOwn = DEMO_PROVIDER_NAME.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    for (const tenant of DEMO_TENANTS) {
      expect(tenant.name).not.toBe(DEMO_PROVIDER_NAME);
      expect(tenant.slug).not.toBe(slugOfOwn);
    }
  });

  it("is the wizard's request, with the admin the demo documents and a mail setup that is never used", () => {
    expect(request).toMatchObject({
      operatingMode: "public",
      publicUrl: "https://demo.restow.example",
      firstAdmin: { email: "demo@example.com", password: "public-demo-password" },
      mail: { transport: "smtp", smtp: { from: "noreply@demo.restow.example" } },
      sendTest: false,
    });
  });
});
