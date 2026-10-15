/**
 * The retention hold on suspicion (docs/RANSOMWARE.md, "Retention hold"): which objects of a
 * tenant have a suspicious restore point that nobody resolved, so retention must keep every
 * restore point of them. One query, shared by every retention path of the worker (machines, file
 * shares, Proxmox VE guests, the chunk store's snapshots) and by the API that shows the hold.
 *
 * A restore point holds while it is judged suspicious, is not called a false alarm and its hold
 * was not released. A later clean restore point does not end the hold: ransomware that was cleaned
 * up still leaves its encrypted restore points pushing the good ones out.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { SuspicionObjectKind } from "./schema/suspicions.js";

type Executor = Pick<NodePgDatabase<Record<string, unknown>>, "execute">;

/** One object's open hold. */
export interface SuspicionHold {
  objectKind: SuspicionObjectKind;
  objectId: string;
  /** The oldest suspicious restore point that holds. */
  since: Date;
  /** When the first of them was judged (the hold's start). */
  heldAt: Date;
  /** How many suspicious restore points hold. */
  restorePoints: number;
  /** When the hold was last announced again (`backup.suspicious_hold`); null: never. */
  remindedAt: Date | null;
}

/** The condition of a `restore_point_suspicions` row that holds retention. */
export const SUSPICION_HOLDS_SQL = sql`verdict = 'suspicious' AND false_alarm_at IS NULL AND hold_released_at IS NULL`;

interface HoldRow extends Record<string, unknown> {
  object_kind: SuspicionObjectKind;
  object_id: string;
  since: Date | string;
  held_at: Date | string;
  restore_points: number | string;
  reminded_at: Date | string | null;
}

const date = (value: Date | string) => (value instanceof Date ? value : new Date(value));

/**
 * The tenant's open holds, by object id; only `kind` when given, only `objectIds` when given.
 * Runs in a tenant transaction (Row Level Security) or on the installation pool; the tenant is
 * named explicitly either way.
 */
export async function suspicionHolds(
  tx: Executor,
  scope: { tenantId: string; kind?: SuspicionObjectKind; objectIds?: readonly string[] },
): Promise<Map<string, SuspicionHold>> {
  if (scope.objectIds && scope.objectIds.length === 0) {
    return new Map();
  }
  const kind = scope.kind ? sql`AND object_kind = ${scope.kind}` : sql``;
  const ids = scope.objectIds
    ? sql`AND object_id IN (${sql.join(
        scope.objectIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql``;
  const result = await tx.execute<HoldRow>(sql`
    SELECT object_kind, object_id,
      min(restore_point_at) AS since,
      min(created_at) AS held_at,
      count(*)::int AS restore_points,
      max(hold_reminded_at) AS reminded_at
    FROM restore_point_suspicions
    WHERE tenant_id = ${scope.tenantId}::uuid AND ${SUSPICION_HOLDS_SQL} ${kind} ${ids}
    GROUP BY object_kind, object_id
  `);
  return new Map(
    result.rows.map((row) => [
      row.object_id,
      {
        objectKind: row.object_kind,
        objectId: row.object_id,
        since: date(row.since),
        heldAt: date(row.held_at),
        restorePoints: Number(row.restore_points),
        remindedAt: row.reminded_at === null ? null : date(row.reminded_at),
      },
    ]),
  );
}
