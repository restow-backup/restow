/**
 * The public hooks Microsoft Graph posts change notifications to (docs/MICROSOFT.md
 * "Change notifications", docs/ARCHIVE.md "Erfassungswege"), for the archive capture of
 * Microsoft 365 mailboxes:
 *
 *   POST /api/v1/hooks/graph/notifications   a message was created in a mailbox
 *   POST /api/v1/hooks/graph/lifecycle       reauthorizationRequired, subscriptionRemoved,
 *                                            missed
 *
 * Nobody signs in here. What protects them:
 *
 *   - a post only counts when its subscription is one of ours and its `clientState` hashes
 *     to the stored SHA-256 (constant-time); everything else is ignored, answered 202 like
 *     the rest so a caller learns nothing;
 *   - a notification never carries mail: the hook only records the message id as pending
 *     (`archive_capture_pending`, one row per mail however often announced) and makes the
 *     mailbox's capture stream due. The worker fetches the mail from Graph with its own
 *     credentials, so a forged id can at most make it look for a message that is not there;
 *   - bodies are limited to 1 MiB (middleware/body-limit.ts); one post is read for at most
 *     1000 notifications.
 *
 * Graph's validation request (`?validationToken=`) is answered with the token as
 * text/plain within its 10 seconds; a notification is answered 202 right after the few
 * indexed statements (Graph wants an answer within 3 seconds, else it retries and
 * eventually drops notifications). While the gate `archive.mailboxCapture` is closed
 * both answer 404, like an unregistered path.
 */
import {
  type ChangeNotification,
  type LifecycleNotification,
  parseChangeNotifications,
  parseLifecycleNotifications,
  verifyNotifications,
} from "@restow/core";
import { sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { db, providerDb } from "../../db.js";
import { featureEnabled } from "../../lib/features.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";

/** Mounted under /api/v1 by app.ts. */
export const graphHooksMountPath = "/hooks/graph";

/** Graph's validation tokens are short opaque strings; anything longer is not one. */
const MAX_VALIDATION_TOKEN = 4096;

export interface GraphHookDeps {
  /** The application pool (tenant transactions). */
  readonly db: DbExecutor;
  /** The installation pool: finding the subscription of a post spans tenants. */
  readonly providerDb: DbExecutor;
  /** Whether the gate is open; default the feature gates, cached for 30 s. */
  readonly enabled?: () => Promise<boolean>;
}

type KnownRow = {
  subscription_id: string;
  tenant_id: string;
  protected_object_id: string;
  client_state_hash: string;
};

function cachedGate(installation: DbExecutor): () => Promise<boolean> {
  let cached: { at: number; value: boolean } | null = null;
  return async () => {
    if (cached && Date.now() - cached.at < 30_000) {
      return cached.value;
    }
    const value = await featureEnabled("archive.mailboxCapture", installation);
    cached = { at: Date.now(), value };
    return value;
  };
}

async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Our subscriptions among `ids`, with the tenant and mailbox each belongs to. */
async function knownSubscriptions(
  providerDb: DbExecutor,
  ids: readonly string[],
): Promise<Map<string, { clientStateHash: string; tenantId: string; objectId: string }>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return new Map();
  }
  const result = await providerDb.execute<KnownRow>(sql`
    select subscription_id, tenant_id, protected_object_id, client_state_hash
      from graph_subscriptions
     where subscription_id = any(ARRAY[${sql.join(
       unique.map((id) => sql`${id}`),
       sql`, `,
     )}]::text[])
       and status in ('active', 'reauthorization_required')
  `);
  return new Map(
    result.rows.map((row) => [
      row.subscription_id,
      {
        clientStateHash: row.client_state_hash,
        tenantId: row.tenant_id,
        objectId: row.protected_object_id,
      },
    ]),
  );
}

function byTenant<T>(items: readonly T[], tenantOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const tenant = tenantOf(item);
    groups.set(tenant, [...(groups.get(tenant) ?? []), item]);
  }
  return groups;
}

