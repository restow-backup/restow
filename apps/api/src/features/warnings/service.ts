import {
  type FailureCause,
  type FailureCode,
  SHARE_ITEM_CAUSES,
  UNKNOWN_WARNING_CAUSE,
  acknowledgeRefusal,
  buildCause,
  classifyRunError,
  isFailureCode,
  locateFailedItem,
} from "@restow/core";
import {
  type Database,
  endpointRuns,
  endpoints,
  fileShareRunItems,
  fileShareRuns,
  fileShares,
  itemFailures,
  jobProgress,
  jobs,
  protectedObjects,
  warningAcknowledgements,
} from "@restow/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { config } from "../../config.js";
import { audit } from "../../lib/audit.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { causeToFailureDto, failureDto } from "../failures/dto.js";
import { stateOfJob } from "../history/dto.js";
import { loadGuestProtection } from "../pve/protection.js";
import {
  type AcknowledgeResultDto,
  type FailedItemDto,
  type WarningDetailDto,
  type WarningGroupDto,
  type WarningListDto,
  type WarningRunDto,
  type WarningSummaryDto,
  type WarningTargetDto,
  summaryDto,
} from "./dto.js";
import {
  type WarningFact,
  type WarningTargetKind,
  loadMachineWarnings,
  loadMailWarnings,
  loadShareWarnings,
} from "./state.js";

/**
 * The warnings of a tenant: which protected objects and machines have a backup that went through
 * but left items behind, why, and the acknowledgements of them (packages/core
 * failures/warnings.ts has the rules). Every change runs in the tenant's transaction and is
 * audited.
 */

export const WARNING_AUDIT_ACTIONS = {
  acknowledged: "warning.acknowledged",
  revoked: "warning.acknowledgement_revoked",
} as const;

/** The newest backup runs a detail lists. */
export const DETAIL_RUNS = 10;
/** The failed items a detail lists (the worker keeps at most 200 per run). */
export const DETAIL_ITEMS = 200;
/** The most warnings the list carries. */
export const LIST_LIMIT = 500;
/** The most objects or machines one request acknowledges. */
export const MAX_BULK_TARGETS = 200;

export interface WarningActor {
  userId: string | null;
  label: string;
  ip: string | null;
}

export interface WarningTargetRef {
  kind: WarningTargetKind;
  id: string;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

async function objectTargets(
  tx: Transaction,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, WarningTargetDto>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: protectedObjects.id,
      kind: protectedObjects.kind,
      displayName: protectedObjects.displayName,
      externalId: protectedObjects.externalId,
    })
    .from(protectedObjects)
    .where(and(eq(protectedObjects.tenantId, tenantId), inArray(protectedObjects.id, [...ids])));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        kind: "object" as const,
        id: row.id,
        subjectKind: row.kind,
        name: row.displayName?.trim() || row.externalId,
        detail: row.externalId,
      },
    ]),
  );
}

async function machineTargets(
  tx: Transaction,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, WarningTargetDto>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: endpoints.id,
      hostname: endpoints.hostname,
      displayName: endpoints.displayName,
      os: endpoints.os,
      profile: endpoints.profile,
    })
    .from(endpoints)
    .where(and(eq(endpoints.tenantId, tenantId), inArray(endpoints.id, [...ids])));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        kind: "machine" as const,
        id: row.id,
        subjectKind: row.profile,
        name: row.displayName?.trim() || row.hostname,
        detail: row.os,
      },
    ]),
  );
}

async function shareTargets(
  tx: Transaction,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, WarningTargetDto>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: fileShares.id,
      name: fileShares.name,
      protocol: fileShares.protocol,
      server: fileShares.server,
      shareName: fileShares.shareName,
      exportPath: fileShares.exportPath,
    })
    .from(fileShares)
    .where(and(eq(fileShares.tenantId, tenantId), inArray(fileShares.id, [...ids])));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        kind: "share" as const,
        id: row.id,
        subjectKind: "file_share" as const,
        name: row.name,
        detail:
          row.protocol === "smb"
            ? `\\\\${row.server}\\${row.shareName ?? ""}`
            : `${row.server}:${row.exportPath ?? ""}`,
      },
    ]),
  );
}

async function targetsOf(
  tx: Transaction,
  tenantId: string,
  kind: WarningTargetKind,
  ids: readonly string[],
): Promise<Map<string, WarningTargetDto>> {
  if (kind === "object") return objectTargets(tx, tenantId, ids);
  if (kind === "machine") return machineTargets(tx, tenantId, ids);
  return shareTargets(tx, tenantId, ids);
}

