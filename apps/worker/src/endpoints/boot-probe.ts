/**
 * The boot probe in the worker (docs/BAREMETAL.md 12.3, 12.4, 12.6), apart from the lab API
 * (./lab-api.ts):
 *
 *   - Planning, in the monitor pass: a machine whose newest whole machine snapshot passed stage 1
 *     gets a probe of that snapshot when one is due (@restow/core `bootProbeDue`: at once for new
 *     fingerprints, weekly, six hours after one that proved nothing), only while a lab with KVM
 *     asks for work. A probe is a recovery row of kind `probe` without a code (`planned`); the lab
 *     takes it with its next request. A machine the probe cannot boot (no systemd, too large even
 *     with its largest data folders left empty, no disks) gets a `boot_probe` report without a
 *     rating that says so, once per pair of fingerprints.
 *   - The alarms: `baremetal.red` once per episode for a red stage 1 or a red probe (with
 *     `job.failed` for every red report), `baremetal.recovered` when the next report of that kind
 *     is green, `baremetal.overdue` once when the green probe a machine is green with is older
 *     than 8 days.
 */
import {
  baremetalCheckFailedCause,
  bootProbeDue,
  bootProbeFailedCause,
  type FailureCause,
  type LinuxLayoutManifest,
  labMaxRestoreBytes,
  labPresent,
  PROBE_EXPIRY_MS,
  type ProbeSelection,
  parseLayoutManifest,
  probeNotPossible,
  probeRating,
  probeSelection,
  type RestoreSize,
  toFailureRecord,
} from "@restow/core";
import {
  bootProbeReports,
  endpointLayouts,
  endpointRecoveries,
  endpointReports,
  endpointRuns,
  endpoints,
  loadRecoveryLab,
  type NewNotification,
  notifications,
  pendingBootProbe,
} from "@restow/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { appendAuditEntry } from "../audit.js";
import { withTenantTx } from "../handlers/framework.js";
import { emitWebhookEvent } from "../handlers/webhooks.js";
import type { TenantTx } from "../progress.js";
import { raiseEvents } from "../reporting.js";
import type { EndpointJobDeps } from "./common.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Reports older than this are not announced any more (an outage of the monitor must not flood). */
const ALERT_WINDOW_MS = 3 * DAY_MS;

/** The largest restore of a probe, from `RESTOW_LAB_MAX_RESTORE_GIB` (64 GiB by default). */
export function labMaxRestoreBytesFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.RESTOW_LAB_MAX_RESTORE_GIB?.trim();
  return labMaxRestoreBytes(raw ? Number(raw) : undefined);
}

/** Stage 1 of a whole machine snapshot, as the probe needs it. */
export interface ProbeStageOne {
  runId: string;
  snapshotId: string;
  layoutId: string;
  manifest: LinuxLayoutManifest | null;
  reportId: string;
  readiness: "green" | "yellow" | "red";
  layoutFingerprint: string;
  bootChainFingerprint: string | null;
  restoreSizes: Record<string, RestoreSize>;
  folderSizes: Record<string, number>;
}

function numberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, n] of Object.entries(value as Record<string, unknown>)) {
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
    }
  }
  return out;
}

function restoreSizesOf(value: unknown): Record<string, RestoreSize> {
  const out: Record<string, RestoreSize> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const size = numberRecord(raw);
      if (size.bytes !== undefined) {
        out[key] = { bytes: size.bytes, files: size.files ?? 0, inodes: size.inodes ?? 0 };
      }
    }
  }
  return out;
}

/**
 * The newest whole machine snapshot of a machine (or the one named) with its newest rated stage 1
 * report; null without either.
 */
