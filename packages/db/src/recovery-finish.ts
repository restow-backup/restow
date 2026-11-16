/**
 * Storing the end of a bare metal recovery (docs/BAREMETAL.md 9.8, 10.17): the API with the ISO's
 * own finish, the worker with the finish a boot probe relays through the lab after its network
 * was cut (12.3). Both write it here, so the redaction, the warning codes the server reserves, the
 * rule for a reported success and the audit entry are the same (@restow/core `recoveryFinishSchema`,
 * `redactRecoveryFinish`, `settleRecoveryFinish`). Which session may finish is the caller's to
 * decide, on the row it holds locked; the alerts are the caller's too.
 */
import {
  type AuditEvent,
  parseRecoveryVerification,
  type RecoveryFinishInput,
  redactRecoveryFinish,
  type SuccessContradiction,
  settleRecoveryFinish,
  successContradiction,
} from "@restow/core";
import { and, eq, inArray, isNotNull, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  type EndpointRecoveryStatus,
  endpointLayouts,
  endpointRecoveries,
  endpointRuns,
} from "./schema/endpoints.js";

// biome-ignore lint/suspicious/noExplicitAny: any schema, a transaction or the pool itself
type FinishTx = Pick<NodePgDatabase<any>, "select" | "update">;

/** The audit action of a finished recovery (9.9). */
export const RECOVERY_FINISHED_ACTION = "endpoint.recovery.finished";

/**
 * The backup runs of a machine that are a whole machine backup the ISO can restore: a good
 * (`succeeded`, `partial`) backup with a snapshot and a layout (joined on `endpoint_layouts`), all of
 * them or (with `snapshotId`) the runs of that snapshot.
 */
export function baremetalBackupRunsWhere(
  endpointId: string,
  snapshotId: string | null,
): SQL | undefined {
  return and(
    eq(endpointRuns.endpointId, endpointId),
    eq(endpointRuns.kind, "backup"),
    inArray(endpointRuns.status, ["succeeded", "partial"]),
    snapshotId === null
      ? isNotNull(endpointRuns.snapshotId)
      : eq(endpointRuns.snapshotId, snapshotId),
  );
}

/** Whether a snapshot is a whole machine backup of the machine ({@link baremetalBackupRunsWhere}). */
export async function baremetalSnapshotKnown(
  tx: FinishTx,
  endpointId: string,
  snapshotId: string,
): Promise<boolean> {
  if (snapshotId === "") {
    return false;
  }
  const [run] = await tx
    .select({ id: endpointRuns.id })
    .from(endpointRuns)
    .innerJoin(endpointLayouts, eq(endpointLayouts.id, endpointRuns.layoutId))
    .where(baremetalBackupRunsWhere(endpointId, snapshotId))
    .limit(1);
  return run !== undefined;
}

/**
 * Why a finish that reports `succeeded` is not stored as one (10.17), or null: the report it
 * carries must parse as `restow-verify-v1`, hold all ten checks, none of them failed, and name a
 * whole machine backup of this machine. The report is judged as it is stored (redacted), so the
 * state and what the page shows agree.
 */
export async function reportedSuccessContradiction(
  tx: FinishTx,
  endpointId: string,
  verification: Record<string, unknown>,
): Promise<SuccessContradiction | null> {
  const contradiction = successContradiction(verification);
  if (contradiction) {
    return contradiction;
  }
  const snapshotId = parseRecoveryVerification(verification)?.snapshotId ?? "";
  if (!(await baremetalSnapshotKnown(tx, endpointId, snapshotId))) {
    return { code: "success_snapshot_unknown", checks: [] };
  }
  return null;
}

/** The session a finish ends, as the caller holds it locked. */
export interface FinishingRecovery {
  id: string;
  tenantId: string;
  endpointId: string;
  status: EndpointRecoveryStatus;
  releasedAt: Date | null;
}

export interface FinishRecoveryInput {
  recovery: FinishingRecovery;
  finish: RecoveryFinishInput;
  /** Who wrote it: the session (`recovery:<id>`), or the lab that relayed a probe's finish. */
  actor: { label: string; userId: string | null; ip: string | null };
  /** The lab handed the finish in (a probe without network after its release, 12.3). */
  relayedBy?: "lab";
  now: Date;
  /** Appends one audit entry in the caller's transaction (the API's and the worker's chain writer). */
  audit: (event: AuditEvent) => Promise<unknown>;
}

export interface FinishedRecovery {
  status: RecoveryFinishInput["status"];
  /** Why a reported success was stored as `failed`, or null. */
  contradiction: SuccessContradiction | null;
}

/**
 * Store the end of a recovery (9.8) and audit it: the verification report and the warnings
 * redacted, no warning code of the server's own, a `succeeded` the report does not bear out stored
 * as `failed` with the reason as the first warning.
 */
export async function finishRecovery(
  tx: FinishTx,
  input: FinishRecoveryInput,
): Promise<FinishedRecovery> {
  const { recovery, finish, now } = input;
  const { verification, warnings: reported } = redactRecoveryFinish(finish);
  const contradiction =
    finish.status === "succeeded"
      ? await reportedSuccessContradiction(tx, recovery.endpointId, verification)
      : null;
  const { status, warnings } = settleRecoveryFinish(finish.status, reported, contradiction);
  await tx
    .update(endpointRecoveries)
    .set({
      status,
      verification,
      warnings,
      finishedAt: now,
      releasedAt: recovery.releasedAt ?? now,
      updatedAt: now,
    })
    .where(eq(endpointRecoveries.id, recovery.id));
  await input.audit({
    tenantId: recovery.tenantId,
    actor: input.actor.label,
    actorUserId: input.actor.userId,
    ip: input.actor.ip,
    action: RECOVERY_FINISHED_ACTION,
    target: recovery.endpointId,
    targetType: "endpoint",
    details: {
      recoveryId: recovery.id,
      from: recovery.status,
      status,
      ...(contradiction
        ? { reported: finish.status, reason: contradiction.code, checks: contradiction.checks }
        : {}),
      durationSeconds: finish.durationSeconds,
      warnings: finish.warnings.length,
      reportedBy: "iso",
      ...(input.relayedBy ? { relayedBy: input.relayedBy } : {}),
    },
  });
  return { status, contradiction };
}