async function factsOf(
  tx: Transaction,
  tenantId: string,
  kind: WarningTargetKind,
  ids: readonly string[],
): Promise<{ facts: Map<string, WarningFact>; targets: Map<string, WarningTargetDto> }> {
  if (kind === "object") {
    const targets = await objectTargets(tx, tenantId, ids);
    return { facts: await loadMailWarnings(tx, tenantId, { ids: [...targets.keys()] }), targets };
  }
  if (kind === "share") {
    const targets = await shareTargets(tx, tenantId, ids);
    return { facts: await loadShareWarnings(tx, tenantId, { ids: [...targets.keys()] }), targets };
  }
  const targets = await machineTargets(tx, tenantId, ids);
  return { facts: await loadMachineWarnings(tx, tenantId, { ids: [...targets.keys()] }), targets };
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/** Warnings that are open or acknowledged, open first, newest first. */
export async function listWarnings(
  db: Database,
  tenantId: string,
  options: { state?: "open" | "acknowledged" | "all" } = {},
): Promise<WarningListDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const mail = await loadMailWarnings(tx, tenantId);
    const machines = await loadMachineWarnings(tx, tenantId);
    // File shares: a backup that left files behind (locked, unreadable) ends "with warnings".
    const shares = await loadShareWarnings(tx, tenantId);
    // VMs and containers of Proxmox VE: a backup of a guest either succeeds or fails (it never
    // leaves items behind), so a guest only ever counts as failed, never as a warning.
    const guests = await loadGuestProtection(tx, tenantId, new Date());
    const failedGuests = guests.guests.filter(
      (guest) => guest.inJob && guest.lastRun?.status === "failed",
    ).length;
    const counts = { open: 0, acknowledged: 0, failed: 0, failedGuests };
    const wanted: WarningFact[] = [];
    for (const fact of [...mail.values(), ...machines.values(), ...shares.values()]) {
      const state = fact.evaluation.state;
      if (state === "open" || state === "acknowledged" || state === "failed") {
        counts[state]++;
      }
      if (
        (state === "open" && options.state !== "acknowledged") ||
        (state === "acknowledged" && options.state !== "open")
      ) {
        wanted.push(fact);
      }
    }
    wanted.sort(
      (a, b) =>
        Number(b.evaluation.state === "open") - Number(a.evaluation.state === "open") ||
        (b.latest?.finishedAt ?? "").localeCompare(a.latest?.finishedAt ?? ""),
    );
    const page = wanted.slice(0, LIST_LIMIT);
    const objectNames = await objectTargets(
      tx,
      tenantId,
      page.filter((fact) => fact.kind === "object").map((fact) => fact.id),
    );
    const machineNames = await machineTargets(
      tx,
      tenantId,
      page.filter((fact) => fact.kind === "machine").map((fact) => fact.id),
    );
    const shareNames = await shareTargets(
      tx,
      tenantId,
      page.filter((fact) => fact.kind === "share").map((fact) => fact.id),
    );
    const names = { object: objectNames, machine: machineNames, share: shareNames };
    const items = page.flatMap((fact): WarningSummaryDto[] => {
      const target = names[fact.kind].get(fact.id);
      return target ? [summaryDto(target, fact)] : [];
    });
    return { items, counts, truncated: wanted.length > page.length };
  });
}

// ---------------------------------------------------------------------------
// One object or machine
// ---------------------------------------------------------------------------

const NOT_FOUND = () => new ProblemError(404, "Object or machine not found");

/** A failure DTO for a cause code alone (no stored example): the catalog's explanation. */
function codeOnlyFailure(code: string, occurredAt: string): ReturnType<typeof causeToFailureDto> {
  const known: FailureCode = isFailureCode(code) ? code : "unknown";
  const cause: FailureCause = buildCause(known);
  const dto = causeToFailureDto(cause, occurredAt);
  // A code of a newer version keeps its name; the client falls back to the generic text.
  return { ...dto, code };
}

function groupsOf(
  counts: Record<string, number>,
  examples: ReadonlyMap<string, FailedItemDto["failure"]>,
  occurredAt: string,
): WarningGroupDto[] {
  return Object.entries(counts)
    .sort(([codeA, a], [codeB, b]) => b - a || codeA.localeCompare(codeB))
    .map(([code, count]) => ({
      failure: examples.get(code) ?? codeOnlyFailure(code, occurredAt),
      count,
    }));
}

