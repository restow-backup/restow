/**
 * The ransomware judgement of new restore points (docs/RANSOMWARE.md): a pass every two
 * minutes, in one worker at a time (a session advisory lock), across all tenants.
 *
 * Every finished backup run of a machine, file share, Proxmox VE guest, mailbox, OneDrive or
 * IMAP account from the last three days that has no judgement yet is judged once, oldest first,
 * by @restow/core `evaluateSuspicion`: its numbers against the object's own baseline (the
 * metrics of its earlier backup runs, those still suspicious left out, a false alarm counted as
 * clean) and the name and entropy signatures. The run tables are the history, so an object that
 * was backed up before the detection existed has its baseline from the first pass on.
 *
 * The result is stored in `restore_point_suspicions`. A suspicious restore point that opens an
 * episode (the object's previous judged restore point was clean, a false alarm, or there was
 * none) raises `backup.suspicious` in the same transaction: bell, rules, e-mail and webhooks.
 * The ones that follow it in the same episode are marked, not announced again.
 *
 * Nothing is judged while the installation switched the detection off; runs from that time are
 * not judged later either (only the last three days are looked at).
 *
 * A suspicious restore point holds the object's retention until an administrator resolves it
 * (./holds.ts). The alert says so; a hold still open after `retentionHold.reminderDays` (14) is
 * announced again (`backup.suspicious_hold`), and every that many days after, whether or not the
 * detection is on.
 */
import {
  evaluateSuspicion,
  opensSuspicionEpisode,
  type RansomwareSettings,
  type RunMetrics,
  resolveRansomwareSettings,
  type SuspicionFinding,
  type SuspicionObjectKind,
} from "@restow/core";
import {
  type Database,
  endpoints,
  fileShares,
  protectedObjects,
  pveGuests,
  restorePointSuspicions,
  SUSPICION_HOLDS_SQL,
  settings as settingsTable,
  suspicionHolds,
} from "@restow/db";
import { and, desc, eq, lt, type SQL, sql } from "drizzle-orm";
import { endpointName } from "../endpoints/monitor.js";
import { type WorkerRuntime, withTenantTx } from "../handlers/framework.js";
import type { TenantTx } from "../progress.js";
import { raiseEvents } from "../reporting.js";
import {
  endpointRunMetrics,
  fileShareRunMetrics,
  m365RunMetrics,
  pveRunMetrics,
} from "./metrics.js";

const HOUR_MS = 60 * 60 * 1000;
/** Runs older than this are not judged any more (an outage or an upgrade must not flood). */
export const SUSPICION_WINDOW_MS = 72 * HOUR_MS;
/** How many runs one pass judges per kind at most; the next pass takes the rest. */
const BATCH = 200;
/** Earlier runs read for a baseline beyond the ones it keeps (some may be suspicious). */
const HISTORY_SLACK = 20;
export const SUSPICION_PASS_INTERVAL_MS = 2 * 60 * 1000;
const LOCK_KEY = 0x72737031; // "rsp1"

export interface SuspicionDeps {
  /** The application role (Row Level Security). */
  readonly db: Database;
  /** The installation role, for the scans across tenants and the installation's settings. */
  readonly providerDb: Database;
  readonly runtime: Pick<WorkerRuntime, "logger" | "now" | "shutdownSignal">;
}

/** One backup run as the pass reads it, whichever table it comes from. */
interface RunRow extends Record<string, unknown> {
  tenant_id: string;
  object_id: string;
  run_id: string;
  restore_point_id: string;
  at: Date | string;
  data: unknown;
  extra: string | null;
  verdict: string | null;
  false_alarm_at: Date | string | null;
}

/** Where each kind's backup runs live, as SQL fragments over the alias `r`. */
interface KindSource {
  kind: SuspicionObjectKind;
  columns: SQL;
  from: SQL;
  eligible: SQL;
  object: SQL;
  time: SQL;
  run: SQL;
  metrics: (row: RunRow) => RunMetrics;
}

