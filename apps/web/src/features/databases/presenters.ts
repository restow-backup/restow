import type { StatusTone } from "@/components/kit";

import { formatInteger } from "@/lib/format";

import type {
  DbBandHour,
  DbBandState,
  DbCapabilityState,
  DbConnection,
  DbEngine,
  DbRating,
  DbReachability,
} from "./api.js";

/**
 * How the database pages show states (docs/DATABASES.md 2.4, 3.2). Green is proof of a passed
 * restore check (apps/web green-is-proof.test.ts): in this stage nothing is checked yet, so no
 * state here is green. A right that is granted, a connection that signs in and a database that
 * answers are the neutral outline; what is missing is a warning; red is red.
 */

export const ENGINE_LABEL: Readonly<Record<DbEngine, string>> = {
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  sqlserver: "SQL Server",
  sqlite: "SQLite",
};

export function ratingView(rating: DbRating): { tone: StatusTone; key: string } {
  switch (rating) {
    case "red":
      return { tone: "destructive", key: "rating.red" };
    case "overdue":
      return { tone: "warning", key: "rating.overdue" };
    case "unverified":
      return { tone: "info", key: "rating.unverified" };
    case "not_protected":
      return { tone: "muted", key: "rating.notProtected" };
    case "green":
      // Shown with the tone of a passed restore check once checks exist (D6); until then neutral.
      return { tone: "neutral", key: "rating.green" };
  }
}

/**
 * Reachability from the health checks (8), beside the rating: answering is no proof, so a
 * reachable connection is the neutral outline, a slow one a warning, an unreachable one red.
 */
export function reachabilityView(reachability: DbReachability): { tone: StatusTone; key: string } {
  switch (reachability) {
    case "reachable":
      return { tone: "neutral", key: "reachability.reachable" };
    case "slow":
      return { tone: "warning", key: "reachability.slow" };
    case "unreachable":
      return { tone: "destructive", key: "reachability.unreachable" };
    case "unknown":
      return { tone: "muted", key: "reachability.unknown" };
  }
}

/**
 * The colours of the band of the last 24 hours (8): chart tokens, never green (a connection that
 * answers proves nothing about its backups). Each hour also has its name in the band's title.
 */
export const BAND_COLOR: Readonly<Record<DbBandState, string>> = {
  ok: "var(--chart-info)",
  slow: "var(--chart-warning)",
  mixed: "var(--chart-warning)",
  down: "var(--chart-destructive)",
  none: "var(--chart-muted)",
};

/** Hours reachable (good or slow), with outages, and without a check, for the band's sentence. */
export function bandCounts(band: readonly DbBandHour[]): {
  ok: number;
  problem: number;
  none: number;
} {
  let ok = 0;
  let problem = 0;
  let none = 0;
  for (const hour of band) {
    if (hour.state === "ok" || hour.state === "slow") ok++;
    else if (hour.state === "none") none++;
    else problem++;
  }
  return { ok, problem, none };
}

/** The periods of the health history. */
export const HEALTH_RANGES = { day: 1, week: 7, month: 30 } as const;
export type HealthRange = keyof typeof HEALTH_RANGES;

/** The health check intervals an administrator picks from (1 to 60 minutes). */
export const HEALTH_INTERVAL_CHOICES = [1, 2, 5, 10, 15, 30, 60] as const;

/** A response time: milliseconds below a second, seconds above. */
export function formatLatency(ms: number | null, language: string): string {
  if (ms === null || !Number.isFinite(ms)) {
    return "–";
  }
  return ms < 1000
    ? `${formatInteger(Math.round(ms), language)} ms`
    : `${(ms / 1000).toLocaleString(language, { maximumFractionDigits: 1 })} s`;
}

/** Round ticks from 0 to just above `max` (about four intervals). */
export function countTicks(max: number, target = 4): number[] {
  if (!(max > 0)) {
    return [0, 1];
  }
  const raw = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const factor = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= raw) ?? 10;
  const step = Math.max(1, factor * magnitude);
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, index) => index * step);
}

export function capabilityView(state: DbCapabilityState): { tone: StatusTone; key: string } {
  switch (state) {
    case "granted":
      return { tone: "neutral", key: "rights.state.granted" };
    case "partial":
      return { tone: "warning", key: "rights.state.partial" };
    case "missing":
      return { tone: "warning", key: "rights.state.missing" };
    case "unknown":
      return { tone: "muted", key: "rights.state.unknown" };
    case "not_applicable":
      return { tone: "muted", key: "rights.state.notApplicable" };
  }
}

export function connectionStateView(state: DbConnection["state"]): {
  tone: StatusTone;
  key: string;
} {
  switch (state) {
    case "red":
      return { tone: "destructive", key: "connection.state.red" };
    case "attention":
      return { tone: "warning", key: "connection.state.attention" };
    case "unchecked":
      return { tone: "muted", key: "connection.state.unchecked" };
    case "ok":
      return { tone: "neutral", key: "connection.state.ok" };
  }
}

/** The i18n key of an error or notice code (`db_tls_changed` -> `codes.db_tls_changed`). */
export function codeKey(code: string): string {
  return `codes.${code}`;
}

/** Minutes as the schedule field shows them. */
export const INTERVAL_CHOICES = [15, 30, 60, 120, 240, 360, 720, 1440] as const;
