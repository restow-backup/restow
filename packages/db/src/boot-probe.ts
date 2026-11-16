/**
 * What the database knows of the boot probes of a machine (docs/BAREMETAL.md 12.3, 12.4): the
 * `boot_probe` reports for one pair of fingerprints and the probe that is planned or runs. The API
 * rates a machine from these, the worker plans with them (@restow/core `bootProbeDue`,
 * `probeRating`). A report without a rating (`readiness` yellow or null) proved nothing; one with
 * `summary.notPossible` says why no probe can run for these fingerprints.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema/index.js";
import { type RecoveryLabState, settings } from "./schema/system.js";

type Executor = Pick<NodePgDatabase<Record<string, unknown>>, "execute">;

/** One boot probe report as the rating reads it. */
export interface BootProbeReportRow {
  id: string;
  readiness: "green" | "red" | null;
  layoutFingerprint: string | null;
  bootChainFingerprint: string | null;
  notPossible: string | null;
  checkedAt: Date;
}

/** The boot probe reports of a machine for these fingerprints, newest first. */
export async function bootProbeReports(
  executor: Executor,
  endpointId: string,
  fingerprints: { layoutFingerprint: string; bootChainFingerprint: string },
  limit = 20,
): Promise<BootProbeReportRow[]> {
  const result = await executor.execute<{
    id: string;
    readiness: string | null;
    layout_fingerprint: string | null;
    boot_chain_fingerprint: string | null;
    not_possible: string | null;
    checked_at: Date | string;
  }>(
    sql`SELECT id, readiness, summary->>'layoutFingerprint' AS layout_fingerprint,
               summary->>'bootChainFingerprint' AS boot_chain_fingerprint,
               summary->>'notPossible' AS not_possible, checked_at
          FROM endpoint_reports
         WHERE endpoint_id = ${endpointId} AND kind = 'boot_probe'
           AND summary->>'layoutFingerprint' = ${fingerprints.layoutFingerprint}
           AND summary->>'bootChainFingerprint' = ${fingerprints.bootChainFingerprint}
         ORDER BY checked_at DESC LIMIT ${limit}`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    readiness: row.readiness === "green" || row.readiness === "red" ? row.readiness : null,
    layoutFingerprint: row.layout_fingerprint,
    bootChainFingerprint: row.boot_chain_fingerprint,
    notPossible: row.not_possible,
    checkedAt: row.checked_at instanceof Date ? row.checked_at : new Date(row.checked_at),
  }));
}

/** States of a probe's recovery row that count as planned or running. */
export const OPEN_PROBE_STATES = ["issued", "pending_approval", "active", "finishing"] as const;

/**
 * The open probe of a machine at `now`: `planned` until the lab leased it (no code yet),
 * `running` after; null when none is open.
 */
export async function pendingBootProbe(
  executor: Executor,
  endpointId: string,
  now: Date,
): Promise<{ id: string; state: "planned" | "running" } | null> {
  const result = await executor.execute<{ id: string; code_hash: string | null }>(
    sql`SELECT id, code_hash FROM endpoint_recoveries
         WHERE endpoint_id = ${endpointId} AND kind = 'probe'
           AND status IN ('issued', 'pending_approval', 'active', 'finishing')
           AND expires_at > ${now.toISOString()}::timestamptz
         ORDER BY issued_at DESC LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, state: row.code_hash === null ? "planned" : "running" };
}

/** The recovery lab as the worker last saw it (installation pool; the tenant role cannot read it). */
export async function loadRecoveryLab(
  db: Pick<NodePgDatabase<typeof schema>, "select">,
): Promise<RecoveryLabState | null> {
  const [row] = await db.select({ lab: settings.recoveryLab }).from(settings).limit(1);
  return row?.lab ?? null;
}