const SOURCES: readonly KindSource[] = [
  {
    kind: "endpoint",
    columns: sql`r.tenant_id, r.endpoint_id AS object_id, r.id AS run_id, r.snapshot_id AS restore_point_id, r.finished_at AS at, r.stats AS data, NULL::text AS extra`,
    from: sql`endpoint_runs r`,
    eligible: sql`r.kind = 'backup' AND r.status IN ('succeeded', 'partial') AND r.snapshot_id IS NOT NULL AND r.finished_at IS NOT NULL`,
    object: sql`r.endpoint_id`,
    time: sql`r.finished_at`,
    run: sql`r.id`,
    metrics: (row) => endpointRunMetrics(row.data),
  },
  {
    kind: "file_share",
    columns: sql`r.tenant_id, r.file_share_id AS object_id, r.id AS run_id, r.snapshot_id::text AS restore_point_id, r.finished_at AS at, r.stats AS data, NULL::text AS extra`,
    from: sql`file_share_runs r`,
    eligible: sql`r.kind = 'backup' AND r.status IN ('succeeded', 'warning') AND r.snapshot_id IS NOT NULL AND r.finished_at IS NOT NULL`,
    object: sql`r.file_share_id`,
    time: sql`r.finished_at`,
    run: sql`r.id`,
    metrics: (row) => fileShareRunMetrics(row.data),
  },
  {
    kind: "pve_guest",
    columns: sql`r.tenant_id, r.guest_id AS object_id, r.id AS run_id, r.snapshot_id::text AS restore_point_id, r.finished_at AS at, r.stats AS data, g.kind AS extra`,
    from: sql`pve_runs r JOIN pve_guests g ON g.id = r.guest_id`,
    eligible: sql`r.kind = 'backup' AND r.status = 'succeeded' AND r.snapshot_id IS NOT NULL AND r.finished_at IS NOT NULL`,
    object: sql`r.guest_id`,
    time: sql`r.finished_at`,
    run: sql`r.id`,
    metrics: (row) => pveRunMetrics(row.extra ?? "", row.data),
  },
  {
    kind: "m365",
    columns: sql`r.tenant_id, r.protected_object_id AS object_id, r.id AS run_id, r.payload->'result'->>'snapshotId' AS restore_point_id, r.completed_at AS at, r.payload->'result' AS data, NULL::text AS extra`,
    from: sql`jobs r`,
    eligible: sql`r.queue = 'backup' AND r.status = 'completed' AND r.protected_object_id IS NOT NULL AND r.completed_at IS NOT NULL AND (r.payload->'result'->>'snapshotId') IS NOT NULL`,
    object: sql`r.protected_object_id`,
    time: sql`r.completed_at`,
    run: sql`r.id`,
    metrics: (row) => m365RunMetrics(row.data),
  },
];

function select(source: KindSource, where: SQL, order: SQL, limit: number): SQL {
  return sql`SELECT ${source.columns}, s.verdict, s.false_alarm_at
    FROM ${source.from}
    LEFT JOIN restore_point_suspicions s ON s.object_kind = ${source.kind} AND s.run_id = ${source.run}
    WHERE ${source.eligible} AND ${where}
    ORDER BY ${order}
    LIMIT ${limit}`;
}

