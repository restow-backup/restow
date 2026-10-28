/**
 * The IMAP capture way (`imap_sync`, docs/IMAP.md "Archivierung", ./ways.ts): an IMAP account
 * archived from the mailbox, by @restow/core's archive/imap-capture.ts.
 *
 * A pass logs in once (the backup's account resolution and credentials, ../handlers/backup.ts
 * `imapAccountFor`), asks STATUS of every folder it reads and fetches only new mail; mail the
 * archive already holds for the account (a forwarded copy, another folder) is not downloaded.
 * Activation records where each folder stands; mail up to there is taken over by the one-time
 * backfill (`archive` job), checkpointed in that job's cursor.
 *
 * How new mail is noticed:
 *
 *   - IDLE (`mode: notifications`): every worker process watches up to
 *     `ARCHIVE_IMAP_IDLE_MAX` (default 300) accounts with one IMAP connection each, IDLE on
 *     INBOX (All Mail on Gmail), restarted before 29 minutes. New mail marks the stream due;
 *     every `ARCHIVE_IMAP_POLL_MINUTES` (default 5) the connection asks STATUS of the other
 *     folders and marks the stream due when one has new mail. A pass of a watched account
 *     still runs every 30 minutes as a safety net.
 *   - Polling (`mode: poll`): an account no worker watches is passed every
 *     `ARCHIVE_IMAP_LOGIN_POLL_MINUTES` (default 10). The reason is shown with the stream:
 *     `imap.idle_unsupported` (the server has no IDLE), `imap.idle_disabled` (the source's
 *     `archiveIdle: "off"`, for providers with a tight connection limit) or `imap.idle_budget`
 *     (no worker has a free IDLE slot for it).
 *
 * Which process watches which account is decided by session-level Postgres advisory locks on
 * one dedicated connection of the installation pool (key: {@link IDLE_LOCK_CLASS}, the
 * stream id's hash): a process takes the accounts whose lock it gets, and a crashed process
 * loses them with its connection. A pass checks the same lock to tell whether someone watches
 * its account. Connection budget per account: the IDLE connection, during a pass briefly a
 * second one, plus the backup's own (at most two, ../handlers/backup.ts).
 */
import {
  archive,
  CredentialSource,
  type ImapAccountConfig,
  type ImapConnector,
  ImapFlowConnector,
  type ImapSession,
  isImapSessionError,
  type Logger,
  type ProtectedObjectRef,
  type TenantKeyring,
} from "@restow/core";
import {
  captureKindOf,
  type Database,
  protectedObjects,
  type Source,
  safeErrorMessage,
  sources,
} from "@restow/db";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { imapAccountFor, pgBackupStore } from "../handlers/backup.js";
import { PgSecretReader, tenantRunner, withTenantTx } from "../handlers/framework.js";
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

