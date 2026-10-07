import { audit } from "../../lib/audit.js";
import type { DbExecutor } from "../../lib/tenant-context.js";

/**
 * Audit actions of the Proxmox VE feature (docs/PVE.md). Every enrollment,
 * every backup and restore an admin asks for, and every attempt of a node to
 * do what it may not, lands in the tenant's audit log.
 */
export const PVE_AUDIT_ACTIONS = {
  tokenCreated: "pve.token.created",
  nodeEnrolled: "pve.node.enrolled",
  nodeRevoked: "pve.node.revoked",
  backupRequested: "pve.backup.requested",
  restoreRequested: "pve.restore.requested",
  verifyRequested: "pve.verify.requested",
  jobChanged: "pve.job.changed",
  snapshotCommitted: "pve.snapshot.committed",
  snapshotPruned: "pve.snapshot.pruned",
  denied: "pve.node.denied",
} as const;

export interface PveActor {
  label: string;
  userId: string | null;
  ip: string | null;
}

export function nodeActor(name: string, ip: string | null): PveActor {
  return { label: `pve-node:${name}`, userId: null, ip };
}

export async function auditPve(
  database: DbExecutor,
  input: {
    tenantId: string;
    actor: PveActor;
    action: string;
    target: string;
    targetType: "pve_node" | "pve_guest" | "pve_snapshot" | "pve_job" | "pve_enrollment_token";
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await audit(database, {
    tenantId: input.tenantId,
    actor: input.actor.label,
    actorUserId: input.actor.userId,
    ip: input.actor.ip,
    action: input.action,
    target: input.target,
    targetType: input.targetType,
    details: input.details ?? null,
  });
}
