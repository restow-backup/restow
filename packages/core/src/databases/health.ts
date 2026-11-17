import type { DbProbeResult } from "./facts.js";
import { compareDbInstance, type DbInstanceIdentity, dbInstanceKey } from "./identity.js";
import { type DbEngine, isDbSystemDatabase } from "./model.js";

/**
 * Health checks of the module "Databases" (docs/DATABASES.md 8): independent of the runs, the
 * executor of a connection checks it lightly and regularly with the backup user, read-only, in at
 * most 10 seconds. The server judges what the executor reports (as for a connection test) and
 * keeps the history in `database_health_samples`; the worker turns three failed checks in a row
 * into `database.unreachable` and the first good one after into `database.reachable`, once per
 * episode (2.4).
 *
 * Reachability is shown beside the rating and never changes it (2.4): a database that cannot be
 * reached right now still has good backups.
 *
 * A check counts as good when the executor signed in and `SELECT 1` answered (SQLite: the file
 * reads as an SQLite database; SQL Server: the PRELOGIN answers, until D5 signs in). Everything
 * else is a failed check with its code, also a refused sign-in: the backup could not run either.
 */

/** Health check interval of a connection (8): default 5 minutes, 1 to 60. */
export const DB_HEALTH_DEFAULT_INTERVAL_MINUTES = 5;
export const DB_HEALTH_MIN_INTERVAL_MINUTES = 1;
export const DB_HEALTH_MAX_INTERVAL_MINUTES = 60;

/** One check: at most 10 seconds (8). */
export const DB_HEALTH_TIMEOUT_SECONDS = 10;

/** The size of each database is read at most once an hour (8: it costs more). */
export const DB_HEALTH_SIZES_EVERY_MS = 60 * 60 * 1000;

/** `database.unreachable` after this many failed checks in a row (2.4, 8). */
export const DB_HEALTH_UNREACHABLE_AFTER = 3;

/**
 * A connection that flaps gets at most one pair of `database.unreachable` and
 * `database.reachable` in this time: a new episode within it is alerted only once it lasts past
 * it (the alert comes late, not never).
 */
export const DB_HEALTH_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/** A good check slower than this is shown as "slow" (connection, TLS, sign-in and SELECT 1). */
export const DB_HEALTH_SLOW_MS = 2000;

/** Raw samples are kept 14 days, hourly means and extremes 400 days (8). */
export const DB_HEALTH_RAW_KEEP_DAYS = 14;
export const DB_HEALTH_HOURLY_KEEP_DAYS = 400;

/**
 * An agent gets its checks in one `db_health` task per heartbeat (9: bundled per agent): it runs
 * every connection due within this window and stops when the next task arrives. The window is a
 * little longer than the agent's heartbeat (5 minutes with jitter), so there is no gap; the
 * credentials of a task stay in the agent's memory for at most this long.
 */
export const DB_HEALTH_AGENT_WINDOW_SECONDS = 6 * 60;

/** A new `db_health` task is handed out at most this often (a busy agent beats more often). */
export const DB_HEALTH_AGENT_TASK_SPACING_MS = 4 * 60 * 1000;

/** A start time that moved by more than this is a restart (MySQL derives it from `Uptime`). */
export const DB_HEALTH_RESTART_TOLERANCE_MS = 2 * 60 * 1000;

/** The instance identity a health check found (the same keys as a connection test, 3.3). */
export function dbHealthIdentityOf(result: DbProbeResult): DbInstanceIdentity | null {
  const health = result.health;
  switch (result.engine) {
    case "postgresql":
      return health?.systemIdentifier
        ? { engine: "postgresql", systemIdentifier: health.systemIdentifier }
        : null;
    case "mysql":
      return health?.serverUuid ? { engine: "mysql", serverUuid: health.serverUuid } : null;
    case "mariadb":
      return health && health.serverId !== null && health.datadir
        ? { engine: "mariadb", serverId: health.serverId, datadir: health.datadir }
        : null;
    case "sqlite":
      return result.sqlite
        ? {
            engine: "sqlite",
            path: result.sqlite.path,
            device: result.sqlite.device,
            inode: result.sqlite.inode,
            createdAt: result.sqlite.createdAt,
          }
        : null;
    default:
      return null;
  }
}