async function mailDetail(
  tx: Transaction,
  tenantId: string,
  target: WarningTargetDto,
  fact: WarningFact,
): Promise<WarningDetailDto> {
  const runRows = await tx
    .select({
      id: jobs.id,
      status: jobs.status,
      startedAt: jobs.startedAt,
      completedAt: jobs.completedAt,
      failure: jobs.failure,
      failed: jobProgress.failed,
      summary: jobs.itemFailureSummary,
    })
    .from(jobs)
    .leftJoin(jobProgress, eq(jobProgress.jobId, jobs.id))
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.queue, "backup"),
        eq(jobs.protectedObjectId, target.id),
      ),
    )
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(DETAIL_RUNS);
  const runs: WarningRunDto[] = runRows.map((row) => {
    const failedItems = Math.max(row.failed ?? 0, row.summary?.total ?? 0);
    return {
      id: row.id,
      outcome: stateOfJob(row.status, failedItems),
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.completedAt?.toISOString() ?? null,
      failedItems,
      failure: row.status === "completed" ? null : failureDto(row.failure),
    };
  });

  const focus = fact.latest;
  let items: FailedItemDto[] = [];
  const examples = new Map<string, FailedItemDto["failure"]>();
  if (focus) {
    const rows = await tx
      .select()
      .from(itemFailures)
      .where(and(eq(itemFailures.tenantId, tenantId), eq(itemFailures.jobId, focus.runId)))
      .orderBy(asc(itemFailures.createdAt), asc(itemFailures.id))
      .limit(DETAIL_ITEMS);
    items = rows.map((row) => {
      const failure = failureDto(row.failure);
      const code = failure?.code ?? UNKNOWN_WARNING_CAUSE;
      // The newest example of each cause explains its group.
      examples.set(code, failure ?? examples.get(code) ?? null);
      return {
        ref: row.itemRef.slice(0, 1000),
        location: locateFailedItem(row.itemRef.slice(0, 1000)),
        itemDate: row.itemDate?.toISOString() ?? null,
        failedAt: (row.lastAttemptAt ?? row.createdAt).toISOString(),
        attempts: row.attempts,
        message: row.reason.slice(0, 2000),
        failure,
      };
    });
  }
  return detailOf(target, fact, runs, items, examples);
}

async function machineDetail(
  tx: Transaction,
  tenantId: string,
  target: WarningTargetDto,
  fact: WarningFact,
): Promise<WarningDetailDto> {
  const runRows = await tx
    .select({
      id: endpointRuns.id,
      status: endpointRuns.status,
      startedAt: endpointRuns.startedAt,
      finishedAt: endpointRuns.finishedAt,
      errors: endpointRuns.errors,
      failure: endpointRuns.failure,
    })
    .from(endpointRuns)
    .where(
      and(
        eq(endpointRuns.tenantId, tenantId),
        eq(endpointRuns.kind, "backup"),
        eq(endpointRuns.endpointId, target.id),
      ),
    )
    .orderBy(desc(endpointRuns.startedAt), desc(endpointRuns.id))
    .limit(DETAIL_RUNS);
  const runs: WarningRunDto[] = runRows.map((row) => ({
    id: row.id,
    outcome: row.status === "running" ? "running" : row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    failedItems: (row.errors ?? []).length,
    failure: row.status === "failed" ? failureDto(row.failure) : null,
  }));

  const focus = fact.latest;
  let items: FailedItemDto[] = [];
  const examples = new Map<string, FailedItemDto["failure"]>();
  if (focus) {
    const [run] = await tx
      .select({ errors: endpointRuns.errors, finishedAt: endpointRuns.finishedAt })
      .from(endpointRuns)
      .where(and(eq(endpointRuns.tenantId, tenantId), eq(endpointRuns.id, focus.runId)))
      .limit(1);
    const at = run?.finishedAt?.toISOString() ?? focus.finishedAt;
    items = (run?.errors ?? []).slice(0, DETAIL_ITEMS).map((error) => {
      const failure = causeToFailureDto(classifyRunError(error), at);
      examples.set(failure.code, failure);
      const ref = (error.path ?? "").slice(0, 1000);
      return {
        ref,
        location: locateFailedItem(ref),
        itemDate: null,
        failedAt: at,
        attempts: 1,
        message: error.message.slice(0, 2000),
        failure,
      };
    });
  }
  return detailOf(target, fact, runs, items, examples);
}

/** The run of a share as the warning detail lists it. */
function shareRunOutcome(status: string): WarningRunDto["outcome"] {
  switch (status) {
    case "queued":
      return "queued";
    case "starting":
    case "running":
      return "running";
    case "warning":
      return "partial";
    case "succeeded":
    case "failed":
    case "cancelled":
      return status;
    default:
      return "failed";
  }
}

