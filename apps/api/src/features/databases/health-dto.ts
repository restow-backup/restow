import {
  DB_HEALTH_SLOW_MS,
  type DbHealthState,
  type DbReachability,
  dbReachabilityOf,
} from "@restow/core";
import { type DatabaseConnection, databaseHealthSamples } from "@restow/db";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Transaction } from "../../lib/tenant-context.js";

/**
 * How the pages see the health of a connection (docs/DATABASES.md 8): the state the worker keeps
 * (`database_connections.health`) as a DTO, and the band of the last 24 hours the list shows
 * beside each database. Pure reads; the worker judges and alerts.
 */

export interface DatabaseHealthDto {
  intervalMinutes: number;
  /** reachable, slow, unreachable, or unknown (no check yet, or the checks went quiet). */
  reachability: DbReachability;
  lastAt: string | null;
  lastOkAt: string | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  failingSince: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** `database.unreachable` was raised for the current episode. */
  alerted: boolean;
}

export function healthDto(connection: DatabaseConnection, now: Date): DatabaseHealthDto {
  const state: DbHealthState | null = connection.health ?? null;
  return {
    intervalMinutes: connection.healthIntervalMinutes,
    reachability: connection.enabled
      ? dbReachabilityOf(state, connection.healthIntervalMinutes, now)
      : "unknown",
    lastAt: state?.lastAt ?? null,
    lastOkAt: state?.lastOkAt ?? null,
    latencyMs: state?.latencyMs ?? null,
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    failingSince: state?.failingSince ?? null,
    errorCode: state?.lastOk === false ? (state.errorCode ?? null) : null,
    errorMessage: state?.lastOk === false ? (state.errorMessage ?? null) : null,
    alerted: Boolean(state?.unreachableAlertedAt),
  };
}

/** One hour of the band: every check good, one slow, all failed, some failed, or none. */
export type HealthBandState = "ok" | "slow" | "down" | "mixed" | "none";

export interface HealthBandHour {
  /** The start of the hour (UTC). */
  at: string;
  state: HealthBandState;
  checks: number;
  okChecks: number;
}

const HOUR_MS = 60 * 60 * 1000;

/** The 24 hours before `now`, oldest first, for each connection (8: "Verlauf der letzten 24 Stunden"). */
export async function healthBands(
  tx: Transaction,
  tenantId: string,
  connectionIds: string[],
  now: Date,
): Promise<Map<string, HealthBandHour[]>> {
  const bands = new Map<string, HealthBandHour[]>();
  if (connectionIds.length === 0) {
    return bands;
  }
  const end = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS;
  const start = end - 24 * HOUR_MS;
  const rows = await tx
    .select({
      connectionId: databaseHealthSamples.connectionId,
      hour: sql<string>`to_char(date_trunc('hour', ${databaseHealthSamples.at} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:00:00.000"Z"')`,
      checks: sql<number>`sum(${databaseHealthSamples.checks})::int`,
      okChecks: sql<number>`sum(${databaseHealthSamples.okChecks})::int`,
      slowest: sql<number | null>`max(${databaseHealthSamples.latencyMaxMs})`,
    })
    .from(databaseHealthSamples)
    .where(
      and(
        eq(databaseHealthSamples.tenantId, tenantId),
        inArray(databaseHealthSamples.connectionId, connectionIds),
        gt(databaseHealthSamples.at, new Date(start)),
      ),
    )
    .groupBy(databaseHealthSamples.connectionId, sql`2`);
  const byKey = new Map(rows.map((row) => [`${row.connectionId}|${row.hour}`, row]));
  for (const id of connectionIds) {
    const hours: HealthBandHour[] = [];
    for (let at = start; at < end; at += HOUR_MS) {
      const iso = new Date(at).toISOString();
      const row = byKey.get(`${id}|${iso}`);
      const checks = Number(row?.checks ?? 0);
      const okChecks = Number(row?.okChecks ?? 0);
      const state: HealthBandState =
        checks === 0
          ? "none"
          : okChecks === 0
            ? "down"
            : okChecks < checks
              ? "mixed"
              : (row?.slowest ?? 0) >= DB_HEALTH_SLOW_MS
                ? "slow"
                : "ok";
      hours.push({ at: iso, state, checks, okChecks });
    }
    bands.set(id, hours);
  }
  return bands;
}