/** What the server keeps of one check. */
export interface DbHealthJudgement {
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  serverVersion: string | null;
  startedAt: string | null;
  connectionsUsed: number | null;
  connectionsMax: number | null;
  tlsFingerprint: string | null;
  instanceKey: string | null;
  /** Database name and identity (PostgreSQL OID) with its size, when sizes were read. */
  sizes: { name: string; identity: string | null; sizeBytes: number }[] | null;
}

/** The connection as the judgement needs it. */
export interface DbHealthConnection {
  engine: DbEngine;
  instanceKey: string | null;
  tlsFingerprint: string | null;
}

/**
 * Judge one check of a stored connection: another engine, another instance or another
 * certificate under the address is a failed check with the code of a connection test (3.2,
 * 3.3); these turn the connection red until an administrator confirms after a test.
 */
export function judgeDbHealth(
  result: DbProbeResult,
  connection: DbHealthConnection,
): DbHealthJudgement {
  const identity = dbHealthIdentityOf(result);
  const health = result.health;
  const base: DbHealthJudgement = {
    ok: false,
    errorCode: result.error?.code ?? null,
    errorMessage: result.error?.message ?? null,
    latencyMs: health?.latencyMs ?? null,
    serverVersion: result.serverVersion,
    startedAt: health?.startedAt ?? null,
    connectionsUsed: health?.connectionsUsed ?? null,
    connectionsMax: health?.connectionsMax ?? null,
    tlsFingerprint: result.tls.used ? result.tls.fingerprintSha256 : null,
    instanceKey: identity ? dbInstanceKey(identity) : null,
    sizes: null,
  };
  if (result.engine !== null && result.engine !== connection.engine) {
    return {
      ...base,
      errorCode: "db_engine_changed",
      errorMessage: `Under the address answers ${result.engine}, not ${connection.engine}.`,
    };
  }
  if (base.errorCode) {
    return base;
  }
  if (compareDbInstance(connection.instanceKey, identity) === "changed") {
    return {
      ...base,
      errorCode: "db_instance_changed",
      errorMessage: "Another instance answers under the address.",
    };
  }
  if (connection.tlsFingerprint && result.engine !== "sqlite") {
    if (!result.tls.used) {
      return {
        ...base,
        errorCode: "db_tls_missing",
        errorMessage: "The server no longer offers TLS.",
      };
    }
    if (result.tls.fingerprintSha256 !== connection.tlsFingerprint) {
      return {
        ...base,
        errorCode: "db_tls_changed",
        errorMessage: "The server shows another TLS certificate than the one confirmed.",
      };
    }
  }
  let ok = false;
  switch (result.engine) {
    case "postgresql":
    case "mysql":
    case "mariadb":
      ok = result.login === "ok" && health !== undefined;
      break;
    case "sqlite":
      ok = result.sqlite !== undefined;
      break;
    case "sqlserver":
      // Until D5 signs in to SQL Server, an answer to PRELOGIN is what can be told.
      ok = result.sqlserver !== undefined;
      break;
    default:
      ok = false;
  }
  if (!ok) {
    return {
      ...base,
      errorCode: "db_probe_failed",
      errorMessage: base.errorMessage ?? "The check did not complete.",
    };
  }
  return {
    ...base,
    ok: true,
    latencyMs: base.latencyMs ?? result.durationMs,
    sizes: sizesOf(result),
  };
}

function sizesOf(result: DbProbeResult): DbHealthJudgement["sizes"] {
  if (result.engine === "sqlite" && result.sqlite) {
    const name = result.sqlite.path.split(/[\\/]/).pop() || result.sqlite.path;
    return [{ name, identity: result.sqlite.inode, sizeBytes: result.sqlite.sizeBytes }];
  }
  const engine = result.engine;
  const list = result.health?.databases;
  if (!engine || !list) {
    return null;
  }
  return list
    .filter((database) => database.sizeBytes !== null && !isDbSystemDatabase(engine, database.name))
    .map((database) => ({
      name: database.name,
      identity: engine === "postgresql" ? database.oid : null,
      sizeBytes: database.sizeBytes as number,
    }));
}

/**
 * The health of a connection as the worker keeps it (`database_connections.health`): the last
 * check, the failures in a row and the episode of `database.unreachable`.
 */
