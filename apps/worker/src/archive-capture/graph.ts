/**
 * The Graph capture way (`graph_sync`, docs/ARCHIVE.md "Erfassungswege", docs/MICROSOFT.md
 * "Change notifications"): the archive of a Microsoft 365 mailbox, fed by change
 * notifications and a regular delta catch-up. Plugs into the capture service (./ways.ts);
 * the Graph work itself is @restow/core `archive/graph-capture.ts`.
 *
 * Per pass of a mailbox's stream:
 *
 *   ensure    The mailbox has one active subscription (`graph_subscriptions`): created
 *             first (a stream becomes live, and its backfill queued, once that was tried),
 *             renewed when less than a day of its lifetime is left, reauthorized after
 *             `reauthorizationRequired`, created again after `subscriptionRemoved`, when
 *             it expired, and when the Entra app changed (the app's fingerprint is kept
 *             with the subscription; a subscription belongs to the app that made it).
 *             Without a public HTTPS URL there is no subscription and the stream polls
 *             (`graph.notification_url_unavailable`); a subscription Graph refuses
 *             (`graph.subscription_failed`) is tried again after an hour, polling meanwhile.
 *             Creations and renewals of all passes of one Microsoft tenant are gathered
 *             into `$batch` requests of at most 20, at most one per second and tenant.
 *   drain     what the notifications announced (`archive_capture_pending`, written by
 *             the API's hook). A mail Graph no longer finds makes the catch-up run now.
 *   catchUp   delta over every folder and `recoverableitemsdeletions`, every
 *             `ARCHIVE_GRAPH_CATCHUP_MINUTES` (default 360) with notifications, every
 *             `ARCHIVE_GRAPH_POLL_MINUTES` (default 15) without; at once after a resync,
 *             a `missed` lifecycle event, a recreated subscription or a vanished mail.
 *
 * The backfill takes over the mailbox's existing mail in pages, its position in the
 * `archive` job's cursor.
 *
 * The stream state keys of this way: `folders` (delta position per folder), `subscription`
 * (`{ id, appFingerprint, expiresAt }`), `subscriptionRetryAt`, `forceCatchUp`,
 * `lastCatchUpAt`, `nextCatchUpAt`.
 *
 * A background component checks the installation's app registration every five minutes;
 * when it changed, every Graph stream is made due, so subscriptions move to the new app
 * at once rather than at their next renewal.
 */
import { createHash } from "node:crypto";
import {
  type AppCredentials,
  archive,
  buildCause,
  createSubscriptions,
  deleteSubscription,
  FetchGraphClient,
  type GraphClient,
  GraphError,
  hashClientState,
  isGraphError,
  JobAbortedError,
  mailSubscriptionResource,
  needsRenewal,
  newClientState,
  reauthorizeSubscription,
  renewalDueAt,
  renewSubscriptions,
  type SubscriptionRenewal,
  type SubscriptionResult,
  type SubscriptionSpec,
  subscriptionExpiry,
  toTokenCallback,
} from "@restow/core";
import {
  type Database,
  protectedObjects,
  type Source,
  safeErrorMessage,
  settings,
  sources,
} from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { type EntraAppLookup, processEntraApp } from "../entra-app.js";
import { appCredentialsForSource, TokenProviderCache } from "../handlers/backup.js";
import {
  InvalidPayloadError,
  PgSecretReader,
  tenantRunner,
  type WorkerJobContext,
  withTenantTx,
} from "../handlers/framework.js";
import type {
  ArchiveStreamState,
  BackfillContext,
  BackfillResult,
  CaptureContext,
  CaptureWay,
  CaptureWayServices,
  CatchUpResult,
  DrainResult,
  EnsureResult,
} from "./ways.js";

type Env = Record<string, string | undefined>;

/** Path of the API's notification hook (apps/api features/archive-capture/hooks.ts). */
export const GRAPH_NOTIFICATION_PATH = "/api/v1/hooks/graph/notifications";
/** Path of the API's lifecycle hook. */
export const GRAPH_LIFECYCLE_PATH = "/api/v1/hooks/graph/lifecycle";

