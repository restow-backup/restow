/**
 * The checks of the native SQL Server backup in the endpoint monitor (W2a,
 * docs/BAREMETAL-WINDOWS.md 5.1.7, "Grün ist Beweis"):
 *
 *   - planning: at the check slot of the machine's job (weekday and time in the zone of its
 *     schedule; @restow/core `sqlVerifyDue`), one `sql_verify` task per instance with the newest
 *     active full of each database the job takes; none while a check of the instance waits or
 *     runs, none when one (also one asked for by hand) was created since the slot began, none
 *     for an agent without `sql_native_v1`. The agent runs one job at a time (W2a has
 *     no lock classes), so the job editor keeps the slot an hour off the daily backup.
 *   - alerts, each raised once: `endpoint.sql_red` for a red check (the report's `alerted_at`),
 *     `endpoint.sql_recovered` for a green check of a database whose previous result was red and
 *     alerted, `endpoint.sql_overdue` for a backed-up database without a green check for more than
 *     8 days (once per episode: not again until a green check came after the last alert).
 *
 * The API judges each check (apps/api features/endpoints/sql-agent.ts); nothing here reads what
 * the agent wrote beyond the server's own reports.
 */
import {
  hasSqlCapability,
  SQL_GREEN_VALID_MS,
  SQL_VERIFY_TASK_TTL_MS,
  type SqlVerifyCandidate,
  sqlDatabaseSelected,
  sqlVerifyDue,
  sqlVerifyOf,
  sqlVerifyTaskParams,
} from "@restow/core";
import {
  type Endpoint,
  type EndpointSqlBackupFile,
  endpointReports,
  endpointSqlBackups,
  endpointSqlDatabases,
  endpoints,
  endpointTasks,
  type NewNotification,
  notifications,
} from "@restow/db";
import { and, desc, eq, gt, inArray, isNull, min, sql } from "drizzle-orm";
import { withTenantTx } from "../handlers/framework.js";
import type { TenantTx } from "../progress.js";
import { raiseEvents } from "../reporting.js";
import type { EndpointJobDeps } from "./common.js";
import { endpointName } from "./monitor.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Checks older than this are not announced any more (an outage of the monitor must not flood). */
const ALERT_WINDOW_MS = 3 * DAY_MS;

/** Windows machines whose job switched the native SQL backup on, across all tenants. */
async function sqlMachines(deps: EndpointJobDeps): Promise<Endpoint[]> {
  return deps.providerDb
    .select()
    .from(endpoints)
    .where(
      and(
        eq(endpoints.status, "active"),
        eq(endpoints.os, "windows"),
        isNull(endpoints.removedAt),
        sql`(${endpoints.config}->'sql'->>'enabled')::boolean IS TRUE`,
        sql`exists (select 1 from tenants t where t.id = ${endpoints.tenantId} and t.status = 'active')`,
      ),
    )
    .limit(5000);
}

/** The newest active full of each database of the machine the job takes, per instance. */
export async function sqlVerifyCandidatesOf(
  tx: TenantTx,
  endpoint: Endpoint,
): Promise<Map<string, SqlVerifyCandidate[]>> {
  const settings = endpoint.config.sql;
  const result = new Map<string, SqlVerifyCandidate[]>();
  if (!settings) {
    return result;
  }
  const rows = (
    await tx
      .select()
      .from(endpointSqlDatabases)
      .where(
        and(
          eq(endpointSqlDatabases.endpointId, endpoint.id),
          isNull(endpointSqlDatabases.droppedAt),
        ),
      )
  ).filter((row) => sqlDatabaseSelected(settings, row.instance, row.database));
  if (rows.length === 0) {
    return result;
  }
  const fulls = await tx
    .selectDistinctOn([endpointSqlBackups.databaseId])
    .from(endpointSqlBackups)
    .where(
      and(
        inArray(
          endpointSqlBackups.databaseId,
          rows.map((row) => row.id),
        ),
        eq(endpointSqlBackups.status, "active"),
        eq(endpointSqlBackups.kind, "full"),
      ),
    )
    .orderBy(endpointSqlBackups.databaseId, desc(endpointSqlBackups.backupFinish));
  const byDatabase = new Map(fulls.map((full) => [full.databaseId, full]));
  for (const row of rows) {
    const full = byDatabase.get(row.id);
    if (!full) {
      continue;
    }
    const list = result.get(row.instance) ?? [];
    list.push({
      databaseId: row.id,
      name: row.database,
      usedBytes: row.facts.usedBytes ?? 0,
      backup: {
        id: full.id,
        snapshotId: full.resticSnapshotId,
        pathInSnapshot: full.pathInSnapshot,
        sha256: full.sha256,
        bytes: full.bytes,
        fileList: full.fileList as EndpointSqlBackupFile[],
      },
    });
    result.set(row.instance, list);
  }
  return result;
}

