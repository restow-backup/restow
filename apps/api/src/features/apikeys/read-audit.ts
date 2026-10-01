import type { AuditEvent } from "../../lib/audit.js";
import { type V1AuditAction, V1_AUDIT_ACTIONS, integrationEvent } from "../../routes/v1/audit.js";
import type { ApiScope } from "./scopes.js";

/**
 * The read audit of API keys on the feature routes they share with the web UI
 * (jobs, webhooks, ...; middleware/apiKey.ts `requireTenantOrApiKey`).
 *
 * The integration API records every read of user or backup data in the
 * tenant's audit log (routes/v1/audit.ts). A key that reads the same data
 * through a feature route is recorded under the same action names, so the
 * log does not depend on which surface answered. The action follows from the
 * scope the route requires and the shape of the read: a list, one item (the
 * route names it as `:id`), or an event stream.
 */

export type ReadShape = "list" | "item" | "stream";

export interface ReadAuditRule {
  /** The action for each shape of read. */
  actions: Record<ReadShape, V1AuditAction>;
  /** The target type of a read of one item. */
  itemType: string;
}

function sameAction(action: V1AuditAction): Record<ReadShape, V1AuditAction> {
  return { list: action, item: action, stream: action };
}

/**
 * How key reads under each scope are recorded. `null` marks scopes whose
 * reads carry no user or backup data (status, webhook configuration), which
 * the integration API does not record either, and the write scopes, whose
 * changes are recorded by the feature services that make them. A new scope
 * must be decided here before it compiles.
 */
export const KEY_READ_AUDIT: Readonly<Record<ApiScope, ReadAuditRule | null>> = {
  "status:read": null,
  "jobs:read": {
    actions: {
      list: V1_AUDIT_ACTIONS.jobsRead,
      item: V1_AUDIT_ACTIONS.jobRead,
      stream: V1_AUDIT_ACTIONS.jobEventsOpened,
    },
    itemType: "job",
  },
  "items:read": { actions: sameAction(V1_AUDIT_ACTIONS.objectsRead), itemType: "protected_object" },
  "users:read": { actions: sameAction(V1_AUDIT_ACTIONS.usersRead), itemType: "user" },
  "archive:read": {
    actions: sameAction(V1_AUDIT_ACTIONS.archiveReportRead),
    itemType: "archive_item",
  },
  "restore:write": null,
  "verify:write": null,
  "users:write": null,
  "webhooks:manage": null,
};

/** A successful read an API key made on a feature route. */
export interface KeyRead {
  scope: ApiScope;
  tenantId: string;
  actor: { keyId: string; label: string; ip: string | null };
  method: string;
  /** The route pattern that answered, e.g. `/api/v1/jobs/objects/:id/snapshots`. */
  route: string;
  /** The `:id` the route names, when it reads one item. */
  itemId: string | undefined;
  /** The answer is an event stream (`text/event-stream`). */
  stream: boolean;
  /** Query parameters as the key sent them. */
  query: Record<string, string>;
}

export function readShape(read: Pick<KeyRead, "itemId" | "stream">): ReadShape {
  if (read.stream) {
    return "stream";
  }
  return read.itemId ? "item" : "list";
}

/** The audit entry for a key read, or null when reads under its scope are not recorded. */
export function keyReadEvent(read: KeyRead): AuditEvent | null {
  const rule = KEY_READ_AUDIT[read.scope];
  if (!rule) {
    return null;
  }
  const item = read.itemId || null;
  const filters = Object.keys(read.query).length > 0 ? { filters: read.query } : {};
  return integrationEvent(
    read.tenantId,
    { userId: null, ...read.actor },
    {
      action: rule.actions[readShape(read)],
      target: item ?? read.tenantId,
      targetType: item ? rule.itemType : "tenant",
      details: { route: `${read.method} ${read.route}`, ...filters },
    },
  );
}