function textArray(values: readonly string[]) {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

function uuidArray(values: readonly string[]) {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::uuid[]`;
}

/** The streams of the mailboxes are due now (one statement per tenant). */
async function markDue(tx: DbExecutor, tenantId: string, objectIds: readonly string[]) {
  await tx.execute(sql`
    update archive_capture_streams
       set next_due_at = now(), dirty_since = coalesce(dirty_since, now()), updated_at = now()
     where tenant_id = ${tenantId}::uuid and way = 'graph_sync'
       and protected_object_id = any(${uuidArray([...new Set(objectIds)])})
       and status not in ('disabled', 'paused')
  `);
}

/** Record accepted change notifications: pending rows, due streams, last notification. */
export async function recordNotifications(
  deps: Pick<GraphHookDeps, "db" | "providerDb">,
  body: unknown,
): Promise<{ accepted: number; ignored: number }> {
  const { notifications, invalid } = parseChangeNotifications(body);
  const known = await knownSubscriptions(
    deps.providerDb,
    notifications.map((n) => n.subscriptionId),
  );
  const { accepted, rejected } = verifyNotifications(notifications, known);
  const usable = accepted.filter(
    (n): n is ChangeNotification & { resourceId: string } =>
      n.resourceId !== null && n.resourceId.length <= 512 && n.changeType === "created",
  );
  const groups = byTenant(usable, (n) => known.get(n.subscriptionId)?.tenantId ?? "");
  for (const [tenantId, items] of groups) {
    const objects = items.map((n) => known.get(n.subscriptionId)?.objectId ?? "");
    await withTenantTx(deps.db, tenantId, async (tx) => {
      await tx.execute(sql`
        insert into archive_capture_pending (tenant_id, protected_object_id, way, external_ref)
        select ${tenantId}::uuid, p.object_id, 'graph_sync', p.ref
          from unnest(${uuidArray(objects)}, ${textArray(items.map((n) => n.resourceId))})
               as p(object_id, ref)
        on conflict (protected_object_id, way, external_ref) do nothing
      `);
      await markDue(tx, tenantId, objects);
      await tx.execute(sql`
        update graph_subscriptions set last_notification_at = now()
         where tenant_id = ${tenantId}::uuid
           and subscription_id = any(${textArray([...new Set(items.map((n) => n.subscriptionId))])})
      `);
    });
  }
  return { accepted: usable.length, ignored: invalid + rejected + accepted.length - usable.length };
}

const LIFECYCLE_STATUS: Record<LifecycleNotification["lifecycleEvent"], string | null> = {
  reauthorizationRequired: "reauthorization_required",
  subscriptionRemoved: "removed",
  // The subscription stays; the worker runs a catch-up for what was missed.
  missed: null,
};

/** Record accepted lifecycle notifications on the subscriptions; the streams are due now. */
export async function recordLifecycle(
  deps: Pick<GraphHookDeps, "db" | "providerDb">,
  body: unknown,
): Promise<{ accepted: number; ignored: number }> {
  const { notifications, invalid } = parseLifecycleNotifications(body);
  const known = await knownSubscriptions(
    deps.providerDb,
    notifications.map((n) => n.subscriptionId),
  );
  const { accepted, rejected } = verifyNotifications(notifications, known);
  const groups = byTenant(accepted, (n) => known.get(n.subscriptionId)?.tenantId ?? "");
  for (const [tenantId, items] of groups) {
    await withTenantTx(deps.db, tenantId, async (tx) => {
      for (const n of items) {
        const status = LIFECYCLE_STATUS[n.lifecycleEvent];
        await tx.execute(sql`
          update graph_subscriptions
             set last_lifecycle_event = ${n.lifecycleEvent},
                 status = ${status === null ? sql`status` : sql`${status}::graph_subscription_status`},
                 updated_at = now()
           where tenant_id = ${tenantId}::uuid and subscription_id = ${n.subscriptionId}
        `);
      }
      await markDue(
        tx,
        tenantId,
        items.map((n) => known.get(n.subscriptionId)?.objectId ?? ""),
      );
    });
  }
  return { accepted: accepted.length, ignored: invalid + rejected };
}

export function buildGraphHookRoutes(deps: GraphHookDeps): Hono {
  const routes = new Hono();
  const enabled = deps.enabled ?? cachedGate(deps.providerDb);

  const hook =
    (record: (deps: GraphHookDeps, body: unknown) => Promise<unknown>) => async (c: Context) => {
      if (!(await enabled())) {
        throw new ProblemError(404, "Not found");
      }
      // Graph's handshake when a subscription is created: echo the token as plain text.
      const token = c.req.query("validationToken");
      if (token !== undefined) {
        if (token.length === 0 || token.length > MAX_VALIDATION_TOKEN) {
          throw new ProblemError(400, "Invalid validation token");
        }
        return c.text(token, 200, { "Content-Type": "text/plain; charset=utf-8" });
      }
      await record(deps, await readJson(c));
      return c.body(null, 202);
    };

  routes.post("/notifications", hook(recordNotifications));
  routes.post("/lifecycle", hook(recordLifecycle));
  return routes;
}

/** The hooks on the API's pools (app.ts). */
export const graphHookRoutes = buildGraphHookRoutes({ db, providerDb });
