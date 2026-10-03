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
  restoreRequested: "endpoint.restore.requested",
  restoreFinished: "endpoint.restore.finished",
  restoreTestRequested: "endpoint.restore_test.requested",
  uninstallRequested: "endpoint.uninstall.requested",
  browse: "endpoint.snapshot.browsed",
  download: "endpoint.snapshot.downloaded",
  repositoryDenied: "endpoint.repository.denied",
  repositoryPasswordRevealed: "endpoint.repository.password.revealed",
  updatesPaused: "endpoint.updates.paused",
  updatesResumed: "endpoint.updates.resumed",
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

export async function auditEndpoint(
  db: DbExecutor,
  input: {
    tenantId: string;
    actor: EndpointActor;
    action: string;
    endpointId: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await audit(db, {
    tenantId: input.tenantId,
    actor: input.actor.label,
    actorUserId: input.actor.userId,
    ip: input.actor.ip,
    action: input.action,
    target: input.endpointId,
    targetType: "endpoint",
    details: input.details ?? null,
  });
}
