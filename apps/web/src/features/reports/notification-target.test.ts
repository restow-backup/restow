import { describe, expect, it } from "vitest";

import { notificationTarget } from "./notification-target";

const admin = { canManage: true, isProviderAdmin: false };
const tenantId = "11111111-1111-4111-8111-111111111111";

describe("where a notification leads", () => {
  it("opens the failed run, the machine, the restore check or the storage", () => {
    expect(
      notificationTarget(
        { event: "backup.failed", tenantId, details: { jobId: "job-1", queue: "backup" } },
        admin,
      ),
    ).toEqual({ to: "/history/job-1", tenantId });
    expect(
      notificationTarget(
        { event: "backup.failed", tenantId, details: { endpointId: "ep-1", runId: "run-1" } },
        admin,
      ),
    ).toEqual({ to: "/inventory/ep-1", tenantId });
    expect(
      notificationTarget(
        { event: "backup.overdue", tenantId, details: { pveGuestId: "g-1", days: 2 } },
        admin,
      ),
    ).toEqual({ to: "/virtualization/g-1", tenantId });
    expect(
      notificationTarget(
        { event: "verify.red", tenantId, details: { protectedObjectId: "o", reportId: "r-1" } },
        admin,
      ),
    ).toEqual({ to: "/verify/reports/r-1", tenantId });
    expect(
      notificationTarget({ event: "scrub.corrupt", tenantId, details: {} }, admin)?.to,
    ).toMatch(/storage/);
    expect(notificationTarget({ event: "report.ready", tenantId, details: {} }, admin)?.to).toBe(
      "/alerts",
    );
  });

  it("gives a viewer without the tenant's admin pages no target, never a Forbidden page", () => {
    expect(
      notificationTarget(
        { event: "backup.failed", tenantId, details: { jobId: "job-1" } },
        { canManage: false, isProviderAdmin: false },
      ),
    ).toBeNull();
  });

  it("leads an installation update to Installation, Updates for provider administrators only", () => {
    const update = { event: "update.available", tenantId: null, details: { version: "1.0.0" } };
    expect(notificationTarget(update, { canManage: true, isProviderAdmin: true })).toEqual({
      to: "/installation/updates",
      tenantId: null,
    });
    expect(notificationTarget(update, admin)).toBeNull();
  });
});