export async function stageOneOf(
  tx: TenantTx,
  endpointId: string,
  snapshotId?: string | null,
): Promise<ProbeStageOne | null> {
  const [run] = await tx
    .select({
      runId: endpointRuns.id,
      snapshotId: endpointRuns.snapshotId,
      layout: endpointLayouts,
    })
    .from(endpointRuns)
    .innerJoin(endpointLayouts, eq(endpointLayouts.id, endpointRuns.layoutId))
    .where(
      and(
        eq(endpointRuns.endpointId, endpointId),
        isNotNull(endpointRuns.layoutId),
        snapshotId ? eq(endpointRuns.snapshotId, snapshotId) : isNotNull(endpointRuns.snapshotId),
      ),
    )
    .orderBy(desc(endpointRuns.startedAt))
    .limit(1);
  if (!run?.snapshotId) return null;
  const [report] = await tx
    .select()
    .from(endpointReports)
    .where(
      and(
        eq(endpointReports.endpointId, endpointId),
        eq(endpointReports.kind, "baremetal_check"),
        eq(endpointReports.snapshotId, run.snapshotId),
        isNotNull(endpointReports.readiness),
      ),
    )
    .orderBy(desc(endpointReports.checkedAt))
    .limit(1);
  if (!report?.readiness) return null;
  const summary = report.summary as Record<string, unknown>;
  const parsed = parseLayoutManifest(run.layout.manifest);
  return {
    runId: run.runId,
    snapshotId: run.snapshotId,
    layoutId: run.layout.id,
    manifest: parsed.ok && parsed.manifest.platform === "linux" ? parsed.manifest : null,
    reportId: report.id,
    readiness: report.readiness,
    layoutFingerprint: run.layout.layoutFingerprint,
    bootChainFingerprint:
      typeof summary.bootChainFingerprint === "string" ? summary.bootChainFingerprint : null,
    restoreSizes: restoreSizesOf(summary.restoreSizes),
    folderSizes: numberRecord(summary.folderSizes),
  };
}

/** Why a probe of this stage 1 cannot run, or what it restores. */
export function probePlanOf(stage: ProbeStageOne, maxBytes: number): ProbeSelection {
  const manifest = stage.manifest as LinuxLayoutManifest;
  const reason = probeNotPossible(manifest);
  if (reason) return { possible: false, reason, restoreBytes: 0 };
  return probeSelection({
    manifest,
    restoreSizes: stage.restoreSizes,
    folderSizes: stage.folderSizes,
    maxBytes,
  });
}

/** The report that says no probe can run for these fingerprints (no rating). */
export async function writeNotPossibleReport(
  tx: TenantTx,
  tenantId: string,
  endpointId: string,
  stage: ProbeStageOne,
  plan: Extract<ProbeSelection, { possible: false }>,
  now: Date,
): Promise<void> {
  await tx.insert(endpointReports).values({
    tenantId,
    endpointId,
    kind: "boot_probe",
    origin: "server",
    snapshotId: stage.snapshotId,
    runId: stage.runId,
    readiness: null,
    checkedAt: now,
    summary: {
      layoutFingerprint: stage.layoutFingerprint,
      bootChainFingerprint: stage.bootChainFingerprint,
      notPossible: plan.reason,
      restoreBytes: plan.restoreBytes,
    },
  });
}

export interface ProbePlanSummary {
  /** Probes planned for the lab. */
  planned: number;
  /** Machines the probe cannot boot, recorded once per pair of fingerprints. */
  notPossible: number;
  /** `baremetal.overdue` raised. */
  overdue: number;
}

/**
 * The planning pass (12.3) and `baremetal.overdue`, for every active Linux machine backed up as a
 * whole. Per machine under the same advisory lock as "Probe now" (apps/api requestBootProbe), so
 * the two plan one probe between them.
 */