/** Plan the checks that are due; the number of tasks created. */
export async function planSqlVerifyChecks(deps: EndpointJobDeps, now: Date): Promise<number> {
  let planned = 0;
  for (const endpoint of await sqlMachines(deps)) {
    const verify = sqlVerifyOf(endpoint.config.sql);
    if (!verify.enabled || !hasSqlCapability(endpoint.settings.agent?.capabilities)) {
      continue;
    }
    const zone = endpoint.config.schedule?.timeZone || "Europe/Berlin";
    planned += await withTenantTx(deps.db, endpoint.tenantId, async (tx) => {
      const tasks = await tx
        .select({
          status: endpointTasks.status,
          createdAt: endpointTasks.createdAt,
          instance: sql<string>`upper(coalesce(${endpointTasks.params}->>'instance', ''))`,
        })
        .from(endpointTasks)
        .where(and(eq(endpointTasks.endpointId, endpoint.id), eq(endpointTasks.kind, "sql_verify")))
        .orderBy(desc(endpointTasks.createdAt))
        .limit(200);
      let created = 0;
      for (const [instance, candidates] of await sqlVerifyCandidatesOf(tx, endpoint)) {
        const own = tasks.filter((task) => task.instance === instance.toUpperCase());
        if (own.some((task) => task.status === "pending" || task.status === "delivered")) {
          continue;
        }
        if (!sqlVerifyDue(verify, zone, own[0]?.createdAt ?? null, now)) {
          continue;
        }
        const params = sqlVerifyTaskParams(instance, verify, candidates);
        if (!params) {
          continue;
        }
        await tx.insert(endpointTasks).values({
          tenantId: endpoint.tenantId,
          endpointId: endpoint.id,
          kind: "sql_verify",
          params: params as unknown as Record<string, unknown>,
          createdAt: now,
          expiresAt: new Date(now.getTime() + SQL_VERIFY_TASK_TTL_MS),
        });
        created += 1;
      }
      return created;
    });
  }
  return planned;
}

function sqlSubject(summary: Record<string, unknown>, name: string): string {
  const instance = typeof summary.instance === "string" ? summary.instance : "";
  const database = typeof summary.database === "string" ? summary.database : "";
  return `${database}${instance ? ` (${instance})` : ""} on ${name}`;
}

/** `endpoint.sql_red` and `endpoint.sql_recovered`, once per report. */
export async function alertSqlReports(deps: EndpointJobDeps, now: Date): Promise<number> {
  const since = new Date(now.getTime() - ALERT_WINDOW_MS);
  const rows = await deps.providerDb
    .select({
      report: endpointReports,
      hostname: endpoints.hostname,
      displayName: endpoints.displayName,
    })
    .from(endpointReports)
    .innerJoin(endpoints, eq(endpoints.id, endpointReports.endpointId))
    .where(
      and(
        eq(endpointReports.kind, "sql_verify"),
        isNull(endpointReports.alertedAt),
        inArray(endpointReports.readiness, ["red", "green"]),
        gt(endpointReports.checkedAt, since),
      ),
    )
    .orderBy(endpointReports.checkedAt)
    .limit(500);
  const byTenant = new Map<string, typeof rows>();
  for (const row of rows) {
    byTenant.set(row.report.tenantId, [...(byTenant.get(row.report.tenantId) ?? []), row]);
  }
  let alerts = 0;
  for (const [tenantId, list] of byTenant) {
    await withTenantTx(deps.db, tenantId, async (tx) => {
      const raised: NewNotification[] = [];
      for (const { report, hostname, displayName } of list) {
        const name = endpointName({ hostname, displayName });
        const subject = sqlSubject(report.summary, name);
        const databaseId = report.summary.databaseId ?? null;
        if (report.readiness === "red") {
          const evidence = Array.isArray(report.summary.evidence) ? report.summary.evidence : [];
          const first = evidence[0];
          const detail = first
            ? `${first.number ? `${first.number}: ` : ""}${first.message}`.slice(0, 300)
            : "";
          raised.push({
            tenantId,
            level: "error",
            event: "endpoint.sql_red",
            message: `The check of the SQL Server backup of ${subject} found damage${detail ? `: ${detail}` : "."}`,
            details: {
              endpointId: report.endpointId,
              objectName: name,
              reportId: report.id,
              databaseId,
              database: report.summary.database ?? null,
              instance: report.summary.instance ?? null,
              snapshotId: report.snapshotId,
              errorMessage: detail || null,
            },
          });
          continue;
        }
        // Green: news only when the previous result of this database was red and alerted.
        const [previous] = await tx
          .select({ readiness: endpointReports.readiness, alertedAt: endpointReports.alertedAt })
          .from(endpointReports)
          .where(
            and(
              eq(endpointReports.endpointId, report.endpointId),
              eq(endpointReports.kind, "sql_verify"),
              inArray(endpointReports.readiness, ["red", "green"]),
              sql`${endpointReports.summary}->>'databaseId' = ${databaseId ?? ""}`,
              sql`${endpointReports.checkedAt} < ${report.checkedAt}`,
            ),
          )
          .orderBy(desc(endpointReports.checkedAt))
          .limit(1);
        if (previous?.readiness === "red" && previous.alertedAt !== null) {
          raised.push({
            tenantId,
            level: "info",
            event: "endpoint.sql_recovered",
            message: `The SQL Server backup of ${subject} was checked without errors again.`,
            details: {
              endpointId: report.endpointId,
              objectName: name,
              reportId: report.id,
              databaseId,
              database: report.summary.database ?? null,
              instance: report.summary.instance ?? null,
            },
          });
        }
      }
      await raiseEvents(tx, raised, now);
      await tx
        .update(endpointReports)
        .set({ alertedAt: now })
        .where(
          inArray(
            endpointReports.id,
            list.map(({ report }) => report.id),
          ),
        );
      alerts += raised.length;
    });
  }
  return alerts;
}