async function shareDetail(
  tx: Transaction,
  tenantId: string,
  target: WarningTargetDto,
  fact: WarningFact,
): Promise<WarningDetailDto> {
  const runRows = await tx
    .select({
      id: fileShareRuns.id,
      status: fileShareRuns.status,
      startedAt: fileShareRuns.startedAt,
      finishedAt: fileShareRuns.finishedAt,
      itemCount: fileShareRuns.itemCount,
      failure: fileShareRuns.failure,
    })
    .from(fileShareRuns)
    .where(
      and(
        eq(fileShareRuns.tenantId, tenantId),
        eq(fileShareRuns.kind, "backup"),
        eq(fileShareRuns.fileShareId, target.id),
      ),
    )
    .orderBy(desc(fileShareRuns.queuedAt), desc(fileShareRuns.id))
    .limit(DETAIL_RUNS);
  const runs: WarningRunDto[] = runRows.map((row) => ({
    id: row.id,
    outcome: shareRunOutcome(row.status),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    failedItems: row.itemCount,
    failure: row.status === "failed" ? failureDto(row.failure) : null,
  }));

  const focus = fact.latest;
  let items: FailedItemDto[] = [];
  const examples = new Map<string, FailedItemDto["failure"]>();
  if (focus) {
    const rows = await tx
      .select()
      .from(fileShareRunItems)
      .where(
        and(eq(fileShareRunItems.tenantId, tenantId), eq(fileShareRunItems.runId, focus.runId)),
      )
      .orderBy(asc(fileShareRunItems.createdAt), asc(fileShareRunItems.id))
      .limit(DETAIL_ITEMS);
    items = rows.map((row) => {
      const code: FailureCode = SHARE_ITEM_CAUSES[row.code] ?? "share.read_errors";
      const failure = causeToFailureDto(buildCause(code), row.createdAt.toISOString());
      examples.set(failure.code, failure);
      const ref = row.path.slice(0, 1000);
      return {
        ref,
        location: locateFailedItem(ref),
        itemDate: null,
        failedAt: row.createdAt.toISOString(),
        attempts: 1,
        message: (row.message || row.code).slice(0, 2000),
        failure,
      };
    });
  }
  return detailOf(target, fact, runs, items, examples);
}

function detailOf(
  target: WarningTargetDto,
  fact: WarningFact,
  runs: WarningRunDto[],
  items: FailedItemDto[],
  examples: ReadonlyMap<string, FailedItemDto["failure"]>,
): WarningDetailDto {
  const focus = fact.latest;
  const refusal = acknowledgeRefusal(focus);
  return {
    ...summaryDto(target, fact),
    runs,
    focusRunId: focus?.runId ?? null,
    items,
    itemCount: Math.max(focus?.failedItems ?? 0, items.length),
    groups: focus ? groupsOf(fact.causeCounts, examples, focus.finishedAt) : [],
    acknowledge: { allowed: refusal === null, refusal },
    docsUrl: config.docsTroubleshootingUrl,
  };
}

export async function getWarning(
  db: Database,
  tenantId: string,
  kind: WarningTargetKind,
  id: string,
): Promise<WarningDetailDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const { facts, targets } = await factsOf(tx, tenantId, kind, [id]);
    const target = targets.get(id);
    const fact = facts.get(id);
    if (!target || !fact) {
      throw NOT_FOUND();
    }
    if (kind === "share") {
      return shareDetail(tx, tenantId, target, fact);
    }
    return kind === "object"
      ? mailDetail(tx, tenantId, target, fact)
      : machineDetail(tx, tenantId, target, fact);
  });
}

// ---------------------------------------------------------------------------
// Acknowledging and revoking
// ---------------------------------------------------------------------------

/** The acknowledgement row of a target: by its object, machine or share column. */
function ackColumnOf(kind: WarningTargetKind, id: string) {
  if (kind === "object") return eq(warningAcknowledgements.protectedObjectId, id);
  if (kind === "machine") return eq(warningAcknowledgements.endpointId, id);
  return eq(warningAcknowledgements.fileShareId, id);
}

/** The audit log's target type of a warning target. */
function auditTargetType(kind: WarningTargetKind, target: WarningTargetDto): string {
  if (kind === "object") return target.subjectKind;
  return kind === "machine" ? "endpoint" : "file_share";
}

function trimNote(note: string | null | undefined): string | null {
  const value = note?.trim() ?? "";
  return value.length > 0 ? value : null;
}

