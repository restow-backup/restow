import { describe, expect, it } from "vitest";
import { SETUP_ITEM_IDS } from "./dto.js";
import { type SetupFacts, buildSetupChecklist, canActOn } from "./setup.js";

const READY: SetupFacts = {
  storage: { source: "tenant", status: "ok" },
  sources: { active: 1, error: 0, pending: 0 },
  activeObjects: 12,
  enabledBackupSchedules: 1,
  completedSnapshots: 30,
  verification: { reports: 4, green: 3 },
  mail: { configured: true, lastTestOk: true },
};

const FRESH: SetupFacts = {
  storage: { source: "installation_default", status: "unverified" },
  sources: { active: 0, error: 0, pending: 0 },
  activeObjects: 0,
  enabledBackupSchedules: 0,
  completedSnapshots: 0,
  verification: { reports: 0, green: 0 },
  mail: { configured: false, lastTestOk: null },
};

function stateOf(facts: SetupFacts, id: string) {
  const item = buildSetupChecklist(facts, "tenant_admin").items.find((entry) => entry.id === id);
  return item ? { state: item.state, reason: item.reason } : null;
}

describe("setup checklist", () => {
  it("lists every step in order and is complete when all are done", () => {
    const checklist = buildSetupChecklist(READY, "provider_admin");
    expect(checklist.items.map((item) => item.id)).toEqual([...SETUP_ITEM_IDS]);
    expect(checklist).toMatchObject({ complete: true, done: 7, total: 7 });
  });

  it("starts with nothing done on a fresh tenant", () => {
    const checklist = buildSetupChecklist(FRESH, "provider_admin");
    expect(checklist).toMatchObject({ complete: false, done: 0, total: 7 });
    expect(checklist.items.every((item) => item.state === "open")).toBe(true);
  });

  it("flags what is set up but broken instead of calling it open", () => {
    expect(
      stateOf({ ...READY, storage: { source: "tenant", status: "error" } }, "storage"),
    ).toEqual({ state: "attention", reason: "target_error" });
    expect(
      stateOf(
        { ...READY, storage: { source: "installation_default", status: "misconfigured" } },
        "storage",
      ),
    ).toEqual({ state: "attention", reason: "default_misconfigured" });
    expect(stateOf({ ...READY, sources: { active: 0, error: 1, pending: 1 } }, "source")).toEqual({
      state: "attention",
      reason: "source_error",
    });
    expect(
      stateOf({ ...READY, verification: { reports: 2, green: 0 } }, "firstVerification"),
    ).toEqual({ state: "attention", reason: "not_green" });
    expect(
      stateOf({ ...READY, mail: { configured: true, lastTestOk: false } }, "notificationMail"),
    ).toEqual({ state: "attention", reason: "test_failed" });
  });

  it("says why an open step is open", () => {
    expect(stateOf(FRESH, "storage")?.reason).toBe("default_untested");
    expect(
      stateOf({ ...FRESH, storage: { source: "tenant", status: "unverified" } }, "storage")?.reason,
    ).toBe("target_unverified");
    expect(
      stateOf({ ...FRESH, sources: { active: 0, error: 0, pending: 1 } }, "source")?.reason,
    ).toBe("consent_pending");
    expect(stateOf(FRESH, "schedules")?.reason).toBe("no_backup_schedule");
    expect(stateOf(FRESH, "notificationMail")?.reason).toBe("not_configured");
    expect(
      stateOf({ ...FRESH, mail: { configured: true, lastTestOk: null } }, "notificationMail")
        ?.reason,
    ).toBe("not_tested");
  });

  it("marks steps the viewer cannot fix as information", () => {
    expect(canActOn("notificationMail", "provider_admin")).toBe(true);
    expect(canActOn("notificationMail", "tenant_admin")).toBe(false);
    expect(canActOn("storage", "tenant_admin")).toBe(true);
    expect(canActOn("storage", "tenant_user")).toBe(false);

    const forUser = buildSetupChecklist(FRESH, "tenant_user");
    expect(forUser.items.some((item) => item.actionable)).toBe(false);
    const forAdmin = buildSetupChecklist(FRESH, "tenant_admin");
    expect(forAdmin.items.filter((item) => !item.actionable).map((item) => item.id)).toEqual([
      "notificationMail",
    ]);
  });
});
