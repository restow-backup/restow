import { endpointDetailTo } from "@/features/endpoints/paths";
import { installationSectionPath } from "@/features/installation/paths";
import { verifyReportTo } from "@/features/verify/paths";
import { tenantPagePath } from "@/lib/tenant-paths";

import type { BellNotification } from "./api";
import { REPORTS_PATH } from "./paths";

/**
 * Where a notification leads: the cause behind the line in the bell (the failed run, the
 * machine, the restore check, the storage, the delivery log), so a click opens it instead of
 * only marking it read. Tenant pages are admin pages; a viewer who may not open them gets no
 * target (`canManage` false), only an installation update leads a provider administrator on.
 */
export interface NotificationTarget {
  to: string;
  /** The tenant the target belongs to; under "All tenants" the bell switches into it first. */
  tenantId: string | null;
}

export interface TargetViewer {
  /** Administers the tenant (tenant admin or provider admin): the tenant's pages are open to them. */
  canManage: boolean;
  isProviderAdmin: boolean;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export function notificationTarget(
  item: Pick<BellNotification, "event" | "details" | "tenantId">,
  viewer: TargetViewer,
): NotificationTarget | null {
  const details = item.details ?? {};
  if (item.event.startsWith("update.")) {
    return viewer.isProviderAdmin
      ? { to: installationSectionPath("updates"), tenantId: null }
      : null;
  }
  if (!viewer.canManage) {
    return null;
  }
  const tenantId = item.tenantId;
  const at = (to: string): NotificationTarget => ({ to, tenantId });
  // A server or client: its own page says what happened and what to do.
  const endpointId = text(details.endpointId);
  if (endpointId) {
    return at(String(endpointDetailTo(endpointId)));
  }
  if (item.event.startsWith("verify.")) {
    const reportId = text(details.reportId);
    return at(reportId ? String(verifyReportTo(reportId)) : "/verify");
  }
  if (item.event.startsWith("scrub.")) {
    return tenantId ? at(tenantPagePath(tenantId, "storage")) : null;
  }
  if (item.event === "report.ready") {
    return at(REPORTS_PATH);
  }
  const jobId = text(details.jobId);
  if (jobId) {
    return at(`/history/${encodeURIComponent(jobId)}`);
  }
  if (item.event === "backup.overdue") {
    return at("/verify?state=red");
  }
  return null;
}
