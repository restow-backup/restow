import { audit } from "../../lib/audit.js";
import type { DbExecutor } from "../../lib/tenant-context.js";

/**
 * The audit trail of the file share routes (docs/FILESHARES.md 9.2). Everything an admin does
 * to a share, every read of backed-up files (browse, search, download) and every restore lands
 * in the tenant's audit log. Details never hold the password, a run token, a mount option string
 * or an unredacted mount detail; the account name and the server are fine.
 */
export const FILE_SHARE_TENANT_AUDIT_ACTIONS = {
  created: "file_share.created",
  updated: "file_share.updated",
  passwordChanged: "file_share.password_changed",
  tested: "file_share.tested",
  retired: "file_share.retired",
  reactivated: "file_share.reactivated",
  purgeRequested: "file_share.purge_requested",
  backupRequested: "file_share.backup_requested",
  restoreRequested: "file_share.restore_requested",
  restoreTestRequested: "file_share.restore_test_requested",
  runCancelled: "file_share.run_cancel_requested",
  quotaChanged: "file_share.quota_changed",
  downloadCreated: "file_share.download_created",
  downloaded: "file_share.downloaded",
  browsed: "file_share.browsed",
  searched: "file_share.searched",
  repositoryPasswordShown: "file_share.repository_password_shown",
  privateNetworkApproved: "file_share.private_network_approved",
  privateNetworkWithdrawn: "file_share.private_network_withdrawn",
  settingsChanged: "file_share.settings_changed",
} as const;

/** Who did it: a signed-in admin. */
export interface FileShareActor {
  label: string;
  userId: string | null;
  ip: string | null;
}

export async function auditShare(
  db: DbExecutor,
  input: {
    tenantId: string | null;
    actor: FileShareActor;
    action: string;
    shareId: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await audit(db, {
    tenantId: input.tenantId,
    actor: input.actor.label,
    actorUserId: input.actor.userId,
    ip: input.actor.ip,
    action: input.action,
    target: input.shareId,
    targetType: input.shareId ? "file_share" : null,
    details: input.details ?? null,
  });
}
