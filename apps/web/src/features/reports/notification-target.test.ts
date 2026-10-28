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

  it("opens the restore points of a suspicious backup", () => {
    const suspicious = (details: Record<string, unknown>) =>
      notificationTarget({ event: "backup.suspicious", tenantId, details }, admin)?.to;
    expect(suspicious({ endpointId: "ep-1" })).toBe("/inventory/ep-1");
    expect(suspicious({ pveGuestId: "g-1" })).toBe("/virtualization/g-1");
    expect(suspicious({ fileShareId: "fs-1" })).toBe("/file-shares/fs-1?tab=restore-points");
    expect(suspicious({ protectedObjectId: "o-1" })).toBe("/restore?object=o-1");
  });

  it("opens the archive page at the capture, forwarding or journal section", () => {
    const archive = (details: Record<string, unknown>) =>
      notificationTarget({ event: "archive.failed", tenantId, details }, admin)?.to;
    expect(archive({ reason: "capture_error", protectedObjectId: "o-1" })).toBe(
      "/archive#archive-capture",
    );
    expect(archive({ reason: "forward_stale", protectedObjectId: "o-1" })).toBe(
      "/archive#archive-forwarding",
    );
    expect(archive({ reason: "journal_stale" })).toBe("/archive#archive-journal");
    // A failed archive job still opens its run.
    expect(archive({ jobId: "job-1", queue: "archive" })).toBe("/history/job-1");
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

  it("leads an expiring app credential to the central app or to the source", () => {
    const central = {
      event: "installation.app_secret_expiring",
      tenantId: null,
      details: { stage: "soon7", expiresAt: "2026-11-01T00:00:00.000Z" },
    };
    expect(notificationTarget(central, { canManage: true, isProviderAdmin: true })).toEqual({
      to: "/installation/microsoft-app",
      tenantId: null,
    });
    expect(notificationTarget(central, admin)).toBeNull();

    const source = {
      event: "source.app_secret_expiring",
      tenantId,
      details: { sourceId: "src-1", stage: "soon30" },
    };
    expect(notificationTarget(source, admin)).toEqual({
      to: `/tenants/${tenantId}/connections/sources/src-1`,
      tenantId,
    });
    // Tenant pages are admin pages: a viewer gets no target.
    expect(notificationTarget(source, { canManage: false, isProviderAdmin: false })).toBeNull();
  });
});
