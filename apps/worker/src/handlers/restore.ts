/**
 * The `restore` queue handler.
 *
 * The API records a restore request as a `restore_jobs` row (snapshot,
 * selection, target, mode, actor) plus a `jobs` lifecycle row and enqueues
 * `{ restoreJobId, protectedObjectId }`. This handler turns the row into a
 * core `RestoreRequest` and hands it to the core engine set
 * (packages/core/src/restore, `createRestoreEngines`), which routes downloads
 * to the ZIP engine and everything else to the engine of the object's kind:
 * Exchange mailboxes, OneDrive, IMAP accounts.
 *
 * What the engines need from the outside world is supplied here, exactly the
 * way the backup handler supplies it (./backup.ts), so both directions resolve
 * sources and credentials identically: a Graph client per source (shared
 * token cache, per-source secret or the app registration in use) and a
 * connected IMAP session for the target account (credentials from the
 * account's source, TLS enforced, rotated OAuth2 refresh tokens re-sealed).
 *
 * While the job runs, the engine phase and every wait Microsoft Graph imposes
 * are kept in `jobs.payload.runtime` (the backup handler's PhaseRecorder), so
 * the restore page explains a pause instead of looking stuck. The outcome is
 * persisted into `jobs.payload.result`: counts, the download key, throttling
 * totals and the per-item outcomes (items needing attention first, capped),
 * so the API can show honestly what was restored, skipped, failed or could
 * not be confirmed. Item failures also reach `item_failures` through the
 * progress reporter while the job runs.
 *
 * The backup app registration is resolved like the backup handler's
 * (../entra-app.ts: the environment's ENTRA_CLIENT_*, else Settings → Microsoft
 * 365).
 *
 * Environment (shared with the backup handler):
 *   IMAP_ALLOW_INSECURE   "true" permits IMAP sources with security "none" (development only)
 */
import {
  CredentialSource,
  type FailureCause,
  type GraphClient,
  type ImapAccountConfig,
  ImapConfigError,
  ImapFlowRestoreSession,
  type ImapRestoreSession,
  type ProtectedObjectRef,
  type RestoreItemResult,
  type RestoreJobPayload,
  type RestoreRequest,
  type RestoreResult,
  type RestoreSelection,
  type RestoreTarget,
  type ThrottleInfo,
  assertTransport,
  authzidNotHonouredMessage,
  authzidWasHonoured,
  buildClientOptions,
  createRestoreEngines,
} from "@restow/core";
import { protectedObjects, restoreJobs, sources } from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { processEntraApp } from "../entra-app.js";
import type { TenantTxRunner } from "../progress.js";
import {
  type BackupRuntimeState,
  type BackupStore,
  type GraphSettings,
  PhaseRecorder,
  RESULT_KEY,
  RUNTIME_KEY,
  TokenProviderCache,
  graphClientForSource,
  imapAccountFor,
  mergeJobPayload,
  pgBackupStore,
} from "./backup.js";
import {
  InvalidPayloadError,
  type JobHandler,
  type JobOutcome,
  type WorkerJobContext,
  isUuid,
  tenantRunner,
} from "./framework.js";

type Env = Record<string, string | undefined>;
type RestoreJobRow = typeof restoreJobs.$inferSelect;

// ---------------------------------------------------------------------------
// From the stored request to the engine request
// ---------------------------------------------------------------------------