/**
 * Acknowledge the current warning of each target: the causes of its newest run are accepted.
 * A target without a warning, or whose newest backup failed outright, is skipped with the reason;
 * the others are acknowledged (an earlier acknowledgement is replaced) and audited one by one.
 */
export async function acknowledgeWarnings(
  db: Database,
  tenantId: string,
  input: { targets: readonly WarningTargetRef[]; note?: string | null },
  actor: WarningActor,
): Promise<AcknowledgeResultDto> {
  if (input.targets.length > MAX_BULK_TARGETS) {
    throw new ProblemError(400, "Too many objects", {
      detail: `Acknowledge at most ${MAX_BULK_TARGETS} objects at once.`,
    });
  }
  const note = trimNote(input.note);
  return withTenantTx(db, tenantId, async (tx) => {
    const result: AcknowledgeResultDto = { acknowledged: [], skipped: [] };
    for (const kind of ["object", "machine", "share"] as const) {
      const ids = [
        ...new Set(input.targets.filter((ref) => ref.kind === kind).map((ref) => ref.id)),
      ];
      if (ids.length === 0) continue;
      const { facts, targets } = await factsOf(tx, tenantId, kind, ids);
      for (const id of ids) {
        const target = targets.get(id);
        const fact = facts.get(id);
        if (!target || !fact) {
          result.skipped.push({ kind, id, reason: "not_found" });
          continue;
        }
        const refusal = acknowledgeRefusal(fact.latest);
        if (refusal !== null || !fact.latest) {
          result.skipped.push({ kind, id, reason: refusal ?? "no_warning" });
          continue;
        }
        const now = new Date();
        const values = {
          causes: [...fact.evaluation.causes],
          runId: fact.latest.runId,
          note,
          acknowledgedByUserId: actor.userId,
          acknowledgedBy: actor.label,
          acknowledgedAt: now,
        };
        const where = and(eq(warningAcknowledgements.tenantId, tenantId), ackColumnOf(kind, id));
        const [updated] = await tx
          .update(warningAcknowledgements)
          .set(values)
          .where(where)
          .returning();
        const row =
          updated ??
          (
            await tx
              .insert(warningAcknowledgements)
              .values({
                tenantId,
                ...(kind === "object"
                  ? { protectedObjectId: id }
                  : kind === "machine"
                    ? { endpointId: id }
                    : { fileShareId: id }),
                ...values,
              })
              .returning()
          )[0];
        await audit(tx, {
          tenantId,
          actorUserId: actor.userId,
          actor: actor.label,
          action: WARNING_AUDIT_ACTIONS.acknowledged,
          target: id,
          targetType: auditTargetType(kind, target),
          ip: actor.ip,
          details: {
            name: target.name,
            runId: fact.latest.runId,
            causes: values.causes,
            failedItems: fact.latest.failedItems,
            note,
            replaced: updated !== undefined,
          },
        });
        const refreshed: WarningFact = {
          ...fact,
          ack: row ?? null,
          failedSinceAck: false,
          evaluation: {
            state: "acknowledged",
            causes: fact.evaluation.causes,
            newCauses: [],
            ackSuperseded: false,
          },
        };
        result.acknowledged.push(summaryDto(target, refreshed));
      }
    }
    return result;
  });
}

/** Take an acknowledgement back: the warning counts again. 404 when there is none. */
export async function revokeAcknowledgement(
  db: Database,
  tenantId: string,
  ref: WarningTargetRef,
  actor: WarningActor,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    const targets = await targetsOf(tx, tenantId, ref.kind, [ref.id]);
    const target = targets.get(ref.id);
    if (!target) {
      throw NOT_FOUND();
    }
    const [removed] = await tx
      .delete(warningAcknowledgements)
      .where(and(eq(warningAcknowledgements.tenantId, tenantId), ackColumnOf(ref.kind, ref.id)))
      .returning();
    if (!removed) {
      throw new ProblemError(404, "No acknowledgement to revoke");
    }
    await audit(tx, {
      tenantId,
      actorUserId: actor.userId,
      actor: actor.label,
      action: WARNING_AUDIT_ACTIONS.revoked,
      target: ref.id,
      targetType: auditTargetType(ref.kind, target),
      ip: actor.ip,
      details: {
        name: target.name,
        causes: removed.causes,
        note: removed.note,
        acknowledgedAt: removed.acknowledgedAt.toISOString(),
        acknowledgedBy: removed.acknowledgedBy,
      },
    });
  });
}
