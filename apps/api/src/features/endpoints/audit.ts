import { audit } from "../../lib/audit.js";
import type { DbExecutor } from "../../lib/tenant-context.js";

/**
 * The audit trail of the endpoint feature (docs/AGENT.md). Everything an
 * admin does to an endpoint, every enrollment, every read of backed-up files
 * (browse, download) and every restore lands in the tenant's audit log.
 */
export const ENDPOINT_AUDIT_ACTIONS = {
  tokenCreated: "endpoint.token.created",
  tokenRevoked: "endpoint.token.revoked",
  enrolled: "endpoint.enrolled",
  revoked: "endpoint.revoked",
  configChanged: "endpoint.config.changed",
  assigned: "endpoint.assigned",
  backupRequested: "endpoint.backup.requested",
  backupCancelled: "endpoint.backup.cancelled",
  updateRequested: "endpoint.update_requested",
  restoreRequested: "endpoint.restore.requested",
  restoreFinished: "endpoint.restore.finished",
  restoreTestRequested: "endpoint.restore_test.requested",
  uninstallRequested: "endpoint.uninstall.requested",
  /** Removed from Restow (#65); the worker's steps follow as `endpoint.removal.*`. */
  removed: "endpoint.removed",
  /** A provider owner asked to delete the backups of a revoked machine, in seven days (0.5.0). */
  removalScheduled: "endpoint.removal.scheduled",
  /** ... and someone cancelled that before the worker started. */
  removalCancelled: "endpoint.removal.cancelled",
  browse: "endpoint.snapshot.browsed",
  download: "endpoint.snapshot.downloaded",
  repositoryDenied: "endpoint.repository.denied",
  repositoryPasswordRevealed: "endpoint.repository.password.revealed",
  /** An admin downloaded or restored a LUKS key file of a snapshot (docs/BAREMETAL.md 5.4). */
  secretFileRevealed: "endpoint.repository.secret_file_revealed",
  updatesPaused: "endpoint.updates.paused",
  updatesResumed: "endpoint.updates.resumed",
  // Bare metal recovery (docs/BAREMETAL.md 9.9): every transition of a code and its session.
  recoveryCodeCreated: "endpoint.recovery_code.created",
  recoveryCodeRevoked: "endpoint.recovery_code.revoked",
  recoveryCodeExtended: "endpoint.recovery_code.extended",
  /** A code that is expired, used or revoked was tried (a sign of theft). */
  recoveryCodeRejected: "endpoint.recovery_code.rejected",
  recoveryStarted: "endpoint.recovery.started",
  recoveryApproved: "endpoint.recovery.approved",
  recoveryCredentialsIssued: "endpoint.recovery.credentials_issued",
  recoveryRemoteAccessEnabled: "endpoint.recovery.remote_access_enabled",
  recoveryKeyfileRegenerated: "endpoint.recovery.keyfile_regenerated",
  recoveryReleased: "endpoint.recovery.released",
  recoveryFinished: "endpoint.recovery.finished",
  /** The ISO wrote to a session that had ended (9.8): the first refused call, once per session. */
  recoveryReportRefused: "endpoint.recovery.report_refused",
  /** The monitor (or a late release) ended a code or a session that ran out of time. */
  recoveryExpired: "endpoint.recovery.expired",
  recoveryCancelled: "endpoint.recovery.cancelled",
  // Rebinding a machine (docs/BAREMETAL.md 11).
  rebindTokenCreated: "endpoint.rebind_token.created",
  // The boot probe of the lab (docs/BAREMETAL.md 12.3): asked for on the machine's page, and its
  // ISO redeemed the code the worker issued.
  bootProbeRequested: "endpoint.boot_probe.requested",
  bootProbeStarted: "endpoint.boot_probe.started",
  rebound: "endpoint.rebound",
  unrevoked: "endpoint.unrevoked",
  // The native SQL Server backup (W2a, docs/BAREMETAL-WINDOWS.md 5.1)
  sqlRestoreRequested: "endpoint.sql.restore.requested",
  sqlRestoreFinished: "endpoint.sql.restore.finished",
  sqlVerifyRequested: "endpoint.sql.verify.requested",
  sqlInventoryRequested: "endpoint.sql.inventory.requested",
  sqlRestoreScriptDownloaded: "endpoint.sql.restore_script.downloaded",
  sqlTdeConfirmed: "endpoint.sql.tde.confirmed",
} as const;

/** Who did it: a signed-in admin, or the agent of an endpoint. */
export interface EndpointActor {
  label: string;
  userId: string | null;
  ip: string | null;
}

export function agentActor(hostname: string, ip: string | null): EndpointActor {
  return { label: `agent:${hostname}`, userId: null, ip };
}

/** The recovery ISO of a session (docs/BAREMETAL.md 9): its reports are marked as its own. */
export function recoveryActor(recoveryId: string, ip: string | null): EndpointActor {
  return { label: `recovery:${recoveryId}`, userId: null, ip };
}

/** The server itself (the monitor, a late transition). */
export const SYSTEM_ACTOR: EndpointActor = { label: "system", userId: null, ip: null };

export async function auditEndpoint(
  db: DbExecutor,
  input: {
    tenantId: string;
    actor: EndpointActor;
    action: string;
    endpointId: string;
    details?: Record<string, unknown>;
    /** Another target than the machine (a rebind token). */
    target?: { id: string; type: string };
  },
): Promise<void> {
  await audit(db, {
    tenantId: input.tenantId,
    actor: input.actor.label,
    actorUserId: input.actor.userId,
    ip: input.actor.ip,
    action: input.action,
    target: input.target?.id ?? input.endpointId,
    targetType: input.target?.type ?? "endpoint",
    details: input.details ?? null,
  });
}
