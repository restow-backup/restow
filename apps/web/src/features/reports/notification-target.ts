import {
  ARCHIVE_PATH,
  CAPTURE_SECTION_ANCHOR,
  FORWARDING_SECTION_ANCHOR,
  JOURNAL_SECTION_ANCHOR,
} from "@/features/archive/paths";
import { endpointDetailTo } from "@/features/endpoints/paths";
import { FILE_SHARES_PATH } from "@/features/file-shares/paths";
import { installationSectionPath } from "@/features/installation/paths";
import { guestTo } from "@/features/pve/paths";
import { RESTORE_PATHS } from "@/features/restore/navigation";
import { sourceDetailTo } from "@/features/sources/paths";
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
  // A move of the database and a disk running low: Installation > Database.
  if (item.event.startsWith("database.") || item.event === "installation.disk_low") {
    return viewer.isProviderAdmin
      ? { to: installationSectionPath("database"), tenantId: null }
      : null;
  }
  // The central Microsoft 365 app's credential runs out: Installation > Microsoft 365 app.
  if (item.event === "installation.app_secret_expiring") {
    return viewer.isProviderAdmin
      ? { to: installationSectionPath("microsoft-app"), tenantId: null }
      : null;
  }
  if (!viewer.canManage) {
    return null;
  }
  const tenantId = item.tenantId;
  const at = (to: string): NotificationTarget => ({ to, tenantId });
  // Objects no longer backed up: the tenant's protected objects that wait for a decision.
  if (item.event === "object.inactive" || item.event === "object.inactive_many") {
    return at(
      tenantId
        ? `${tenantPagePath(tenantId, "protection")}?status=to_confirm`
        : "/protected-objects?status=to_confirm",
    );
  }
  // A source's own app credential runs out: the source's page, where its date is noted.
  const sourceId = text(details.sourceId);
  if (item.event === "source.app_secret_expiring" && sourceId) {
    return at(
      tenantId
        ? tenantPagePath(tenantId, "connections", "sources", sourceId)
        : String(sourceDetailTo(sourceId)),
    );
  }
  // A server or client: its own page says what happened and what to do.
  const endpointId = text(details.endpointId);
  if (endpointId) {
    return at(String(endpointDetailTo(endpointId)));
  }
  // A VM or container of Proxmox VE: its page has the restore points and the runs.
  const guestId = text(details.pveGuestId);
  if (guestId) {
    return at(String(guestTo(guestId).to));
  }
  // A file share: its restore points, where the suspicious ones are marked.
  const shareId = text(details.fileShareId);
  if (shareId && item.event.startsWith("backup.suspicious")) {
    return at(`${FILE_SHARES_PATH}/${encodeURIComponent(shareId)}?tab=restore-points`);
  }
  // A suspicious mailbox or OneDrive: the explorer at that account, its restore points marked.
  const objectId = text(details.protectedObjectId);
  if (objectId && item.event.startsWith("backup.suspicious")) {
    return at(`${RESTORE_PATHS.explorer}?object=${encodeURIComponent(objectId)}`);
  }
  // An alert of the archive capture: the archive page at the section that shows it.
  if (item.event === "archive.failed") {
    const section =
      details.reason === "capture_error"
        ? CAPTURE_SECTION_ANCHOR
        : details.reason === "forward_stale"
          ? FORWARDING_SECTION_ANCHOR
          : details.reason === "journal_stale"
            ? JOURNAL_SECTION_ANCHOR
            : null;
    if (section) {
      return at(`${ARCHIVE_PATH}#${section}`);
    }
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
