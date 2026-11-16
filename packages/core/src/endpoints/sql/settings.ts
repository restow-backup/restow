/**
 * The SQL Server settings of a backup job and a machine (W2a, docs/BAREMETAL-WINDOWS.md 5.1.3):
 * off by default; a job offers them once a machine reports an instance. W2a knows the mode
 * `alongside` only (copy-only fulls beside the customer's own backups; no log chain). The agent
 * gets them without `verify`, which only the server plans (agentFacingConfig).
 */

export const SQL_MODES = ["alongside"] as const;
export type SqlMode = (typeof SQL_MODES)[number];

export interface SqlDatabaseRef {
  instance?: string;
  name: string;
}

export interface SqlVerifySettings {
  enabled: boolean;
  /** 1 = Monday ... 7 = Sunday, in the zone of the job's schedule. */
  weekday: number;
  /** Local `HH:MM`. */
  time: string;
  /** Above this many GiB of used pages CHECKDB runs with PHYSICAL_ONLY. */
  maxGiB: number;
  physicalOnly: boolean;
}

export interface SqlSettings {
  enabled: boolean;
  mode: SqlMode;
  instances: "all" | string[];
  databases: "all" | SqlDatabaseRef[];
  exclude: SqlDatabaseRef[];
  stagingDir?: string;
  verify?: SqlVerifySettings;
}

/** The settings as the agent gets them (`GET /agent/v1/config`, field `sql`). */
export type AgentSqlConfig = Omit<SqlSettings, "verify">;

/** Sunday 03:00 in the job's zone, CHECKDB in full up to 200 GiB. */
export const DEFAULT_SQL_VERIFY: Readonly<SqlVerifySettings> = {
  enabled: true,
  weekday: 7,
  time: "03:00",
  maxGiB: 200,
  physicalOnly: false,
};

/** At least this many minutes between the check slot and the daily backup (W2a has no lock classes). */
export const SQL_VERIFY_MIN_GAP_MINUTES = 60;

export const MAX_SQL_VERIFY_GIB = 100_000;

export function defaultSqlSettings(): SqlSettings {
  return {
    enabled: false,
    mode: "alongside",
    instances: "all",
    databases: "all",
    exclude: [],
    verify: { ...DEFAULT_SQL_VERIFY },
  };
}

export function agentSqlConfig(settings: SqlSettings): AgentSqlConfig {
  const { verify: _server, ...rest } = settings;
  return rest;
}

/** The check settings that apply: the stored ones, else the defaults. */
export function sqlVerifyOf(settings: SqlSettings | null | undefined): SqlVerifySettings {
  return { ...DEFAULT_SQL_VERIFY, ...(settings?.verify ?? {}) };
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function sqlInstanceSelected(settings: SqlSettings, instance: string): boolean {
  return (
    settings.instances === "all" || settings.instances.some((name) => sameName(name, instance))
  );
}

function matches(ref: SqlDatabaseRef, instance: string, database: string): boolean {
  return (
    sameName(ref.name, database) && (ref.instance === undefined || sameName(ref.instance, instance))
  );
}

/** Whether the native backup takes a database (tempdb never). */
export function sqlDatabaseSelected(
  settings: SqlSettings,
  instance: string,
  database: string,
): boolean {
  if (
    !settings.enabled ||
    !sqlInstanceSelected(settings, instance) ||
    sameName(database, "tempdb")
  ) {
    return false;
  }
  if (settings.exclude.some((ref) => matches(ref, instance, database))) {
    return false;
  }
  return (
    settings.databases === "all" ||
    settings.databases.some((ref) => matches(ref, instance, database))
  );
}

/** Whether the native backup takes every database of every instance. */
export function sqlCoversEverything(settings: SqlSettings | null | undefined): boolean {
  return (
    settings?.enabled === true &&
    settings.instances === "all" &&
    settings.databases === "all" &&
    settings.exclude.length === 0
  );
}

function minutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Whether the check slot lies too close to a daily backup (W2a, decision C21): the agent runs one
 * job at a time, so a long check would hold the backup up. Both are times of day; the distance is
 * taken around midnight. A schedule that is not daily has no fixed time and is not checked.
 */
export function sqlVerifySlotTooClose(verifyTime: string, dailyBackupTime: string | null): boolean {
  if (dailyBackupTime === null) {
    return false;
  }
  const a = minutes(verifyTime);
  const b = minutes(dailyBackupTime);
  if (a === null || b === null) {
    return false;
  }
  const distance = Math.abs(a - b);
  return Math.min(distance, 24 * 60 - distance) < SQL_VERIFY_MIN_GAP_MINUTES;
}