export async function planBootProbes(
  deps: EndpointJobDeps,
  now: Date,
  options: { maxRestoreBytes?: number } = {},
): Promise<ProbePlanSummary> {
  const maxBytes = options.maxRestoreBytes ?? labMaxRestoreBytesFromEnv();
  const lab = labPresent(await loadRecoveryLab(deps.providerDb), now);
  const machines = await deps.providerDb
    .select({
      id: endpoints.id,
      tenantId: endpoints.tenantId,
      hostname: endpoints.hostname,
      displayName: endpoints.displayName,
    })
    .from(endpoints)
    .where(
      and(
        eq(endpoints.status, "active"),
        eq(endpoints.os, "linux"),
        isNull(endpoints.removedAt),
        sql`${endpoints.config}->>'wholeMachine' = 'true'`,
        sql`exists (select 1 from tenants t where t.id = ${endpoints.tenantId} and t.status = 'active')`,
      ),
    )
    .limit(5000);
  const summary: ProbePlanSummary = { planned: 0, notPossible: 0, overdue: 0 };
  for (const machine of machines) {
    await withTenantTx(deps.db, machine.tenantId, async (tx) => {
      const stage = await stageOneOf(tx, machine.id);
      if (stage?.readiness !== "green" || !stage.bootChainFingerprint || !stage.manifest) {
        return;
      }
      const fingerprints = {
        layoutFingerprint: stage.layoutFingerprint,
        bootChainFingerprint: stage.bootChainFingerprint,
      };
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`probe:${machine.id}`}))`);
      const probes = await bootProbeReports(tx, machine.id, fingerprints);
      const rating = probeRating({ probes, notPossible: null, lab, pending: null }, now);
      const rated = probes.find((report) => report.readiness !== null);
      if (rating.state === "overdue" && rated) {
        if (await raiseOverdue(tx, machine, rated, now)) summary.overdue += 1;
      }
      if (!lab.kvm || (await pendingBootProbe(tx, machine.id, now))) {
        return;
      }
      const due = bootProbeDue({ ...fingerprints, probes, requested: false, now });
      if (!due.due) return;
      const plan = probePlanOf(stage, maxBytes);
      if (!plan.possible) {
        await writeNotPossibleReport(tx, machine.tenantId, machine.id, stage, plan, now);
        summary.notPossible += 1;
        return;
      }
      const [created] = await tx
        .insert(endpointRecoveries)
        .values({
          tenantId: machine.tenantId,
          endpointId: machine.id,
          kind: "probe",
          status: "issued",
          requireApproval: false,
          snapshotId: stage.snapshotId,
          issuedAt: now,
          expiresAt: new Date(now.getTime() + PROBE_EXPIRY_MS),
          updatedAt: now,
        })
        .returning({ id: endpointRecoveries.id });
      await appendAuditEntry(tx, {
        tenantId: machine.tenantId,
        actor: "system",
        action: "endpoint.boot_probe.requested",
        target: machine.id,
        targetType: "endpoint",
        details: { recoveryId: created?.id ?? null, snapshotId: stage.snapshotId, due: due.reason },
      });
      summary.planned += 1;
    });
  }
  return summary;
}

function machineName(machine: { hostname: string; displayName: string | null }): string {
  return machine.displayName?.trim() || machine.hostname;
}

async function raiseOverdue(
  tx: TenantTx,
  machine: { id: string; tenantId: string; hostname: string; displayName: string | null },
  rated: { id: string; checkedAt: Date },
  now: Date,
): Promise<boolean> {
  const [told] = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.tenantId, machine.tenantId),
        eq(notifications.event, "baremetal.overdue"),
        // The episode: overdue since this green probe.
        sql`${notifications.details}->>'reportId' = ${rated.id}`,
      ),
    )
    .limit(1);
  if (told) return false;
  const name = machineName(machine);
  const days = Math.floor((now.getTime() - rated.checkedAt.getTime()) / DAY_MS);
  await raiseEvents(
    tx,
    [
      {
        tenantId: machine.tenantId,
        level: "warning",
        event: "baremetal.overdue",
        message: `The last passed boot probe of ${name} is ${days} days old; the machine no longer counts as proven to restore onto new hardware.`,
        details: {
          endpointId: machine.id,
          objectName: name,
          reportId: rated.id,
          lastGreenAt: rated.checkedAt.toISOString(),
        },
      },
    ],
    now,
  );
  return true;
}

type AlertKind = "baremetal_check" | "boot_probe";

/** What a red report says in its alarm and in `job.failed`. */
function redOf(
  kind: AlertKind,
  summary: Record<string, unknown>,
): { detail: string; cause: FailureCause } {
  if (kind === "baremetal_check") {
    const checks = Array.isArray(summary.checks)
      ? (summary.checks as { id?: unknown; status?: unknown }[])
          .filter((check) => check.status === "failed" && typeof check.id === "string")
          .map((check) => check.id as string)
      : [];
    return {
      detail: checks.length > 0 ? `failed checks ${checks.join(", ")}` : "",
      cause: baremetalCheckFailedCause(checks),
    };
  }
  const cause = (summary.cause ?? {}) as Record<string, unknown>;
  const kindOf =
    cause.kind === "boot_failed" ||
    cause.kind === "recovery_failed" ||
    cause.kind === "verification_failed"
      ? cause.kind
      : "boot_failed";
  const evidence =
    typeof cause.line === "string"
      ? cause.line
      : Array.isArray(cause.codes)
        ? (cause.codes as unknown[]).join(", ")
        : Array.isArray(cause.checks)
          ? (cause.checks as unknown[]).join(", ")
          : null;
  const detail =
    kindOf === "boot_failed"
      ? `the restored system did not start${evidence ? ` (${evidence.slice(0, 200)})` : ""}`
      : kindOf === "recovery_failed"
        ? `the recovery found a problem of the backup${evidence ? ` (${evidence})` : ""}`
        : `the check after the recovery failed${evidence ? ` (${evidence})` : ""}`;
  return { detail, cause: bootProbeFailedCause(kindOf, evidence) };
}

/**
 * `baremetal.red`, `baremetal.recovered` and `job.failed` for the stage 1 and boot probe reports
 * not yet announced (12.6). An episode is per kind of report: red after green (or after nothing)
 * raises `baremetal.red`, red after red raises nothing, green after red raises
 * `baremetal.recovered`. Every red report is a `job.failed` (queue `endpoint_baremetal_check` or
 * `endpoint_boot_probe`); a report without a rating (incomplete, not possible) is neither.
 */
export async function alertBaremetalReports(deps: EndpointJobDeps, now: Date): Promise<number> {
  const since = new Date(now.getTime() - ALERT_WINDOW_MS);
  const rows = await deps.providerDb
    .select({
      report: endpointReports,
      hostname: endpoints.hostname,
      displayName: endpoints.displayName,
      profile: endpoints.profile,
    })
    .from(endpointReports)
    .innerJoin(endpoints, eq(endpoints.id, endpointReports.endpointId))
    .where(
      and(
        isNull(endpointReports.alertedAt),
        inArray(endpointReports.readiness, ["red", "green"]),
        sql`${endpointReports.checkedAt} > ${since}`,
        inArray(endpointReports.kind, ["baremetal_check", "boot_probe"]),
      ),
    )
    .orderBy(asc(endpointReports.checkedAt))
    .limit(200);
  const byTenant = new Map<string, typeof rows>();
  for (const row of rows) {
    byTenant.set(row.report.tenantId, [...(byTenant.get(row.report.tenantId) ?? []), row]);
  }
  let alerts = 0;
  for (const [tenantId, list] of byTenant) {
    const webhooks: { row: (typeof list)[number]; cause: FailureCause; detail: string }[] = [];
    await withTenantTx(deps.db, tenantId, async (tx) => {
      const raised: NewNotification[] = [];
      // The state each machine and kind was last announced in, this pass included.
      const last = new Map<string, "red" | "green" | null>();
      for (const row of list) {
        const { report } = row;
        const kind = report.kind as AlertKind;
        const key = `${report.endpointId}:${kind}`;
        if (!last.has(key)) {
          const [earlier] = await tx
            .select({ readiness: endpointReports.readiness })
            .from(endpointReports)
            .where(
              and(
                eq(endpointReports.endpointId, report.endpointId),
                eq(endpointReports.kind, kind),
                inArray(endpointReports.readiness, ["red", "green"]),
                isNotNull(endpointReports.alertedAt),
                lt(endpointReports.checkedAt, report.checkedAt),
              ),
            )
            .orderBy(desc(endpointReports.checkedAt))
            .limit(1);
          last.set(key, earlier?.readiness === "red" ? "red" : earlier ? "green" : null);
        }
        const before = last.get(key) ?? null;
        const name = machineName(row);
        const what = kind === "baremetal_check" ? "bare metal check" : "boot probe";
        if (report.readiness === "red") {
          const red = redOf(kind, report.summary as Record<string, unknown>);
          webhooks.push({ row, ...red });
          if (before !== "red") {
            raised.push({
              tenantId,
              level: "error",
              event: "baremetal.red",
              message: `The ${what} of ${name} failed${red.detail ? `: ${red.detail}` : "."}`,
              details: {
                endpointId: report.endpointId,
                objectName: name,
                reportId: report.id,
                kind,
                snapshotId: report.snapshotId,
                errorMessage: red.detail || null,
              },
            });
          }
          last.set(key, "red");
        } else {
          if (before === "red") {
            raised.push({
              tenantId,
              level: "info",
              event: "baremetal.recovered",
              message: `The ${what} of ${name} passes again.`,
              details: {
                endpointId: report.endpointId,
                objectName: name,
                reportId: report.id,
                kind,
              },
            });
          }
          last.set(key, "green");
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
    for (const { row, cause, detail } of webhooks) {
      const { report } = row;
      await emitWebhookEvent(deps.db, {
        tenantId,
        event: "job.failed",
        occurredAt: now,
        data: {
          job: {
            id: report.id,
            queue:
              report.kind === "baremetal_check"
                ? "endpoint_baremetal_check"
                : "endpoint_boot_probe",
            status: "failed",
            protectedObjectId: null,
            startedAt: report.checkedAt.toISOString(),
            completedAt: report.checkedAt.toISOString(),
            durationMs: null,
            errorMessage: detail || null,
            failure: toFailureRecord(cause, { now: report.checkedAt }),
          },
          endpoint: {
            id: report.endpointId,
            hostname: row.hostname,
            displayName: row.displayName,
            profile: row.profile,
          },
        },
      }).catch(() => undefined);
    }
  }
  return alerts;
}
