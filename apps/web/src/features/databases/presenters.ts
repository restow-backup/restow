import type { StatusTone } from "@/components/kit";

import type { DbCapabilityState, DbConnection, DbEngine, DbRating } from "./api.js";

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

export function reachabilityView(reachable: boolean | null): { tone: StatusTone; key: string } {
  if (reachable === null) {
    return { tone: "muted", key: "reachability.unknown" };
  }
  return reachable
    ? { tone: "neutral", key: "reachability.reachable" }
    : { tone: "destructive", key: "reachability.unreachable" };
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