/**
 * `endpoint.sql_overdue`: a database the job takes has been in the repository for more than 8
 * days without a green check since (or since its last green one). Raised once per episode: the
 * notification names when the episode began (`since`), and one of the same begin counts as raised.
 */
export async function alertSqlOverdue(deps: EndpointJobDeps, now: Date): Promise<number> {
  let alerts = 0;
  for (const endpoint of await sqlMachines(deps)) {
    const settings = endpoint.config.sql;
    if (!settings || !sqlVerifyOf(settings).enabled) {
      continue;
    }
    alerts += await withTenantTx(deps.db, endpoint.tenantId, async (tx) => {
      const rows = (
        await tx
          .select({
            id: endpointSqlDatabases.id,
            instance: endpointSqlDatabases.instance,
            database: endpointSqlDatabases.database,
            firstBackupAt: min(endpointSqlBackups.backupFinish),
          })
          .from(endpointSqlDatabases)
          .innerJoin(endpointSqlBackups, eq(endpointSqlBackups.databaseId, endpointSqlDatabases.id))
          .where(
            and(
              eq(endpointSqlDatabases.endpointId, endpoint.id),
              isNull(endpointSqlDatabases.droppedAt),
              eq(endpointSqlBackups.status, "active"),
            ),
          )
          .groupBy(
            endpointSqlDatabases.id,
            endpointSqlDatabases.instance,
            endpointSqlDatabases.database,
          )
      ).filter((row) => sqlDatabaseSelected(settings, row.instance, row.database));
      if (rows.length === 0) {
        return 0;
      }
      const greens = await tx
        .select({
          databaseId: sql<string>`${endpointReports.summary}->>'databaseId'`,
          checkedAt: sql<Date>`max(${endpointReports.checkedAt})`,
        })
        .from(endpointReports)
        .where(
          and(
            eq(endpointReports.endpointId, endpoint.id),
            eq(endpointReports.kind, "sql_verify"),
            eq(endpointReports.readiness, "green"),
          ),
        )
        .groupBy(sql`${endpointReports.summary}->>'databaseId'`);
      const lastGreen = new Map(greens.map((row) => [row.databaseId, new Date(row.checkedAt)]));
      const raised: NewNotification[] = [];
      const name = endpointName(endpoint);
      for (const row of rows) {
        const green = lastGreen.get(row.id) ?? null;
        const since = green ?? (row.firstBackupAt ? new Date(row.firstBackupAt) : null);
        if (since === null || now.getTime() - since.getTime() <= SQL_GREEN_VALID_MS) {
          continue;
        }
        const [told] = await tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.tenantId, endpoint.tenantId),
              eq(notifications.event, "endpoint.sql_overdue"),
              sql`${notifications.details}->>'databaseId' = ${row.id}`,
              // The episode: overdue since this green check (or this first backup).
              sql`${notifications.details}->>'since' = ${since.toISOString()}`,
            ),
          )
          .limit(1);
        if (told) {
          continue;
        }
        const days = Math.floor((now.getTime() - since.getTime()) / DAY_MS);
        raised.push({
          tenantId: endpoint.tenantId,
          level: "warning",
          event: "endpoint.sql_overdue",
          message: green
            ? `The SQL Server backup of ${row.database} (${row.instance}) on ${name} has had no check without errors for ${days} days.`
            : `The SQL Server backup of ${row.database} (${row.instance}) on ${name} has not been checked without errors since it was first made ${days} days ago.`,
          details: {
            endpointId: endpoint.id,
            objectName: name,
            databaseId: row.id,
            database: row.database,
            instance: row.instance,
            lastGreenAt: green?.toISOString() ?? null,
            since: since.toISOString(),
          },
        });
      }
      await raiseEvents(tx, raised, now);
      return raised.length;
    });
  }
  return alerts;
}