export interface ImapCaptureSettings {
  /** Accounts this process watches with IDLE at most (`ARCHIVE_IMAP_IDLE_MAX`). */
  readonly idleMax: number;
  /** STATUS of the other folders of a watched account, in minutes (`ARCHIVE_IMAP_POLL_MINUTES`). */
  readonly pollMinutes: number;
  /** Passes of an account nobody watches, in minutes (`ARCHIVE_IMAP_LOGIN_POLL_MINUTES`). */
  readonly loginPollMinutes: number;
  /** Safety pass of a watched account, in minutes. */
  readonly watchedPassMinutes: number;
  /** IDLE is restarted after this long (servers end IDLE after 30 minutes). */
  readonly maxIdleMs: number;
  /** How often the IDLE manager takes up and gives back accounts. */
  readonly refreshMs: number;
  /** A watch that failed is retried after this long (an account without IDLE: after a day). */
  readonly retryMs: number;
  /** A backfill job stops after this long and continues in the next one. */
  readonly backfillBudgetMs: number;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const value = Number.parseInt(env[name]?.trim() ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** `ARCHIVE_IMAP_IDLE_MAX=0` turns IDLE off for the process. */
function nonNegativeInt(env: Env, name: string, fallback: number): number {
  const value = Number.parseInt(env[name]?.trim() ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function imapCaptureSettingsFromEnv(env: Env = process.env): ImapCaptureSettings {
  return {
    idleMax: nonNegativeInt(env, "ARCHIVE_IMAP_IDLE_MAX", 300),
    pollMinutes: positiveInt(env, "ARCHIVE_IMAP_POLL_MINUTES", 5),
    loginPollMinutes: positiveInt(env, "ARCHIVE_IMAP_LOGIN_POLL_MINUTES", 10),
    watchedPassMinutes: 30,
    maxIdleMs: 25 * 60_000,
    refreshMs: 60_000,
    retryMs: 5 * 60_000,
    backfillBudgetMs: 30 * 60_000,
  };
}

/** The advisory lock class of an account watched with IDLE ("IMAP" in ASCII). */
export const IDLE_LOCK_CLASS = 0x494d4150;
/** An account whose server has no IDLE is asked again after this long. */
const NO_IDLE_RETRY_MS = 24 * 60 * 60_000;
/** A watch that keeps failing backs off doubling from `retryMs` up to this. */
const FAILED_RETRY_CAP_MS = 60 * 60_000;
/** Where the backfill keeps its position in the `archive` job's cursor. */
const CURSOR_KEY = "imapArchive";

/** What a pass or a watch needs to log in to one account. */
export interface LoadedImapAccount {
  readonly account: ImapAccountConfig;
  readonly credentials: CredentialSource;
  /** The account is at Google (OAuth2 source of Google, or the Gmail host). */
  readonly gmail: boolean;
  readonly archiveIdle: "auto" | "off";
}

/** Resolve the account behind an archived IMAP mailbox, its credential opened with `keys`. */
export async function loadImapAccount(options: {
  readonly db: Database;
  readonly tenantId: string;
  readonly protectedObjectId: string;
  readonly keys: TenantKeyring;
  readonly logger: Logger;
  readonly env?: Env;
}): Promise<LoadedImapAccount> {
  const { db, tenantId, keys } = options;
  const [row] = await withTenantTx(db, tenantId, (tx) =>
    tx
      .select({ object: protectedObjects, source: sources })
      .from(protectedObjects)
      .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
      .where(
        and(
          eq(protectedObjects.tenantId, tenantId),
          eq(protectedObjects.id, options.protectedObjectId),
        ),
      )
      .limit(1),
  );
  if (!row) {
    throw new Error(`archived mailbox ${options.protectedObjectId} no longer exists`);
  }
  const source: Source = row.source;
  const object: ProtectedObjectRef = {
    id: row.object.id,
    tenantId,
    sourceId: row.object.sourceId,
    kind: row.object.kind,
    externalId: row.object.externalId,
    displayName: row.object.displayName,
    userId: row.object.userId,
  };
  const account = imapAccountFor(source, object, row.object.secretRef, options.env);
  const run = tenantRunner(db, tenantId);
  const credentials = new CredentialSource({
    secrets: new PgSecretReader(run, tenantId, keys),
    account,
    logger: options.logger,
    onRefreshTokenRotated: (secretId, secretJson) =>
      pgBackupStore(run, tenantId, keys).replaceSecret(secretId, secretJson),
  });
  const kind = captureKindOf({
    objectKind: row.object.kind,
    sourceKind: source.kind,
    host: source.host,
    config: source.config,
  });
  return {
    account,
    credentials,
    gmail: kind === "google",
    archiveIdle: source.config.archiveIdle === "off" ? "off" : "auto",
  };
}

/** Log in to an account; `security: none` only where the backup allows it too. */
async function connect(
  connector: ImapConnector,
  loaded: LoadedImapAccount,
  options: { logger: Logger; signal: AbortSignal; env: Env; maxIdleTimeMs?: number },
): Promise<ImapSession> {
  if (
    loaded.account.security === "none" &&
    options.env.IMAP_ALLOW_INSECURE?.trim().toLowerCase() !== "true"
  ) {
    throw new Error(
      `IMAP source ${loaded.account.host} is configured without TLS; set IMAP_ALLOW_INSECURE=true only for development`,
    );
  }
  return connector.connect(loaded.account, await loaded.credentials.resolve(), {
    logger: options.logger,
    signal: options.signal,
    ...(options.maxIdleTimeMs !== undefined ? { maxIdleTimeMs: options.maxIdleTimeMs } : {}),
  });
}

/** The stream state with the capture's keys replaced and every other key kept. */
export function withImapState(
  previous: ArchiveStreamState,
  state: archive.ImapCaptureState,
): ArchiveStreamState {
  const { folders: _f, idle: _i, gmail: _g, ...rest } = previous;
  return {
    ...rest,
    folders: state.folders,
    ...(state.idle ? { idle: state.idle } : {}),
    ...(state.gmail ? { gmail: true } : {}),
  };
}

/** Whether a process watches the stream's account with IDLE (holds its advisory lock). */
export async function idleWatched(db: Database, streamId: string): Promise<boolean> {
  const result = await db.transaction((tx) =>
    tx.execute<{ free: boolean }>(
      sql`select pg_try_advisory_xact_lock(${IDLE_LOCK_CLASS}::int, hashtext(${streamId})) as free`,
    ),
  );
  return result.rows[0]?.free === false;
}

/** How a stream's new mail is noticed, for the status page (./ways.ts EnsureResult). */
export function imapMode(input: {
  readonly archiveIdle: "auto" | "off";
  readonly idleSupported: boolean | undefined;
  readonly watched: boolean;
}): Pick<EnsureResult, "mode" | "pollReason"> {
  if (input.archiveIdle === "off") {
    return { mode: "poll", pollReason: "imap.idle_disabled" };
  }
  if (input.idleSupported === false) {
    return { mode: "poll", pollReason: "imap.idle_unsupported" };
  }
  if (input.watched) {
    return { mode: "notifications" };
  }
  return { mode: "poll", pollReason: "imap.idle_budget" };
}

export interface ImapCaptureWayOptions {
  readonly connector?: ImapConnector;
  readonly settings?: Partial<ImapCaptureSettings>;
  readonly env?: Env;
  /** Account resolution (tests replace it). */
  readonly loadAccount?: typeof loadImapAccount;
}

/** The IMAP capture way (registered in ./registry.ts). */
export function createImapCaptureWay(options: ImapCaptureWayOptions = {}): CaptureWay & {
  /** The IDLE manager once started (tests). */
  readonly idle: () => ImapIdleManager | null;
} {
  const env = options.env ?? process.env;
  const settings = { ...imapCaptureSettingsFromEnv(env), ...options.settings };
  const connector = options.connector ?? new ImapFlowConnector();
  const load = options.loadAccount ?? loadImapAccount;
  let manager: ImapIdleManager | null = null;

  const accountOf = (ctx: CaptureContext) =>
    load({
      db: ctx.db,
      tenantId: ctx.tenantId,
      protectedObjectId: ctx.stream.protectedObjectId,
      keys: ctx.keys,
      logger: ctx.logger,
      env,
    });

  async function withSession<T>(
    ctx: CaptureContext,
    loaded: LoadedImapAccount,
    fn: (session: ImapSession) => Promise<T>,
  ): Promise<T> {
    const session = await connect(connector, loaded, {
      logger: ctx.logger,
      signal: ctx.signal,
      env,
    });
    try {
      return await fn(session);
    } finally {
      await session.logout().catch(() => undefined);
    }
  }

  const sink = (ctx: CaptureContext): archive.ImapCaptureSink => ({
    signal: ctx.signal,
    alreadyCaptured: (query) => ctx.alreadyCaptured(query),
    append: (mail) =>
      ctx.append({
        original: mail.original,
        externalRef: mail.externalRef,
        receivedByService: mail.receivedByService,
      }),
  });

  return {
    way: "imap_sync",
    idle: () => manager,

    async ensure(ctx) {
      const loaded = await accountOf(ctx);
      let state = archive.readImapCaptureState(ctx.stream.state);
      let next: ArchiveStreamState = ctx.stream.state;
      if (ctx.stream.activatedAt === null || !archive.imapCaptureActivated(state)) {
        state = await withSession(ctx, loaded, (session) =>
          archive.activateImapCapture(session, { gmail: loaded.gmail, logger: ctx.logger }),
        );
        next = withImapState(ctx.stream.state, state);
      }
      const watched = settings.idleMax > 0 && (await idleWatched(ctx.db, ctx.stream.id));
      return {
        state: next,
        activated: true,
        ...imapMode({
          archiveIdle: loaded.archiveIdle,
          idleSupported: state.idle?.supported,
          watched,
        }),
      };
    },

    async drain(_ctx, refs): Promise<DrainResult> {
      // Nothing announces single IMAP messages (IDLE only marks the stream due).
      return { handled: refs, captured: 0 };
    },

    async catchUp(ctx): Promise<CatchUpResult> {
      const loaded = await accountOf(ctx);
      const previous = archive.readImapCaptureState(ctx.stream.state);
      const result = await withSession(ctx, loaded, (session) =>
        archive.catchUpImapCapture(session, previous, sink(ctx), {
          gmail: loaded.gmail,
          rescan: ctx.reason === "resync",
          logger: ctx.logger,
          checkpoint: (state) => ctx.checkpoint(withImapState(ctx.stream.state, state)),
        }),
      );
      const watched = settings.idleMax > 0 && (await idleWatched(ctx.db, ctx.stream.id));
      const minutes = watched ? settings.watchedPassMinutes : settings.loginPollMinutes;
      return {
        state: withImapState(ctx.stream.state, result.state),
        captured: result.captured,
        nextDueAt: new Date(ctx.now().getTime() + minutes * 60_000),
      };
    },

    async backfill(ctx: BackfillContext): Promise<BackfillResult> {
      const loaded = await accountOf(ctx);
      const state = archive.readImapCaptureState(ctx.stream.state);
      const saved = await ctx.job.cursor.load();
      const start = archive.readImapBackfillCursor(saved?.[CURSOR_KEY]);
      const result = await withSession(ctx, loaded, (session) =>
        archive.backfillImapCapture(session, state, start, sink(ctx), {
          logger: ctx.logger,
          deadline: ctx.now().getTime() + settings.backfillBudgetMs,
          now: () => ctx.now().getTime(),
          saveCursor: (cursor) => ctx.job.cursor.save({ ...(saved ?? {}), [CURSOR_KEY]: cursor }),
        }),
      );
      return { captured: result.captured, skipped: result.skipped, completed: result.completed };
    },

    start(services) {
      if (settings.idleMax <= 0) {
        return;
      }
      manager = new ImapIdleManager({ services, settings, connector, env, load });
      manager.start();
    },
  };
}

// ---------------------------------------------------------------------------
// IDLE
// ---------------------------------------------------------------------------

/** The dedicated installation-pool connection that holds the IDLE locks. */
interface LockClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

interface HeldStream {
  readonly id: string;
  readonly tenantId: string;
  readonly protectedObjectId: string;
  readonly controller: AbortController;
  done: Promise<void>;
  /** The IDLE connection once it watches, and the folder it watches. */
  session: ImapSession | null;
  folder: string | null;
  /** IDLE was established once: the stream's pass recorded it, or is due to. */
  established: boolean;
}

interface IdleManagerDeps {
  readonly services: CaptureWayServices;
  readonly settings: ImapCaptureSettings;
  readonly connector: ImapConnector;
  readonly env: Env;
  readonly load: typeof loadImapAccount;
  readonly now?: () => number;
}

/** Waits `ms` or until `signal` fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
  });
}

function uuidArray(ids: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}

/**
 * Watches up to `idleMax` accounts with IDLE (see the module docstring). One round every
 * `refreshMs` ({@link refresh}): give back accounts that are no longer live or whose source
 * turned IDLE off, take up new ones while slots are free, and every `pollMinutes` ask STATUS
 * of the other folders of each watched account (one query for all their states).
 */
export class ImapIdleManager {
  private readonly held = new Map<string, HeldStream>();
  /** Accounts not to try again before the time given (epoch ms). */
  private readonly backoff = new Map<string, number>();
  /** Watches in a row that failed before IDLE began, per stream (the backoff grows with it). */
  private readonly failures = new Map<string, number>();
  private lockClient: LockClient | null = null;
  private loop: Promise<void> | null = null;
  private lastStatusRound: number;
  private readonly now: () => number;

  constructor(private readonly deps: IdleManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.lastStatusRound = this.now();
  }

  /** Streams watched by this process right now (with an open IDLE connection or connecting). */
  watching(): string[] {
    return [...this.held.keys()];
  }

  /** Streams whose IDLE connection is established (tests). */
  idling(): string[] {
    return [...this.held.values()].filter((held) => held.folder !== null).map((held) => held.id);
  }

  start(): void {
    if (this.loop) {
      return;
    }
    const { signal } = this.deps.services;
    this.loop = (async () => {
      while (!signal.aborted) {
        try {
          await this.refresh();
        } catch (error) {
          this.deps.services.logger.warn("imap idle refresh failed", {
            errorMessage: safeErrorMessage(error),
          });
          await this.releaseAll();
        }
        await sleep(this.deps.settings.refreshMs, signal);
      }
      await this.releaseAll();
    })();
  }

  /** Stop every watch and give the locks back (shutdown, tests). */
  async stop(): Promise<void> {
    await this.releaseAll();
    await this.loop;
  }

  /** One round (see the class docstring). */
  async refresh(): Promise<void> {
    const { services, settings } = this.deps;
    if (!services.active() || services.signal.aborted) {
      await this.releaseAll();
      return;
    }
    const client = await this.lockConnection();
    if (this.held.size > 0) {
      const keep = await services.providerDb.execute<{ id: string }>(sql`
        select s.id from archive_capture_streams s
          join sources src on src.id = s.source_id
         where s.id = any(${uuidArray([...this.held.keys()])})
           and s.way = 'imap_sync' and s.status in ('live', 'backfilling')
           and coalesce(src.config->>'archiveIdle', 'auto') <> 'off'
           and src.status <> 'disabled'
      `);
      const kept = new Set(keep.rows.map((row) => row.id));
      for (const id of [...this.held.keys()]) {
        if (!kept.has(id)) {
          await this.release(id);
        }
      }
    }
    const free = settings.idleMax - this.held.size;
    if (free > 0) {
      const now = this.now();
      for (const [id, until] of this.backoff) {
        if (until <= now) {
          this.backoff.delete(id);
        }
      }
      const exclude = [...this.held.keys(), ...this.backoff.keys()];
      const excluded = exclude.length > 0 ? sql`and s.id <> all(${uuidArray(exclude)})` : sql``;
      // The locks are tried row by row as the limit pulls rows from the materialized
      // candidates, so this process locks at most `free` accounts.
      const query = new PgDialect().sqlToQuery(sql`
        with candidates as materialized (
          select s.id, s.tenant_id, s.protected_object_id
            from archive_capture_streams s
            join sources src on src.id = s.source_id
           where s.way = 'imap_sync' and s.status in ('live', 'backfilling')
             and coalesce(src.config->>'archiveIdle', 'auto') <> 'off'
             and src.status <> 'disabled'
             and s.state->'idle'->>'folder' is not null
             and coalesce((s.state->'idle'->>'supported')::boolean, false)
             ${excluded}
           order by s.id
           limit ${free * 4}
        )
        select c.id, c.tenant_id, c.protected_object_id from candidates c
         where pg_try_advisory_lock(${IDLE_LOCK_CLASS}::int, hashtext(c.id::text))
         limit ${free}
      `);
      const taken = await client.query(query.sql, query.params);
      for (const row of taken.rows) {
        this.watch({
          id: String(row.id),
          tenantId: String(row.tenant_id),
          protectedObjectId: String(row.protected_object_id),
        });
      }
    }
    if (this.now() - this.lastStatusRound >= settings.pollMinutes * 60_000) {
      this.lastStatusRound = this.now();
      await this.statusRound();
    }
  }

  /** STATUS of the other folders of every watched account; due when one has new mail. */
  async statusRound(): Promise<void> {
    const watched = [...this.held.values()].filter((held) => held.session && held.folder);
    if (watched.length === 0) {
      return;
    }
    const result = await this.deps.services.providerDb.execute<{
      id: string;
      state: ArchiveStreamState | null;
    }>(sql`
      select id, state from archive_capture_streams where id = any(${uuidArray(watched.map((held) => held.id))})
    `);
    const states = new Map(result.rows.map((row) => [row.id, row.state ?? {}]));
    await Promise.all(
      watched.map((held) =>
        this.checkOtherFolders(held, archive.readImapCaptureState(states.get(held.id))),
      ),
    );
  }

  private async lockConnection(): Promise<LockClient> {
    if (this.lockClient) {
      return this.lockClient;
    }
    const client = (await this.deps.services.providerDb.$client.connect()) as unknown as LockClient;
    client.on("error", (error) => {
      // The connection, and with it every lock, is gone: stop every watch.
      this.deps.services.logger.warn("imap idle lock connection lost", {
        errorMessage: safeErrorMessage(error),
      });
      if (this.lockClient === client) {
        this.lockClient = null;
      }
      const given = [...this.held.values()];
      for (const held of given) {
        held.controller.abort("lock connection lost");
      }
      this.held.clear();
      void this.handedBack(given);
    });
    this.lockClient = client;
    return client;
  }

  private async unlock(id: string): Promise<void> {
    await this.lockClient
      ?.query("select pg_advisory_unlock($1::int, hashtext($2))", [IDLE_LOCK_CLASS, id])
      .catch(() => undefined);
  }

  private async release(id: string): Promise<void> {
    const held = this.held.get(id);
    if (!held) {
      return;
    }
    this.held.delete(id);
    held.controller.abort("released");
    await held.done.catch(() => undefined);
    await this.unlock(id);
    await this.handedBack([held]);
  }

  /**
   * Accounts given back (unlocked): a pass records that they are polled now and when to
   * come back (`_mode`, `nextDueAt`), and fetches whatever arrived meanwhile. Not on
   * shutdown; a stream whose watch never began needs it only after a failure.
   */
  private async handedBack(given: readonly HeldStream[]): Promise<void> {
    if (this.deps.services.signal.aborted) {
      return;
    }
    const ids = given.filter((held) => held.established).map((held) => held.id);
    await this.deps.services.markDue(ids).catch(() => undefined);
  }

  private async releaseAll(): Promise<void> {
    for (const id of [...this.held.keys()]) {
      await this.release(id);
    }
    const client = this.lockClient;
    this.lockClient = null;
    // Ending the session gives back any lock that is left.
    client?.release(true);
  }

  private watch(stream: { id: string; tenantId: string; protectedObjectId: string }): void {
    const held: HeldStream = {
      ...stream,
      controller: new AbortController(),
      done: Promise.resolve(),
      session: null,
      folder: null,
      established: false,
    };
    this.held.set(stream.id, held);
    held.done = this.run(held).then(async (outcome) => {
      if (this.held.get(stream.id) !== held) {
        return;
      }
      // Ended on its own (a failure, no IDLE): free the slot and the lock, retry later.
      this.held.delete(stream.id);
      await this.unlock(stream.id);
      // After the unlock, so the pass sees the account as polled. Whatever arrived while
      // nobody watched is fetched by that pass.
      if (outcome !== "released" || held.established) {
        await this.deps.services.markDue([stream.id]).catch(() => undefined);
      }
      // A NO on EXAMINE or IDLE (throttling, a transient server error) is a failure, not a
      // server without IDLE: retried after `retryMs`, doubling while it keeps failing, so a
      // server that refuses every time is not asked every few minutes forever either.
      const failed =
        outcome === "failed" && !held.established ? (this.failures.get(stream.id) ?? 0) + 1 : 0;
      if (failed > 0) {
        this.failures.set(stream.id, failed);
      } else {
        this.failures.delete(stream.id);
      }
      const retryMs = Math.min(
        this.deps.settings.retryMs * 2 ** Math.min(Math.max(failed - 1, 0), 16),
        Math.max(FAILED_RETRY_CAP_MS, this.deps.settings.retryMs),
      );
      this.backoff.set(
        stream.id,
        this.now() + (outcome === "unsupported" ? NO_IDLE_RETRY_MS : retryMs),
      );
    });
  }

  /** One watched account until released; resolves with why it ended. Never rejects. */
  private async run(held: HeldStream): Promise<"released" | "failed" | "unsupported"> {
    const { services, settings, connector, env } = this.deps;
    const logger = services.logger.child({ streamId: held.id, tenantId: held.tenantId });
    const signal = AbortSignal.any([held.controller.signal, services.signal]);
    let session: ImapSession | null = null;
    try {
      const keys = await services.keyring(held.tenantId);
      const loaded = await this.deps.load({
        db: services.db,
        tenantId: held.tenantId,
        protectedObjectId: held.protectedObjectId,
        keys,
        logger,
        env,
      });
      if (loaded.archiveIdle === "off") {
        return "released";
      }
      session = await connect(connector, loaded, {
        logger,
        signal,
        env,
        maxIdleTimeMs: settings.maxIdleMs,
      });
      // Only a server without the IDLE capability gets the day-long backoff.
      if (!session.idleSupported) {
        return "unsupported";
      }
      const result = await services.providerDb.execute<{ state: ArchiveStreamState | null }>(
        sql`select state from archive_capture_streams where id = ${held.id}::uuid`,
      );
      const folder = archive.readImapCaptureState(result.rows[0]?.state ?? {}).idle?.folder;
      if (!folder) {
        return "failed";
      }
      await session.openFolder(folder);
      held.session = session;
      held.folder = folder;
      held.established = true;
      // The account is watched (the lock is held): a pass records it for the status page
      // (`_mode: notifications`) and moves the safety pass out to `watchedPassMinutes`.
      // Without it the stream showed polling until its next scheduled pass, up to
      // `loginPollMinutes` later.
      await services.markDue([held.id]).catch(() => undefined);
      for await (const _ of session.idle(signal)) {
        await services.markDue([held.id]);
      }
      return "released";
    } catch (error) {
      if (signal.aborted) {
        return "released";
      }
      logger.info("imap idle watch ended; the account is polled until it is watched again", {
        errorMessage: safeErrorMessage(error),
      });
      // The stream is made due once the lock is given back (watch()). A command-level error
      // (a NO on EXAMINE of the watched folder or on IDLE) is not "no IDLE": the server
      // announced it (checked above), so it is retried like any other failure, and the
      // status page does not read a refused command as a missing IDLE slot for a day.
      return "failed";
    } finally {
      held.session = null;
      held.folder = null;
      await session?.logout().catch(() => undefined);
    }
  }

  private async checkOtherFolders(
    held: HeldStream,
    state: archive.ImapCaptureState,
  ): Promise<void> {
    const session = held.session;
    if (!session) {
      return;
    }
    try {
      for (const [path, folder] of Object.entries(state.folders)) {
        if (path === held.folder || held.controller.signal.aborted) {
          continue;
        }
        const status = await session.status(path).catch((error) => {
          if (isImapSessionError(error) && !error.connectionLost) {
            return null;
          }
          throw error;
        });
        if (
          status === null ||
          status.uidValidity !== folder.uidValidity ||
          status.uidNext > folder.lastUid + 1
        ) {
          await this.deps.services.markDue([held.id]);
          return;
        }
      }
    } catch (error) {
      this.deps.services.logger.debug("imap status round failed", {
        streamId: held.id,
        errorMessage: safeErrorMessage(error),
      });
    }
  }
}