export interface DbHealthState {
  /** The newest check taken into account. */
  lastAt: string | null;
  lastOk: boolean | null;
  lastOkAt: string | null;
  consecutiveFailures: number;
  /** The first failed check of the current run of failures. */
  failingSince: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  /** When `database.unreachable` was raised for the current episode; null outside one. */
  unreachableAlertedAt: string | null;
  /** When `database.unreachable` was raised last (any episode): the cooldown counts from it. */
  lastUnreachableAlertAt?: string | null;
  /**
   * The newest sample looked at, also one that was ignored (closer to the previous than the
   * interval allows); the next evaluation starts after it. Older states have `lastAt` only.
   */
  evaluatedUntil?: string | null;
}

export const EMPTY_DB_HEALTH_STATE: DbHealthState = {
  lastAt: null,
  lastOk: null,
  lastOkAt: null,
  consecutiveFailures: 0,
  failingSince: null,
  errorCode: null,
  errorMessage: null,
  latencyMs: null,
  unreachableAlertedAt: null,
  lastUnreachableAlertAt: null,
  evaluatedUntil: null,
};

export interface DbHealthSampleInput {
  at: Date;
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
}

export type DbHealthAlert =
  | {
      kind: "unreachable";
      since: string;
      failures: number;
      errorCode: string | null;
      errorMessage: string | null;
    }
  | { kind: "reachable"; since: string; unreachableSince: string | null };

/** Where the next evaluation of a state starts: after the newest sample it looked at. */
export function dbHealthEvaluatedUntil(state: DbHealthState | null): string | null {
  return state?.evaluatedUntil ?? state?.lastAt ?? null;
}

/**
 * Take the checks after the state's last one, in order, into the state (pure). Three failures in
 * a row raise `unreachable` once per episode; the first good check after an alerted episode
 * raises `reachable`. A good check between failures starts the count again: a connection that
 * fails now and then is not unreachable.
 *
 * Against flapping and floods (DATABASES.md 8, 16):
 *   - at most one alert per call: the samples after the one that raised it stay for the next
 *     evaluation (`evaluatedUntil`), so a burst of samples cannot raise a pair at once;
 *   - a sample closer than half the interval to the last one taken is looked at and ignored;
 *   - `unreachable` waits while the last one is younger than {@link DB_HEALTH_ALERT_COOLDOWN_MS}:
 *     the episode is alerted when it still lasts after that, and `reachable` only follows an
 *     alerted episode, so a flapping connection gets at most one pair in that time.
 */
export function advanceDbHealthState(
  previous: DbHealthState | null,
  samples: readonly DbHealthSampleInput[],
  now: Date,
  options: { intervalMinutes?: number } = {},
): { state: DbHealthState; alerts: DbHealthAlert[] } {
  let state: DbHealthState = { ...EMPTY_DB_HEALTH_STATE, ...(previous ?? {}) };
  const alerts: DbHealthAlert[] = [];
  const from = dbHealthEvaluatedUntil(state);
  const after = from ? Date.parse(from) : Number.NEGATIVE_INFINITY;
  const minimumGapMs = ((options.intervalMinutes ?? 0) * 60 * 1000) / 2;
  const ordered = [...samples]
    .filter((sample) => sample.at.getTime() > after)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const sample of ordered) {
    if (alerts.length > 0) {
      break;
    }
    const at = sample.at.toISOString();
    const lastTaken = state.lastAt ? Date.parse(state.lastAt) : Number.NEGATIVE_INFINITY;
    state = { ...state, evaluatedUntil: at };
    if (sample.at.getTime() - lastTaken < minimumGapMs) {
      continue;
    }
    if (sample.ok) {
      if (state.unreachableAlertedAt) {
        alerts.push({ kind: "reachable", since: at, unreachableSince: state.failingSince });
      }
      state = {
        ...state,
        lastAt: at,
        lastOk: true,
        lastOkAt: at,
        consecutiveFailures: 0,
        failingSince: null,
        errorCode: null,
        errorMessage: null,
        latencyMs: sample.latencyMs,
        unreachableAlertedAt: null,
      };
      continue;
    }
    const failures = state.consecutiveFailures + 1;
    const failingSince = state.failingSince ?? at;
    state = {
      ...state,
      lastAt: at,
      lastOk: false,
      consecutiveFailures: failures,
      failingSince,
      errorCode: sample.errorCode,
      errorMessage: sample.errorMessage,
      latencyMs: null,
    };
    const lastAlert = state.lastUnreachableAlertAt
      ? Date.parse(state.lastUnreachableAlertAt)
      : null;
    const cooling = lastAlert !== null && now.getTime() - lastAlert < DB_HEALTH_ALERT_COOLDOWN_MS;
    if (failures >= DB_HEALTH_UNREACHABLE_AFTER && !state.unreachableAlertedAt && !cooling) {
      alerts.push({
        kind: "unreachable",
        since: failingSince,
        failures,
        errorCode: sample.errorCode,
        errorMessage: sample.errorMessage,
      });
      state = {
        ...state,
        unreachableAlertedAt: now.toISOString(),
        lastUnreachableAlertAt: now.toISOString(),
      };
    }
  }
  return { state, alerts };
}