function dateOf(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * The objects of `kind` among `objectIds` with a finished backup since `since` that has no
 * judgement yet: their newest restore points may be suspicious, and the pass decides within
 * minutes. Retention waits for it (./holds.ts).
 */
export async function unjudgedObjects(
  tx: Pick<Database, "execute">,
  tenantId: string,
  kind: SuspicionObjectKind,
  objectIds: readonly string[],
  since: Date,
): Promise<Set<string>> {
  const source = SOURCES.find((candidate) => candidate.kind === kind);
  if (!source || objectIds.length === 0) {
    return new Set();
  }
  const result = await tx.execute<{ object_id: string }>(sql`
    SELECT DISTINCT ${source.object} AS object_id
    FROM ${source.from}
    LEFT JOIN restore_point_suspicions s ON s.object_kind = ${source.kind} AND s.run_id = ${source.run}
    WHERE ${source.eligible} AND r.tenant_id = ${tenantId}::uuid
      AND ${source.object} IN (${sql.join(
        objectIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      AND ${source.time} >= ${since} AND s.id IS NULL
  `);
  return new Set(result.rows.map((row) => row.object_id));
}

/** The runs of the last {@link SUSPICION_WINDOW_MS} that were not judged yet, oldest first. */
async function candidatesOf(db: Database, source: KindSource, since: Date): Promise<RunRow[]> {
  const result = await db.execute<RunRow>(
    select(
      source,
      sql`${source.time} >= ${since} AND s.id IS NULL`,
      sql`${source.time} ASC`,
      BATCH,
    ),
  );
  return result.rows;
}

/**
 * The metrics of the object's earlier runs that count for its baseline, newest first: every
 * run but those judged suspicious and not called a false alarm.
 */
async function baselineOf(
  tx: TenantTx,
  source: KindSource,
  row: RunRow,
  settings: RansomwareSettings,
): Promise<RunMetrics[]> {
  const result = await tx.execute<RunRow>(
    select(
      source,
      sql`${source.object} = ${row.object_id} AND ${source.time} < ${dateOf(row.at)}`,
      sql`${source.time} DESC`,
      settings.baselineRuns + HISTORY_SLACK,
    ),
  );
  return result.rows
    .filter((earlier) => !(earlier.verdict === "suspicious" && earlier.false_alarm_at === null))
    .slice(0, settings.baselineRuns)
    .map(source.metrics);
}

/** The name the bell and the mails use, and the detail that says which object it is. */
async function describeObject(
  tx: TenantTx,
  kind: SuspicionObjectKind,
  objectId: string,
): Promise<{ name: string; ref: Record<string, string>; exists: boolean }> {
  switch (kind) {
    case "endpoint": {
      const [row] = await tx
        .select({ displayName: endpoints.displayName, hostname: endpoints.hostname })
        .from(endpoints)
        .where(eq(endpoints.id, objectId));
      return {
        name: row ? endpointName(row) : objectId,
        ref: { endpointId: objectId },
        exists: Boolean(row),
      };
    }
    case "file_share": {
      const [row] = await tx
        .select({ name: fileShares.name })
        .from(fileShares)
        .where(eq(fileShares.id, objectId));
      return { name: row?.name ?? objectId, ref: { fileShareId: objectId }, exists: Boolean(row) };
    }
    case "pve_guest": {
      const [row] = await tx
        .select({ name: pveGuests.name, vmid: pveGuests.vmid, kind: pveGuests.kind })
        .from(pveGuests)
        .where(eq(pveGuests.id, objectId));
      const name = row ? (row.name ?? `${row.kind === "ct" ? "CT" : "VM"} ${row.vmid}`) : objectId;
      return { name, ref: { pveGuestId: objectId }, exists: Boolean(row) };
    }
    case "m365": {
      const [row] = await tx
        .select({ name: protectedObjects.displayName, externalId: protectedObjects.externalId })
        .from(protectedObjects)
        .where(eq(protectedObjects.id, objectId));
      return {
        name: row?.name ?? row?.externalId ?? objectId,
        ref: { protectedObjectId: objectId },
        exists: Boolean(row),
      };
    }
  }
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10} %`;
}

/** One finding in English, for the notification's message and the log. */
export function describeFinding(finding: SuspicionFinding): string {
  const examples = finding.examples?.length ? ` (${finding.examples.slice(0, 3).join(", ")})` : "";
  const share = finding.share !== undefined ? `, ${Math.round(finding.share * 1000) / 10} %` : "";
  switch (finding.code) {
    case "change_rate_items":
      return `${finding.value} new or changed files, usually about ${finding.baseline ?? 0}`;
    case "change_rate_bytes":
      return `${finding.value} bytes added, usually about ${finding.baseline ?? 0}`;
    case "mass_deletions":
      return `${finding.value} files deleted${share}`;
    case "mass_renames":
      return `${finding.value} files renamed to another extension${share}${examples}`;
    case "known_extensions":
      return `${finding.value} files with a known ransomware extension${examples}`;
    case "ransom_notes":
      return `${finding.value} files named like a ransom note${examples}`;
    case "high_entropy":
      return `${finding.value} sampled files look encrypted${examples}`;
    case "incompressible_data":
      return `${finding.bytes ?? 0} bytes of new data do not compress (${percent(finding.value)} of their size), usually ${percent(finding.baseline ?? 0)}`;
    case "dedup_collapse":
      return `${percent(finding.value)} of the data read was new (nothing deduplicated), usually ${percent(finding.baseline ?? 0)}`;
  }
}

export interface SuspicionPassSummary {
  judged: number;
  suspicious: number;
  alerts: number;
  /** Unresolved retention holds announced again (`backup.suspicious_hold`). */
  reminders: number;
}

const DAY_MS = 24 * HOUR_MS;
/** Holds one pass announces again at most; the next pass takes the rest. */
const REMINDER_BATCH = 200;

/**
 * Announce every retention hold that is unresolved for `retentionHold.reminderDays` again, and
 * every that many days after (`backup.suspicious_hold`): a hold must never go on silently.
 */
export async function remindRetentionHolds(
  deps: SuspicionDeps,
  settings: RansomwareSettings,
  now: Date,
): Promise<number> {
  if (!settings.retentionHold.enabled) {
    return 0;
  }
  const days = settings.retentionHold.reminderDays;
  const dueBefore = new Date(now.getTime() - days * DAY_MS);
  const due = await deps.providerDb.execute<{
    tenant_id: string;
    object_kind: SuspicionObjectKind;
    object_id: string;
  }>(sql`
    SELECT tenant_id, object_kind, object_id
    FROM restore_point_suspicions
    WHERE ${SUSPICION_HOLDS_SQL}
    GROUP BY tenant_id, object_kind, object_id
    HAVING min(created_at) <= ${dueBefore}
      AND (max(hold_reminded_at) IS NULL OR max(hold_reminded_at) <= ${dueBefore})
    LIMIT ${REMINDER_BATCH}
  `);
  let reminded = 0;
  for (const row of due.rows) {
    if (deps.runtime.shutdownSignal.aborted) {
      break;
    }
    const sent = await withTenantTx(deps.db, row.tenant_id, async (tx) => {
      const hold = (
        await suspicionHolds(tx, {
          tenantId: row.tenant_id,
          kind: row.object_kind,
          objectIds: [row.object_id],
        })
      ).get(row.object_id);
      // Resolved or reminded by another pass meanwhile.
      if (
        !hold ||
        hold.heldAt > dueBefore ||
        (hold.remindedAt !== null && hold.remindedAt > dueBefore)
      ) {
        return false;
      }
      const object = await describeObject(tx, row.object_kind, row.object_id);
      const remindedNow = () =>
        tx
          .update(restorePointSuspicions)
          .set({ holdRemindedAt: now })
          .where(
            and(
              eq(restorePointSuspicions.tenantId, row.tenant_id),
              eq(restorePointSuspicions.objectKind, row.object_kind),
              eq(restorePointSuspicions.objectId, row.object_id),
              SUSPICION_HOLDS_SQL,
            ),
          );
      if (!object.exists) {
        // The object was deleted with its backups: nothing is held any more, nobody to remind.
        await remindedNow();
        return false;
      }
      const heldDays = Math.floor((now.getTime() - hold.heldAt.getTime()) / DAY_MS);
      await raiseEvents(
        tx,
        [
          {
            tenantId: row.tenant_id,
            level: "warning",
            event: "backup.suspicious_hold",
            message: `Retention of ${object.name} has been paused for ${heldDays} days: ${hold.restorePoints} suspicious restore point(s) since ${hold.since.toISOString()} are not resolved. No restore point of it is deleted and its storage keeps growing. Check the system, then mark the finding as a false alarm or release the hold.`,
            details: {
              ...object.ref,
              objectKind: row.object_kind,
              objectId: row.object_id,
              objectName: object.name,
              heldSince: hold.since.toISOString(),
              heldAt: hold.heldAt.toISOString(),
              heldDays,
              restorePoints: hold.restorePoints,
            },
          },
        ],
        now,
      );
      await remindedNow();
      return true;
    });
    if (sent) {
      reminded++;
    }
  }
  return reminded;
}

/** Judge one run, unless another pass was first; raise the alert when it opens an episode. */
async function judge(
  deps: SuspicionDeps,
  source: KindSource,
  row: RunRow,
  settings: RansomwareSettings,
  now: Date,
  summary: SuspicionPassSummary,
): Promise<void> {
  await withTenantTx(deps.db, row.tenant_id, async (tx) => {
    const at = dateOf(row.at);
    const history = await baselineOf(tx, source, row, settings);
    const current = source.metrics(row);
    const result = evaluateSuspicion({ current, history, settings });
    const [previous] = await tx
      .select({
        verdict: restorePointSuspicions.verdict,
        falseAlarmAt: restorePointSuspicions.falseAlarmAt,
        holdReleasedAt: restorePointSuspicions.holdReleasedAt,
      })
      .from(restorePointSuspicions)
      .where(
        and(
          eq(restorePointSuspicions.tenantId, row.tenant_id),
          eq(restorePointSuspicions.objectKind, source.kind),
          eq(restorePointSuspicions.objectId, row.object_id),
          lt(restorePointSuspicions.restorePointAt, at),
        ),
      )
      .orderBy(desc(restorePointSuspicions.restorePointAt))
      .limit(1);
    const [inserted] = await tx
      .insert(restorePointSuspicions)
      .values({
        tenantId: row.tenant_id,
        objectKind: source.kind,
        objectId: row.object_id,
        runId: row.run_id,
        restorePointId: row.restore_point_id,
        restorePointAt: at,
        verdict: result.verdict,
        findings: result.findings,
        signals: result.signals,
        metrics: {
          itemsChanged: current.itemsChanged,
          itemsTotal: current.itemsTotal,
          bytesAdded: current.bytesAdded,
          newBytes: current.newBytes ?? null,
          compressionRatio: current.compressionRatio ?? null,
          dedupRatio: current.dedupRatio ?? null,
        },
        signaturesVersion: result.signaturesVersion,
      })
      .onConflictDoNothing()
      .returning({ id: restorePointSuspicions.id });
    if (!inserted) {
      return;
    }
    summary.judged++;
    if (result.verdict !== "suspicious") {
      return;
    }
    summary.suspicious++;
    const opens = opensSuspicionEpisode(
      result.verdict,
      previous
        ? {
            verdict: previous.verdict,
            falseAlarm: previous.falseAlarmAt !== null,
            released: previous.holdReleasedAt !== null,
          }
        : null,
    );
    if (!opens) {
      return;
    }
    const object = await describeObject(tx, source.kind, row.object_id);
    await raiseEvents(
      tx,
      [
        {
          tenantId: row.tenant_id,
          level: "error",
          event: "backup.suspicious",
          message: `The restore point of ${object.name} from ${at.toISOString()} shows signs of ransomware: ${result.findings.map(describeFinding).join("; ")}. Check the system before restoring; the newest restore point without findings is marked in the restore views.${settings.retentionHold.enabled ? " Retention of this object is paused: no restore point of it is deleted until an administrator marks the finding as a false alarm or releases the hold." : ""}`,
          details: {
            ...object.ref,
            objectKind: source.kind,
            objectId: row.object_id,
            objectName: object.name,
            runId: row.run_id,
            restorePointId: row.restore_point_id,
            restorePointAt: at.toISOString(),
            suspicionId: inserted.id,
            findings: result.findings,
            signaturesVersion: result.signaturesVersion,
            retentionHeld: settings.retentionHold.enabled,
          },
        },
      ],
      now,
    );
    await tx
      .update(restorePointSuspicions)
      .set({ alertedAt: now })
      .where(eq(restorePointSuspicions.id, inserted.id));
    summary.alerts++;
  });
}

/** The installation's thresholds. */
export async function loadRansomwareSettings(providerDb: Database): Promise<RansomwareSettings> {
  const [row] = await providerDb
    .select({ value: settingsTable.ransomwareDetection })
    .from(settingsTable)
    .limit(1);
  return resolveRansomwareSettings(row?.value ?? {});
}

/** One pass over every kind. */
export async function suspicionPass(deps: SuspicionDeps): Promise<SuspicionPassSummary> {
  const summary: SuspicionPassSummary = { judged: 0, suspicious: 0, alerts: 0, reminders: 0 };
  const settings = await loadRansomwareSettings(deps.providerDb);
  const now = deps.runtime.now();
  // Holds stay until an administrator resolves them, even with the detection switched off.
  try {
    summary.reminders = await remindRetentionHolds(deps, settings, now);
  } catch (error) {
    deps.runtime.logger.warn("unresolved retention holds could not be announced again", {
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error),
    });
  }
  if (!settings.enabled) {
    return summary;
  }
  const since = new Date(now.getTime() - SUSPICION_WINDOW_MS);
  for (const source of SOURCES) {
    const rows = await candidatesOf(deps.providerDb, source, since);
    for (const row of rows) {
      if (deps.runtime.shutdownSignal.aborted) {
        return summary;
      }
      try {
        await judge(deps, source, row, settings, now, summary);
      } catch (error) {
        // One run that cannot be judged must not hold up the others; it is tried again next pass.
        deps.runtime.logger.warn("a restore point could not be judged", {
          kind: source.kind,
          runId: row.run_id,
          errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error),
        });
      }
    }
  }
  return summary;
}

/** Run a pass every two minutes while no other worker does; returns a stop function. */
export function startSuspicionScan(
  deps: SuspicionDeps,
  intervalMs = SUSPICION_PASS_INTERVAL_MS,
): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const tick = async () => {
    const client = await deps.providerDb.$client.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [LOCK_KEY],
      );
      if (!rows[0]?.locked) {
        return;
      }
      try {
        const summary = await suspicionPass(deps);
        if (summary.judged > 0 || summary.reminders > 0) {
          deps.runtime.logger.info("ransomware judgement pass", { ...summary });
        }
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
      }
    } catch (error) {
      deps.runtime.logger.error("ransomware judgement pass failed", {
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
    } finally {
      client.release();
      if (!stopped) {
        timer = setTimeout(() => void tick(), intervalMs);
      }
    }
  };
  timer = setTimeout(() => void tick(), 45_000);
  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
  deps.runtime.shutdownSignal.addEventListener("abort", stop, { once: true });
  return stop;
}