const MINUTE = 60_000;
/** A subscription Graph refused is tried again after this long. */
const SUBSCRIPTION_RETRY_MS = 60 * MINUTE;
/** A renewal that failed (not 404) is tried again after this long. */
const RENEWAL_RETRY_MS = 15 * MINUTE;
/** The backfill job stops after this long and queues its continuation. */
const BACKFILL_BUDGET_MS = 2 * 60 * MINUTE;

function positiveInt(env: Env, name: string, fallback: number): number {
  const value = Number.parseInt(env[name]?.trim() ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface GraphWaySettings {
  /** Catch-up interval while notifications arrive. */
  readonly catchUpMinutes: number;
  /** Catch-up interval in poll-only mode (it is the capture then). */
  readonly pollMinutes: number;
}

export function graphWaySettingsFromEnv(env: Env = process.env): GraphWaySettings {
  return {
    catchUpMinutes: positiveInt(env, "ARCHIVE_GRAPH_CATCHUP_MINUTES", 360),
    pollMinutes: positiveInt(env, "ARCHIVE_GRAPH_POLL_MINUTES", 15),
  };
}

// ---------------------------------------------------------------------------
// Where notifications go

export type NotificationTarget =
  | { readonly ok: true; readonly notificationUrl: string; readonly lifecycleUrl: string }
  | { readonly ok: false; readonly reason: "graph.notification_url_unavailable" };

const LOCAL_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan)$/i;
const PRIVATE_IPV4 =
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/**
 * The hook URLs for a public URL, or why there are none: Graph delivers only to HTTPS on a
 * name or address it can reach (not localhost, not a private network, standard port).
 */
export function notificationTarget(publicUrl: string | null | undefined): NotificationTarget {
  const unavailable = { ok: false, reason: "graph.notification_url_unavailable" } as const;
  if (!publicUrl?.trim()) {
    return unavailable;
  }
  let url: URL;
  try {
    url = new URL(publicUrl.trim());
  } catch {
    return unavailable;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    LOCAL_HOST.test(host) ||
    PRIVATE_IPV4.test(host) ||
    host === "::1" ||
    /^f[cd]/i.test(host)
  ) {
    return unavailable;
  }
  const origin = url.origin;
  return {
    ok: true,
    notificationUrl: `${origin}${GRAPH_NOTIFICATION_PATH}`,
    lifecycleUrl: `${origin}${GRAPH_LIFECYCLE_PATH}`,
  };
}

// ---------------------------------------------------------------------------
// Batching subscription requests per Microsoft tenant

type SubscriptionOp =
  | { readonly kind: "create"; readonly spec: SubscriptionSpec }
  | { readonly kind: "renew"; readonly renewal: SubscriptionRenewal };

interface QueuedOp {
  readonly op: SubscriptionOp;
  readonly client: GraphClient;
  readonly signal: AbortSignal;
  readonly resolve: (result: SubscriptionResult) => void;
  readonly reject: (error: unknown) => void;
}

interface TenantQueue {
  readonly ops: QueuedOp[];
  timer: NodeJS.Timeout | null;
  lastFlushAt: number;
  flushing: boolean;
}

/**
 * Gathers the subscription creations and renewals of concurrent passes per Microsoft
 * tenant into `$batch` requests: at most {@link SubscriptionBatcher.maxBatch} (20, Graph's
 * limit per batch) per request and at most one request per `minIntervalMs` (1 s) and
 * tenant, so a tenant's thousands of mailboxes going live do not hit Graph at once.
 * Results go back to each caller; a caller whose pass was aborted is answered with
 * `JobAbortedError` and its request is not sent.
 */
export class SubscriptionBatcher {
  readonly maxBatch = 20;
  private readonly queues = new Map<string, TenantQueue>();
  private readonly windowMs: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;

  constructor(options: { windowMs?: number; minIntervalMs?: number; now?: () => number } = {}) {
    this.windowMs = options.windowMs ?? 200;
    this.minIntervalMs = options.minIntervalMs ?? 1000;
    this.now = options.now ?? Date.now;
  }

  submit(
    key: string,
    client: GraphClient,
    signal: AbortSignal,
    op: SubscriptionOp,
  ): Promise<SubscriptionResult> {
    if (signal.aborted) {
      return Promise.reject(new JobAbortedError());
    }
    return new Promise((resolve, reject) => {
      let queue = this.queues.get(key);
      if (!queue) {
        queue = { ops: [], timer: null, lastFlushAt: Number.NEGATIVE_INFINITY, flushing: false };
        this.queues.set(key, queue);
      }
      queue.ops.push({ op, client, signal, resolve, reject });
      this.schedule(key, queue);
    });
  }

  private schedule(key: string, queue: TenantQueue): void {
    if (queue.timer || queue.flushing || queue.ops.length === 0) {
      return;
    }
    const sinceLast = this.now() - queue.lastFlushAt;
    const wait = Math.max(
      queue.ops.length >= this.maxBatch ? 0 : this.windowMs,
      this.minIntervalMs - sinceLast,
    );
    queue.timer = setTimeout(
      () => {
        queue.timer = null;
        void this.flush(key, queue);
      },
      Math.max(0, wait),
    );
    queue.timer.unref?.();
  }

  private async flush(key: string, queue: TenantQueue): Promise<void> {
    queue.flushing = true;
    queue.lastFlushAt = this.now();
    const taken = queue.ops.splice(0, this.maxBatch);
    const live = taken.filter((entry) => {
      if (entry.signal.aborted) {
        entry.reject(new JobAbortedError());
        return false;
      }
      return true;
    });
    try {
      const sender = live[0];
      if (sender) {
        const creates = live.filter((e) => e.op.kind === "create");
        const renews = live.filter((e) => e.op.kind === "renew");
        await this.send(sender.client, creates, renews);
      }
    } finally {
      queue.flushing = false;
      if (queue.ops.length === 0 && !queue.timer) {
        this.queues.delete(key);
      } else {
        this.schedule(key, queue);
      }
    }
  }

  private async send(client: GraphClient, creates: QueuedOp[], renews: QueuedOp[]) {
    const answer = (entries: QueuedOp[], results: SubscriptionResult[]) => {
      entries.forEach((entry, index) => {
        const result = results[index];
        if (result) {
          entry.resolve(result);
        } else {
          entry.reject(new Error("Graph sent no answer for a subscription request"));
        }
      });
    };
    try {
      if (creates.length > 0) {
        answer(
          creates,
          await createSubscriptions(
            client,
            creates.map((e) => (e.op as { spec: SubscriptionSpec }).spec),
          ),
        );
      }
      if (renews.length > 0) {
        answer(
          renews,
          await renewSubscriptions(
            client,
            renews.map((e) => (e.op as { renewal: SubscriptionRenewal }).renewal),
          ),
        );
      }
    } catch (error) {
      // The batch itself failed (the sending pass was aborted, Graph unreachable): every
      // caller gets the error; one whose own pass goes on retries on its next pass.
      for (const entry of [...creates, ...renews]) {
        entry.reject(error);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Access to a mailbox

/** A Graph client for the stream's mailbox, and who the subscriptions belong to. */
export interface GraphMailboxAccess {
  readonly client: GraphClient;
  /** The mailbox's user id (the object's external id). */
  readonly userId: string;
  /** The Microsoft tenant: the key the subscription requests are paced by. */
  readonly entraTenantId: string;
  /** The Entra app (client id and authority), hashed: subscriptions belong to it. */
  readonly appFingerprint: string;
}

/** The fingerprint subscriptions are kept with: the app, not its (rotating) secret. */
export function subscriptionAppFingerprint(
  app: Pick<AppCredentials, "clientId" | "authorityHost">,
) {
  return createHash("sha256")
    .update(JSON.stringify([app.clientId, app.authorityHost ?? null]))
    .digest("hex")
    .slice(0, 32);
}

export interface GraphWayDeps {
  /** The Graph client of a pass (its signal ends with the pass). */
  readonly access: (ctx: CaptureContext) => Promise<GraphMailboxAccess>;
  /**
   * Where Graph sends notifications, from the public URL at the time of the pass; gets the
   * installation pool once the service started the way (the URL Settings hold lives there).
   */
  readonly notificationTarget: (providerDb: Database | null) => Promise<NotificationTarget>;
  readonly settings?: GraphWaySettings;
  readonly batcher?: SubscriptionBatcher;
  /** The installation app's fingerprint now (the background component compares it). */
  readonly installationAppFingerprint?: () => Promise<string | null>;
}

/** The production access: the stream's source and object, the app, a token per tenant. */
export function pgGraphAccess(
  options: { entraApp?: EntraAppLookup; tokens?: TokenProviderCache } = {},
): GraphWayDeps["access"] {
  const entraApp = options.entraApp ?? processEntraApp;
  const tokens = options.tokens ?? new TokenProviderCache();
  return async (ctx) => {
    const { source, object } = await withTenantTx(ctx.db, ctx.tenantId, async (tx) => {
      const [s] = await tx
        .select()
        .from(sources)
        .where(and(eq(sources.tenantId, ctx.tenantId), eq(sources.id, ctx.stream.sourceId)))
        .limit(1);
      const [o] = await tx
        .select({ externalId: protectedObjects.externalId })
        .from(protectedObjects)
        .where(
          and(
            eq(protectedObjects.tenantId, ctx.tenantId),
            eq(protectedObjects.id, ctx.stream.protectedObjectId),
          ),
        )
        .limit(1);
      return { source: s as Source | undefined, object: o };
    });
    if (!source || !object) {
      throw new InvalidPayloadError(
        "the mailbox or its source no longer exists",
        buildCause("config.object_orphaned"),
      );
    }
    if (!source.entraTenantId) {
      throw new InvalidPayloadError(
        `source "${source.name}" has no Entra tenant id; admin consent is outstanding`,
        buildCause("config.source_not_connected"),
      );
    }
    const secrets = new PgSecretReader(tenantRunner(ctx.db, ctx.tenantId), ctx.tenantId, ctx.keys);
    // Only the secret reader of a job context is used to resolve the app.
    const jobLike = { secrets } as unknown as WorkerJobContext;
    const app = await appCredentialsForSource({ ctx: jobLike, source }, { entraApp });
    const provider = tokens.get(source.entraTenantId, app);
    const client = new FetchGraphClient({
      accessTokenProvider: toTokenCallback(provider),
      signal: ctx.signal,
      onThrottle: (info) =>
        ctx.logger.debug("archive capture waits for Graph", {
          status: info.status,
          waitMs: info.waitMs,
        }),
    });
    return {
      client,
      userId: object.externalId,
      entraTenantId: source.entraTenantId,
      appFingerprint: subscriptionAppFingerprint(app),
    };
  };
}

/** The public URL: Settings (Installation › Server), else RESTOW_PUBLIC_URL. */
export function pgNotificationTarget(
  env: Env = process.env,
  cacheMs = 60_000,
): GraphWayDeps["notificationTarget"] {
  let cached: { at: number; value: NotificationTarget } | null = null;
  return async (db) => {
    if (cached && Date.now() - cached.at < cacheMs) {
      return cached.value;
    }
    let stored: string | null = null;
    if (db) {
      const [row] = await db.select({ publicUrl: settings.publicUrl }).from(settings).limit(1);
      stored = row?.publicUrl ?? null;
    }
    const value = notificationTarget(stored?.trim() ? stored : env.RESTOW_PUBLIC_URL);
    cached = { at: Date.now(), value };
    return value;
  };
}

// ---------------------------------------------------------------------------
// State

interface SubscriptionState {
  readonly id: string;
  readonly appFingerprint: string;
  readonly expiresAt: string;
}

interface GraphState extends ArchiveStreamState {
  readonly folders?: archive.GraphCatchUpState["folders"];
  readonly subscription?: SubscriptionState | null;
  readonly subscriptionRetryAt?: string | null;
  readonly forceCatchUp?: boolean;
  readonly lastCatchUpAt?: string;
  readonly nextCatchUpAt?: string;
}

function stateOf(ctx: CaptureContext): GraphState {
  return ctx.stream.state as GraphState;
}

function timeOf(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

interface SubscriptionRow {
  id: string;
  subscription_id: string;
  status: "active" | "reauthorization_required" | "removed" | "failed";
  expires_at: Date | string;
  last_lifecycle_event: string | null;
  updated_at: Date | string;
}

async function currentSubscription(ctx: CaptureContext): Promise<SubscriptionRow | null> {
  return withTenantTx(ctx.db, ctx.tenantId, async (tx) => {
    const result = await tx.execute(sql`
      select id, subscription_id, status::text as status, expires_at, last_lifecycle_event, updated_at
        from graph_subscriptions
       where tenant_id = ${ctx.tenantId}::uuid and protected_object_id = ${ctx.stream.protectedObjectId}::uuid
       order by (status = 'active') desc, (status = 'reauthorization_required') desc, updated_at desc
       limit 1
    `);
    return (result.rows[0] as unknown as SubscriptionRow | undefined) ?? null;
  });
}

/** Every subscription row of the mailbox not yet removed is marked `removed` (event: why). */
async function markRemoved(ctx: CaptureContext, event: string): Promise<void> {
  await withTenantTx(ctx.db, ctx.tenantId, (tx) =>
    tx.execute(sql`
      update graph_subscriptions
         set status = 'removed', last_lifecycle_event = ${event}, updated_at = now()
       where tenant_id = ${ctx.tenantId}::uuid and protected_object_id = ${ctx.stream.protectedObjectId}::uuid
         and status <> 'removed'
    `),
  );
}

// ---------------------------------------------------------------------------
// The way

/** The Graph capture way with its collaborators (tests pass their own). */
export function createGraphCaptureWay(deps: GraphWayDeps): CaptureWay {
  const settings = deps.settings ?? graphWaySettingsFromEnv();
  const batcher = deps.batcher ?? new SubscriptionBatcher();

  let providerDb: Database | null = null;
  const keyOf = (access: GraphMailboxAccess) => `${access.entraTenantId}:${access.appFingerprint}`;

  /** Create a subscription for the mailbox; the old rows are marked removed. */
  async function create(
    ctx: CaptureContext,
    access: GraphMailboxAccess,
    target: Extract<NotificationTarget, { ok: true }>,
    reason: string,
  ): Promise<{ state: SubscriptionState } | { error: GraphError }> {
    const clientState = newClientState();
    const spec: SubscriptionSpec = {
      resource: mailSubscriptionResource(access.userId),
      notificationUrl: target.notificationUrl,
      lifecycleNotificationUrl: target.lifecycleUrl,
      clientState,
      expirationDateTime: subscriptionExpiry(ctx.now()),
    };
    const result = await batcher.submit(keyOf(access), access.client, ctx.signal, {
      kind: "create",
      spec,
    });
    if (!result.ok) {
      return { error: result.error };
    }
    const subscription = result.subscription;
    await withTenantTx(ctx.db, ctx.tenantId, async (tx) => {
      await tx.execute(sql`
        update graph_subscriptions
           set status = 'removed', last_lifecycle_event = ${reason}, updated_at = now()
         where tenant_id = ${ctx.tenantId}::uuid and protected_object_id = ${ctx.stream.protectedObjectId}::uuid
           and status <> 'removed'
      `);
      await tx.execute(sql`
        insert into graph_subscriptions
          (tenant_id, source_id, protected_object_id, subscription_id, resource, client_state_hash, expires_at, status)
        values (${ctx.tenantId}::uuid, ${ctx.stream.sourceId}::uuid, ${ctx.stream.protectedObjectId}::uuid,
                ${subscription.id.toLowerCase()}, ${subscription.resource || spec.resource},
                ${hashClientState(clientState)}, ${subscription.expirationDateTime.toISOString()}::timestamptz,
                'active')
      `);
    });
    ctx.logger.info("graph subscription created", { reason });
    return {
      state: {
        id: subscription.id.toLowerCase(),
        appFingerprint: access.appFingerprint,
        expiresAt: subscription.expirationDateTime.toISOString(),
      },
    };
  }

  /** Delete a subscription at Graph, best effort (one of another app may be refused). */
  async function deleteAtGraph(ctx: CaptureContext, client: GraphClient, id: string) {
    try {
      await deleteSubscription(client, id);
    } catch (error) {
      if (ctx.signal.aborted) {
        throw error;
      }
      ctx.logger.info("graph subscription could not be deleted", {
        errorMessage: safeErrorMessage(error),
      });
    }
  }

  const way: CaptureWay = {
    way: "graph_sync",

    async ensure(ctx): Promise<EnsureResult> {
      const now = ctx.now();
      let state: GraphState = { ...stateOf(ctx) };
      const access = await deps.access(ctx);
      if (ctx.stream.activatedAt === null) {
        // Before going live: the mailbox is reachable at all (a classified failure if not).
        const probe = await access.client.request({
          method: "GET",
          url: `/users/${encodeURIComponent(access.userId)}/mailFolders/inbox?$select=id`,
        });
        if (probe.status < 200 || probe.status >= 300) {
          throw new GraphError({
            status: probe.status,
            method: "GET",
            url: "/users/{id}/mailFolders/inbox",
            headers: probe.headers,
            payload: probe.body,
          });
        }
      }
      const target = await deps.notificationTarget(providerDb);
      const row = await currentSubscription(ctx);
      const known = state.subscription ?? null;

      if (!target.ok) {
        if (row && row.status !== "removed") {
          await deleteAtGraph(ctx, access.client, row.subscription_id);
          await markRemoved(ctx, "poll_only");
        }
        state = { ...state, subscription: null };
        return { state, activated: true, mode: "poll", pollReason: target.reason };
      }

      const poll = (reason: "graph.subscription_failed", retryAt: number): EnsureResult => ({
        state: { ...state, subscriptionRetryAt: new Date(retryAt).toISOString() },
        activated: true,
        mode: "poll",
        pollReason: reason,
        nextDueAt: new Date(retryAt),
      });

      const recreate = async (reason: string): Promise<EnsureResult> => {
        const retryAt = timeOf(state.subscriptionRetryAt);
        if (retryAt !== null && retryAt > now.getTime()) {
          return poll("graph.subscription_failed", retryAt);
        }
        const created = await create(ctx, access, target, reason);
        if ("error" in created) {
          if (created.error.status === 401) {
            throw created.error;
          }
          ctx.logger.warn("graph subscription refused; the mailbox is polled meanwhile", {
            status: created.error.status,
            code: created.error.code,
            errorMessage: safeErrorMessage(created.error),
          });
          if (row && row.status !== "removed") {
            await markRemoved(ctx, reason);
          }
          return poll("graph.subscription_failed", now.getTime() + SUBSCRIPTION_RETRY_MS);
        }
        state = {
          ...state,
          subscription: created.state,
          subscriptionRetryAt: null,
          // Notifications may have been lost meanwhile.
          forceCatchUp: reason !== "missing" || ctx.stream.activatedAt !== null,
        };
        return {
          state,
          activated: true,
          mode: "notifications",
          nextDueAt: renewalDueAt(new Date(created.state.expiresAt)),
        };
      };

      if (!row || row.status === "removed" || row.status === "failed") {
        return recreate(row ? `after_${row.last_lifecycle_event ?? row.status}` : "missing");
      }
      const expiresAt = new Date(row.expires_at);
      if (
        known &&
        known.id === row.subscription_id &&
        known.appFingerprint !== access.appFingerprint
      ) {
        // The Entra app changed: the old app's subscription cannot be managed any more.
        await deleteAtGraph(ctx, access.client, row.subscription_id);
        return recreate("app_changed");
      }
      if (expiresAt.getTime() <= now.getTime()) {
        return recreate("expired");
      }
      if (row.status === "reauthorization_required") {
        try {
          await reauthorizeSubscription(access.client, row.subscription_id);
        } catch (error) {
          if (ctx.signal.aborted || !isGraphError(error) || error.status === 401) {
            throw error;
          }
          return recreate("reauthorization_failed");
        }
        await withTenantTx(ctx.db, ctx.tenantId, (tx) =>
          tx.execute(sql`
            update graph_subscriptions set status = 'active', updated_at = now()
             where id = ${row.id}::uuid and status = 'reauthorization_required'
          `),
        );
      }
      if (row.last_lifecycle_event === "missed") {
        state = { ...state, forceCatchUp: true };
      }
      let expiry = expiresAt;
      if (needsRenewal(expiresAt, now)) {
        const result = await batcher.submit(keyOf(access), access.client, ctx.signal, {
          kind: "renew",
          renewal: { id: row.subscription_id, expirationDateTime: subscriptionExpiry(now) },
        });
        if (!result.ok) {
          if (result.error.status === 404) {
            await markRemoved(ctx, "renewal_not_found");
            return recreate("renewal_not_found");
          }
          ctx.logger.warn("graph subscription renewal failed; retried", {
            status: result.error.status,
            errorMessage: safeErrorMessage(result.error),
          });
          state = {
            ...state,
            subscription: {
              id: row.subscription_id,
              appFingerprint: known?.appFingerprint ?? access.appFingerprint,
              expiresAt: expiresAt.toISOString(),
            },
          };
          return {
            state,
            activated: true,
            mode: "notifications",
            nextDueAt: new Date(Math.min(expiresAt.getTime(), now.getTime() + RENEWAL_RETRY_MS)),
          };
        }
        expiry = result.subscription.expirationDateTime;
        await withTenantTx(ctx.db, ctx.tenantId, (tx) =>
          tx.execute(sql`
            update graph_subscriptions
               set expires_at = ${expiry.toISOString()}::timestamptz, status = 'active', updated_at = now()
             where id = ${row.id}::uuid
          `),
        );
      }
      state = {
        ...state,
        subscription: {
          id: row.subscription_id,
          appFingerprint:
            known?.id === row.subscription_id ? known.appFingerprint : access.appFingerprint,
          expiresAt: expiry.toISOString(),
        },
        subscriptionRetryAt: null,
      };
      return { state, activated: true, mode: "notifications", nextDueAt: renewalDueAt(expiry) };
    },

    async drain(ctx, refs): Promise<DrainResult> {
      const access = await deps.access(ctx);
      const result = await archive.drainGraphPending({
        client: access.client,
        userId: access.userId,
        refs,
        sink: ctx,
        signal: ctx.signal,
      });
      if (result.failure && result.handled.length === 0) {
        throw result.failure;
      }
      if (result.failure) {
        ctx.logger.warn("some announced mail could not be fetched; it stays pending", {
          status: result.failure.status,
        });
      }
      if (result.oversized.length > 0) {
        ctx.logger.warn("mail too large for a MIME export is not archived", {
          messages: result.oversized.length,
        });
      }
      const state = stateOf(ctx);
      return {
        state: result.missing > 0 || result.failure ? { ...state, forceCatchUp: true } : undefined,
        handled: result.handled,
        captured: result.captured,
      };
    },

    async catchUp(ctx): Promise<CatchUpResult> {
      const now = ctx.now();
      const state = stateOf(ctx);
      const poll = state._mode === "poll";
      const interval = (poll ? settings.pollMinutes : settings.catchUpMinutes) * MINUTE;
      const nextAt = timeOf(state.nextCatchUpAt);
      const due =
        ctx.reason === "resync" ||
        state.forceCatchUp === true ||
        nextAt === null ||
        nextAt <= now.getTime() ||
        // The mode changed to poll-only: the long interval no longer applies.
        nextAt > now.getTime() + interval;
      if (!due) {
        return { captured: 0, nextDueAt: new Date(nextAt) };
      }
      const access = await deps.access(ctx);
      const startedAt = now;
      const result = await archive.catchUpGraphMailbox({
        client: access.client,
        userId: access.userId,
        state: { folders: state.folders ?? {} },
        sink: ctx,
        activatedAt: ctx.stream.activatedAt,
        backfillCompleted: ctx.stream.backfillCompletedAt !== null,
        fullResync: ctx.reason === "resync",
        signal: ctx.signal,
        checkpoint: (next) => ctx.checkpoint({ ...state, folders: next.folders }),
      });
      if (result.oversized.length > 0) {
        ctx.logger.warn("mail too large for a MIME export is not archived", {
          messages: result.oversized.length,
        });
      }
      // A `missed` lifecycle event this catch-up answered is done.
      await withTenantTx(ctx.db, ctx.tenantId, (tx) =>
        tx.execute(sql`
          update graph_subscriptions set last_lifecycle_event = 'missed_handled', updated_at = now()
           where tenant_id = ${ctx.tenantId}::uuid and protected_object_id = ${ctx.stream.protectedObjectId}::uuid
             and last_lifecycle_event = 'missed' and updated_at <= ${startedAt.toISOString()}::timestamptz
        `),
      );
      const next = new Date(ctx.now().getTime() + interval);
      const { forceCatchUp: _done, ...rest } = state;
      return {
        state: {
          ...rest,
          folders: result.state.folders ?? {},
          lastCatchUpAt: ctx.now().toISOString(),
          nextCatchUpAt: next.toISOString(),
        },
        captured: result.captured,
        nextDueAt: next,
      };
    },

    async release(ctx): Promise<void> {
      const row = await currentSubscription(ctx);
      if (!row || row.status === "removed") {
        return;
      }
      try {
        const access = await deps.access(ctx);
        await deleteAtGraph(ctx, access.client, row.subscription_id);
      } catch (error) {
        if (ctx.signal.aborted) {
          throw error;
        }
        ctx.logger.info("graph subscription left to expire", {
          errorMessage: safeErrorMessage(error),
        });
      }
      await markRemoved(ctx, "released");
    },

    async backfill(ctx: BackfillContext): Promise<BackfillResult> {
      const access = await deps.access(ctx);
      const stored = await ctx.job.cursor.load();
      const cursor = (stored?.graphBackfill as archive.GraphBackfillCursor | undefined) ?? null;
      ctx.job.progress.phase("archive-backfill");
      const result = await archive.backfillGraphMailbox({
        client: access.client,
        userId: access.userId,
        sink: ctx,
        cursor,
        saveCursor: (next) => ctx.job.cursor.save({ ...(stored ?? {}), graphBackfill: next }),
        signal: ctx.signal,
        budgetMs: BACKFILL_BUDGET_MS,
        onPage: ({ messages }) => ctx.job.progress.advance(messages),
      });
      if (result.oversized.length > 0) {
        ctx.logger.warn("mail too large for a MIME export is not archived", {
          messages: result.oversized.length,
        });
      }
      return {
        captured: result.cursor.captured,
        skipped: result.cursor.skipped,
        completed: result.completed,
      };
    },

    start(services: CaptureWayServices): void {
      providerDb = services.providerDb;
      const fingerprint = deps.installationAppFingerprint;
      if (!fingerprint) {
        return;
      }
      let last: string | null | undefined;
      const check = async () => {
        try {
          const current = await fingerprint();
          if (last !== undefined && current !== last) {
            // Subscriptions belong to the app that made them: move them over now.
            const result = await services.providerDb.execute(sql`
              update archive_capture_streams
                 set next_due_at = now(), updated_at = now()
               where way = 'graph_sync' and status not in ('paused', 'disabled')
            `);
            services.logger.info("the Microsoft 365 app changed; graph streams are due", {
              streams: result.rowCount ?? 0,
            });
          }
          last = current;
        } catch (error) {
          services.logger.debug("app registration check failed", {
            errorMessage: safeErrorMessage(error),
          });
        }
      };
      void check();
      const timer = setInterval(() => void check(), 5 * MINUTE);
      timer.unref?.();
      services.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
    },
  };
  return way;
}

/** The installation's app registration fingerprint (sources with an own app are not affected). */
export function processAppFingerprint(entraApp: EntraAppLookup = processEntraApp) {
  return async (): Promise<string | null> => {
    const resolution = await entraApp.resolve();
    return resolution.status === "ready"
      ? subscriptionAppFingerprint(resolution.app.credentials)
      : null;
  };
}

/** The way this build registers (./registry.ts). */
export const graphCaptureWay: CaptureWay = createGraphCaptureWay({
  access: pgGraphAccess(),
  notificationTarget: pgNotificationTarget(),
  installationAppFingerprint: processAppFingerprint(),
});