/** A core selection plus the presentation options the engines read next to it. */
export type StoredRestoreSelection = RestoreSelection & {
  readonly options?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read `restore_jobs.source_selection` back tolerantly. The column is jsonb
 * written by the API (apps/api/src/features/restore); an empty or unreadable
 * selection means "everything", matching core `matchesSelection` for an empty
 * filter. `options` (restore folder name, archive name) are passed through,
 * because core reads them from the selection (restore/common.ts).
 */
export function parseStoredSelection(value: unknown): StoredRestoreSelection {
  if (!isRecord(value)) {
    return { all: true };
  }
  const strings = (input: unknown): string[] | undefined =>
    Array.isArray(input) && input.every((item) => typeof item === "string")
      ? (input as string[])
      : undefined;
  const paths = strings(value.paths);
  const folderPaths = strings(value.folderPaths);
  const objectIds = strings(value.objectIds);
  const all = value.all === true || (!paths?.length && !folderPaths?.length && !objectIds?.length);
  return {
    ...(all ? { all: true } : {}),
    ...(!all && paths?.length ? { paths } : {}),
    ...(!all && folderPaths?.length ? { folderPaths } : {}),
    ...(!all && objectIds?.length ? { objectIds } : {}),
    ...(isRecord(value.options) ? { options: value.options } : {}),
  };
}

/** Build the engine request from the stored row and the loaded protected object. */
export function toRestoreRequest(
  row: RestoreJobRow,
  protectedObject: ProtectedObjectRef,
): RestoreRequest {
  if (!row.snapshotId) {
    throw new InvalidPayloadError(
      `restore ${row.id} references a snapshot that no longer exists (pruned)`,
    );
  }
  return {
    restoreJobId: row.id,
    snapshotId: row.snapshotId,
    protectedObject,
    selection: parseStoredSelection(row.sourceSelection),
    target: { type: row.targetType, ref: row.targetRef },
    mode: row.mode,
    actor: { userId: row.actorUserId, impersonated: row.impersonated, reason: row.reason },
    // Time-derived names (the default restore folder) stay the same on every retry.
    requestedAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// From the engine result to what the API reads
// ---------------------------------------------------------------------------

/** Per-item outcomes kept in the job payload; larger restores keep the ones needing attention. */
export const MAX_STORED_ITEMS = 1000;

export interface StoredRestoreItem {
  path: string;
  itemId: string | null;
  type: string;
  status: RestoreItemResult["status"];
  /** Machine-readable outcome the UI explains in the user's language. */
  code: RestoreItemResult["code"];
  targetRef: string | null;
  bytes: number;
  verified: boolean;
  reason: string | null;
  /** Subject and sender from the manifest, when recorded (mail, events). */
  subject: string | null;
  from: string | null;
  /** The classified cause of a failed item (why, what to do); null for other outcomes. */
  cause: FailureCause | null;
}

/** The `jobs.payload.result` shape the API reads (apps/api/src/features/restore/results.ts). */
export interface StoredRestoreResult {
  restored: number;
  skipped: number;
  failures: number;
  unverified: number;
  /** Folders recreated or found in place (containers, not counted as items). */
  folders: number;
  bytes: number;
  downloadKey: string | null;
  completedAt: string;
  /** Per-item outcomes the engine produced, before capping. */
  itemCount: number;
  items: StoredRestoreItem[];
  /** Pauses Microsoft Graph imposed on the run and their summed duration. */
  throttleWaits: number;
  throttleWaitMs: number;
}

/** Throttling totals of a run (see PhaseRecorder.throttleTotals). */
export interface ThrottleTotals {
  readonly waits: number;
  readonly totalWaitMs: number;
}

const NO_THROTTLING: ThrottleTotals = { waits: 0, totalWaitMs: 0 };

/** Engines return a RestoreReport (per-item outcomes); the contract only promises counts. */
function reportedItems(result: RestoreResult): readonly RestoreItemResult[] {
  const items = (result as { items?: unknown }).items;
  return Array.isArray(items) ? (items as RestoreItemResult[]) : [];
}

function reportedCount(result: RestoreResult, key: "unverified" | "folders"): number {
  const value = (result as Partial<Record<typeof key, unknown>>)[key];
  return typeof value === "number" && value >= 0 ? value : 0;
}

/** Failed first, then skipped, then restored-but-unconfirmed, then the rest. */
function attentionRank(item: RestoreItemResult): number {
  if (item.status === "failed") {
    return 0;
  }
  if (item.status === "skipped") {
    return 1;
  }
  return item.code === "unverified" ? 2 : 3;
}

export function storedItems(
  items: readonly RestoreItemResult[],
  limit: number = MAX_STORED_ITEMS,
): StoredRestoreItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => attentionRank(a.item) - attentionRank(b.item) || a.index - b.index)
    .slice(0, limit)
    .map(({ item }) => ({
      path: item.path,
      itemId: item.id ?? null,
      type: item.type,
      status: item.status,
      code: item.code,
      targetRef: item.targetRef ?? null,
      bytes: item.bytes,
      verified: item.verified,
      reason: item.reason ?? null,
      subject: item.subject ?? null,
      from: item.from ?? null,
      cause: item.cause ?? null,
    }));
}

export function toStoredResult(
  result: RestoreResult,
  completedAt: Date,
  throttle: ThrottleTotals = NO_THROTTLING,
): StoredRestoreResult {
  const items = reportedItems(result);
  return {
    restored: result.restored,
    skipped: result.skipped,
    failures: result.failures.length,
    unverified: reportedCount(result, "unverified"),
    folders: reportedCount(result, "folders"),
    bytes: result.bytes,
    downloadKey: result.downloadKey ?? null,
    completedAt: completedAt.toISOString(),
    itemCount: items.length,
    items: storedItems(items),
    throttleWaits: throttle.waits,
    throttleWaitMs: throttle.totalWaitMs,
  };
}

// ---------------------------------------------------------------------------
// Persistence seam
// ---------------------------------------------------------------------------

/** What the handler reads and writes around the engines; Postgres by default. */
export interface RestoreStore {
  loadRequest(restoreJobId: string): Promise<RestoreJobRow | null>;
  /** Phase and Graph throttling waits while the run goes on (`jobs.payload.runtime`). */
  persistRuntimeState(jobId: string, state: BackupRuntimeState): Promise<void>;
  persistResult(jobId: string, result: StoredRestoreResult): Promise<void>;
}

export function pgRestoreStore(run: TenantTxRunner, tenantId: string): RestoreStore {
  return {
    async loadRequest(restoreJobId) {
      const [row] = await run((tx) =>
        tx
          .select()
          .from(restoreJobs)
          .where(and(eq(restoreJobs.tenantId, tenantId), eq(restoreJobs.id, restoreJobId)))
          .limit(1),
      );
      return row ?? null;
    },

    persistRuntimeState: (jobId, state) =>
      mergeJobPayload(run, tenantId, jobId, { [RUNTIME_KEY]: state }),

    persistResult: (jobId, result) =>
      mergeJobPayload(run, tenantId, jobId, { [RESULT_KEY]: result }),
  };
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

/** Runs one restore request: the core engine set in production, a fake in tests. */
export interface RestoreDispatcher {
  run(ctx: WorkerJobContext, request: RestoreRequest): Promise<RestoreResult>;
}

/** What the handler hands a dispatcher for one run. */
export interface RestoreHooks {
  /** Graph made the run wait: recorded so the restore page can say so. */
  throttled(info: ThrottleInfo): void;
}

export type RestoreDispatcherFactory = (
  ctx: WorkerJobContext,
  hooks: RestoreHooks,
) => RestoreDispatcher;

function allowInsecureImap(env: Env): boolean {
  return env.IMAP_ALLOW_INSECURE?.trim().toLowerCase() === "true";
}

/** One Graph client per source and job, created on first use, reporting throttling waits. */
function graphClients(
  ctx: WorkerJobContext,
  store: BackupStore,
  settings: GraphSettings,
  throttled: (info: ThrottleInfo) => void,
): (engineCtx: unknown, protectedObject: ProtectedObjectRef) => Promise<GraphClient> {
  const clients = new Map<string, Promise<GraphClient>>();
  return (_engineCtx, protectedObject) => {
    let client = clients.get(protectedObject.sourceId);
    if (!client) {
      client = store
        .loadSource(protectedObject)
        .then(({ source }) =>
          graphClientForSource({ ctx, source, store, objectSecretRef: null, throttled }, settings),
        );
      clients.set(protectedObject.sourceId, client);
    }
    return client;
  };
}

/**
 * The IMAP account a restore writes into: the object's own account, or for
 * "another account" the tenant's IMAP account with that login (its source
 * holds the server and credential; the API only accepts known accounts).
 */
export async function imapTargetAccount(
  run: TenantTxRunner,
  tenantId: string,
  store: Pick<BackupStore, "loadSource">,
  protectedObject: ProtectedObjectRef,
  target: RestoreTarget,
): Promise<ImapAccountConfig> {
  if (target.type !== "other") {
    const { source, objectSecretRef } = await store.loadSource(protectedObject);
    return imapAccountFor(source, protectedObject, objectSecretRef);
  }
  const login = (target.ref ?? "").trim();
  const [row] = await run((tx) =>
    tx
      .select({ object: protectedObjects, source: sources })
      .from(protectedObjects)
      .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
      .where(
        and(
          eq(protectedObjects.tenantId, tenantId),
          eq(protectedObjects.kind, "imap"),
          // Imported mailboxes (source kind `import`) hold mail but cannot receive any.
          eq(sources.kind, "imap"),
          eq(sql`lower(${protectedObjects.externalId})`, login.toLowerCase()),
        ),
      )
      .limit(1),
  );
  if (!row) {
    throw new InvalidPayloadError(`IMAP account "${login}" is not an account of this tenant`);
  }
  return imapAccountFor(row.source, row.object, row.object.secretRef);
}

/** A connected, TLS-checked, authzid-checked IMAP session for the target account of a restore. */
async function openImapSession(
  ctx: WorkerJobContext,
  store: BackupStore,
  settings: GraphSettings,
  protectedObject: ProtectedObjectRef,
  target: RestoreTarget,
): Promise<ImapRestoreSession> {
  const run = tenantRunner(ctx.db, ctx.tenantId);
  const account = await imapTargetAccount(run, ctx.tenantId, store, protectedObject, target);
  assertTransport(account, allowInsecureImap(settings.env));
  const logger = ctx.logger.child({ component: "imap-restore", host: account.host });
  const credentials = new CredentialSource({
    secrets: ctx.secrets,
    account,
    logger,
    onRefreshTokenRotated: (secretId, secretJson) => store.replaceSecret(secretId, secretJson),
  });
  const credential = await credentials.resolve();
  const client = new ImapFlow(buildClientOptions(account, credential));
  // An unhandled 'error' event would take the worker process down.
  client.on("error", (error: Error) =>
    logger.warn("imap connection error", { error: error.message }),
  );
  try {
    await client.connect();
    if (account.security !== "none" && !client.secureConnection) {
      throw new ImapConfigError(
        `connection to ${account.host}:${account.port} is not encrypted; TLS is required`,
      );
    }
    if (!authzidWasHonoured(client, account, credential)) {
      // Without this, a server offering neither AUTH=LOGIN nor AUTH=PLAIN
      // would silently sign this restore session in as the master account
      // itself instead of impersonating the target mailbox (see
      // authzidWasHonoured), and the APPEND that follows would land in the
      // wrong mailbox while the job still reports success.
      throw new ImapConfigError(authzidNotHonouredMessage(account));
    }
    const onAbort = () => client.close();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    client.once("close", () => ctx.signal.removeEventListener("abort", onAbort));
    return await ImapFlowRestoreSession.open(client);
  } catch (error) {
    client.close();
    throw error;
  }
}

/**
 * The Microsoft 365 mailbox an imported mailbox is restored into. The imported
 * mailbox's own source is `import` (it has no Graph tenant), so the Graph
 * client must come from the target mailbox's source.
 */
export async function mailboxTargetObject(
  run: TenantTxRunner,
  tenantId: string,
  address: string | null,
): Promise<ProtectedObjectRef> {
  const login = (address ?? "").trim().toLowerCase();
  const [row] = await run((tx) =>
    tx
      .select()
      .from(protectedObjects)
      .where(
        and(
          eq(protectedObjects.tenantId, tenantId),
          eq(protectedObjects.kind, "mailbox"),
          eq(sql`lower(${protectedObjects.externalId})`, login),
        ),
      )
      .limit(1),
  );
  if (!row) {
    throw new InvalidPayloadError(
      `mailbox "${address}" is not a Microsoft 365 mailbox of this tenant`,
    );
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    sourceId: row.sourceId,
    kind: row.kind,
    externalId: row.externalId,
    displayName: row.displayName,
    userId: row.userId,
  };
}

/** The kind of account the API recorded as the target of an imported mailbox's restore. */
export function restoreTargetKindOf(request: RestoreRequest): "mailbox" | "imap" | null {
  const options = (request.selection as { options?: unknown }).options;
  const kind = isRecord(options) ? options.targetKind : undefined;
  return kind === "mailbox" || kind === "imap" ? kind : null;
}

/** The engines this build ships, wired to the job's sources and credentials. */
export function createDefaultRestoreDispatcher(settings: GraphSettings): RestoreDispatcherFactory {
  return (ctx, hooks) => {
    const run = tenantRunner(ctx.db, ctx.tenantId);
    const store = pgBackupStore(run, ctx.tenantId, ctx.keys);
    // Set while an imported mailbox is restored into a Microsoft 365 mailbox: Graph is then
    // asked for the target mailbox's source, not for the (Graph-less) import source.
    let graphSubject: ProtectedObjectRef | null = null;
    const graph = graphClients(ctx, store, settings, (info) => hooks.throttled(info));
    const engines = createRestoreEngines({
      graph: (engineCtx, protectedObject) => graph(engineCtx, graphSubject ?? protectedObject),
      imap: (_engineCtx, protectedObject, target) =>
        openImapSession(ctx, store, settings, protectedObject, target),
    });
    return {
      async run(jobCtx, request) {
        if (
          request.target.type === "other" &&
          request.protectedObject.kind === "imap" &&
          restoreTargetKindOf(request) === "mailbox"
        ) {
          // The Exchange engine reads the IMAP manifest layout of the imported mailbox.
          graphSubject = await mailboxTargetObject(run, ctx.tenantId, request.target.ref);
          const exchange = engines.byKind.get("mailbox");
          if (!exchange) {
            throw new InvalidPayloadError("no Exchange restore engine in this build");
          }
          return exchange.run(jobCtx, request);
        }
        return engines.run(jobCtx, request);
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface RestoreHandlerOptions {
  readonly dispatcher: RestoreDispatcherFactory;
  /** Defaults to Postgres. */
  readonly store?: (ctx: WorkerJobContext) => RestoreStore;
}

export function createRestoreHandler(options: RestoreHandlerOptions): JobHandler<"restore"> {
  const storeFor =
    options.store ??
    ((ctx: WorkerJobContext) => pgRestoreStore(tenantRunner(ctx.db, ctx.tenantId), ctx.tenantId));

  return {
    queue: "restore",

    async run(ctx: WorkerJobContext, payload: RestoreJobPayload): Promise<JobOutcome> {
      if (!isUuid(payload.restoreJobId)) {
        throw new InvalidPayloadError("restore job payload has no restoreJobId");
      }
      const protectedObject = ctx.protectedObject;
      if (!protectedObject) {
        throw new InvalidPayloadError("restore job payload names no protected object");
      }
      const store = storeFor(ctx);
      const row = await store.loadRequest(payload.restoreJobId);
      if (!row) {
        throw new InvalidPayloadError(`restore request ${payload.restoreJobId} does not exist`);
      }

      const request = toRestoreRequest(row, protectedObject);
      const logger = ctx.logger.child({
        restoreJobId: row.id,
        snapshotId: request.snapshotId,
        kind: protectedObject.kind,
        target: request.target.type,
        mode: request.mode,
        impersonated: request.actor.impersonated,
      });
      logger.info("restore started");

      // Phases and every Graph throttling wait reach `jobs.payload.runtime`,
      // so a restore held back by Microsoft says so instead of looking stuck.
      const recorder = new PhaseRecorder(
        ctx.progress,
        (state) => store.persistRuntimeState(ctx.jobId, state),
        logger,
        ctx.now,
      );
      const dispatcher = options.dispatcher(ctx, {
        throttled: (info) => recorder.throttled(info),
      });
      let result: RestoreResult;
      try {
        result = await dispatcher.run({ ...ctx, progress: recorder }, request);
      } finally {
        // Whatever happened, the phase and any throttle wait must not outlive the run.
        await recorder.finish();
      }

      // Engines report item failures as they go; one that only returns them
      // still gets them into item_failures for the UI.
      if (ctx.progress.snapshot().failed === 0) {
        for (const failure of result.failures) {
          ctx.progress.fail(failure.itemRef, failure.reason, failure.cause);
        }
      }

      const stored = toStoredResult(result, ctx.now(), recorder.throttleTotals());
      await store.persistResult(ctx.jobId, stored);
      const { items: _items, ...counts } = stored;
      logger.info("restore finished", counts);
      return { summary: counts };
    },
  };
}

/** Process-wide token cache: one token per customer tenant, reused across restores. */
const restoreTokens = new TokenProviderCache();

/** The handler listed in ./index.ts. */
export const restoreHandler: JobHandler<"restore"> = createRestoreHandler({
  dispatcher: createDefaultRestoreDispatcher({
    env: process.env,
    entraApp: processEntraApp,
    tokens: restoreTokens,
  }),
});
