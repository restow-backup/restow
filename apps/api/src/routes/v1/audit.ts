import type { AuditEvent } from "../../lib/audit.js";
import type { KeyActor } from "./actor.js";
import type { V1Deps } from "./api.js";

/**
 * Audit actions of the integration API. Every read of user or backup data
 * through `/api/v1` is recorded (docs/ARCHITECTURE.md, API section); writes delegated to a
 * feature service are recorded by that service under its own action.
 */
export const V1_AUDIT_ACTIONS = {
  objectsRead: "api.objects.read",
  endpointsRead: "api.endpoints.read",
  usersRead: "api.users.read",
  providerUsersRead: "api.provider.users.read",
  providerTenantsRead: "api.provider.tenants.read",
  jobsRead: "api.jobs.read",
  jobRead: "api.job.read",
  jobEventsOpened: "api.job.events.opened",
  verifyRead: "api.verify.read",
  archiveReportRead: "api.archive.report.read",
} as const;

export type V1AuditAction = (typeof V1_AUDIT_ACTIONS)[keyof typeof V1_AUDIT_ACTIONS];

export interface IntegrationEvent {
  action: V1AuditAction;
  target?: string | null;
  targetType?: string | null;
  details?: Record<string, unknown>;
}

/** An audit entry for something an API key did on a tenant. */
export function integrationEvent(
  tenantId: string,
  actor: KeyActor,
  event: IntegrationEvent,
): AuditEvent {
  return {
    tenantId,
    actor: actor.label,
    actorUserId: null,
    action: event.action,
    target: event.target ?? null,
    targetType: event.targetType ?? null,
    ip: actor.ip,
    details: { keyId: actor.keyId, ...(event.details ?? {}) },
  };
}

/** Filters worth recording with a read: the ones the caller actually set. */
export function presentFilters(filters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined));
}

/** Records reads of user or backup data by an API key in the tenant's audit log. */
export function readRecorder(deps: Pick<V1Deps, "db" | "audit">) {
  return (tenantId: string, actor: KeyActor, event: IntegrationEvent) =>
    deps.audit(deps.db, integrationEvent(tenantId, actor, event));
}