/** How the list and the pages show a connection's health (8): a dot with its state. */
export type DbReachability = "reachable" | "slow" | "unreachable" | "unknown";

/**
 * The reachability of a connection now: unknown without a check, or when the newest is older
 * than three intervals (the executor went quiet: no news is not good news); unreachable from the
 * first failed check (the alarm waits for three); slow when the good check took long.
 */
export function dbReachabilityOf(
  state: Pick<DbHealthState, "lastAt" | "lastOk" | "latencyMs"> | null,
  intervalMinutes: number,
  now: Date,
): DbReachability {
  if (!state?.lastAt || state.lastOk === null) {
    return "unknown";
  }
  const age = now.getTime() - Date.parse(state.lastAt);
  if (age > 3 * intervalMinutes * 60 * 1000 + 2 * 60 * 1000) {
    return "unknown";
  }
  if (!state.lastOk) {
    return "unreachable";
  }
  return (state.latencyMs ?? 0) >= DB_HEALTH_SLOW_MS ? "slow" : "reachable";
}

/** When the next check of a connection is due, from its newest one (none: now). */
export function dbHealthDueAt(lastAt: Date | null, intervalMinutes: number, now: Date): Date {
  return lastAt ? new Date(lastAt.getTime() + intervalMinutes * 60 * 1000) : now;
}

/** Whether a check should read the sizes too: none read yet, or the last over an hour ago. */
export function dbHealthSizesDue(lastSizesAt: Date | null, now: Date): boolean {
  return lastSizesAt === null || now.getTime() - lastSizesAt.getTime() >= DB_HEALTH_SIZES_EVERY_MS;
}

/** One sample as the history reads it. */
export interface DbHealthHistorySample {
  at: Date;
  checks: number;
  okChecks: number;
  errorCode: string | null;
  serverVersion: string | null;
  startedAt: Date | null;
  tlsFingerprint: string | null;
}

export type DbHealthEvent =
  | { kind: "unreachable"; from: string; to: string | null; errorCode: string | null }
  | { kind: "restart"; at: string; startedAt: string }
  | { kind: "version"; at: string; from: string; to: string }
  | { kind: "tls"; at: string };

/**
 * The events of the history (8): not reachable from/until, a restart (another start time), a
 * version change, another certificate. Samples in time order; an hourly sample with failures
 * counts as failed when no check of the hour was good.
 */
export function dbHealthEvents(samples: readonly DbHealthHistorySample[]): DbHealthEvent[] {
  const events: DbHealthEvent[] = [];
  let open: { from: string; errorCode: string | null } | null = null;
  let version: string | null = null;
  let started: number | null = null;
  let tls: string | null = null;
  for (const sample of samples) {
    const at = sample.at.toISOString();
    const failed = sample.okChecks === 0 && sample.checks > 0;
    if (failed) {
      open ??= { from: at, errorCode: sample.errorCode };
      continue;
    }
    if (open) {
      events.push({ kind: "unreachable", from: open.from, to: at, errorCode: open.errorCode });
      open = null;
    }
    if (sample.serverVersion) {
      if (version && sample.serverVersion !== version) {
        events.push({ kind: "version", at, from: version, to: sample.serverVersion });
      }
      version = sample.serverVersion;
    }
    if (sample.startedAt) {
      const time = sample.startedAt.getTime();
      if (started !== null && Math.abs(time - started) > DB_HEALTH_RESTART_TOLERANCE_MS) {
        events.push({ kind: "restart", at, startedAt: sample.startedAt.toISOString() });
      }
      started = time;
    }
    if (sample.tlsFingerprint) {
      if (tls && sample.tlsFingerprint !== tls) {
        events.push({ kind: "tls", at });
      }
      tls = sample.tlsFingerprint;
    }
  }
  if (open) {
    events.push({ kind: "unreachable", from: open.from, to: null, errorCode: open.errorCode });
  }
  return events;
}
