import {
  canonicalOrigin,
  formatRecoveryCode,
  generateRecoveryCode,
  hashRecoveryCodeProof,
  MAX_RECOVERY_VALIDITY_HOURS,
  parseRecoveryVerification,
  RECOVERY_APPROVAL_TIMEOUT_MS,
  RECOVERY_OPEN_LIMIT,
  type RecoveryVerification,
  recoveryCodeProof,
  recoveryMatchCode,
  spkiCheckOf,
} from "@restow/core";
import {
  type Database,
  type Endpoint,
  type EndpointRecovery,
  type EndpointRecoveryHardware,
  type EndpointRecoveryStatus,
  endpointLayouts,
  endpointRecoveries,
  endpointRecoveryLog,
  endpointReports,
  endpointRuns,
  endpoints,
  user,
} from "@restow/db";
import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { config as appConfig } from "../../config.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { raiseTenantEvent } from "./alerts.js";
import { auditEndpoint, ENDPOINT_AUDIT_ACTIONS, type EndpointActor } from "./audit.js";
import { instanceTls } from "./instance-tls.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import { recoveryIsoState } from "./recovery-iso.js";
import { forgetRecoverySession, holdForRecovery } from "./recovery-session-cache.js";
import type { IssueRecoveryCodeInput } from "./schemas.js";

/**
 * Recovery codes, the admin's side (docs/BAREMETAL.md 9.2, 9.4, 9.9): issue a code for one Linux
 * machine, revoke or extend it, follow and release the session the ISO exchanged it for, reject or
 * end it, and hand the ISO public SSH keys. Every transition writes exactly one audit entry, and a
 * request that changes nothing writes none: each one is a conditional `UPDATE ... WHERE status =
 * ... RETURNING`, so of two writers (an admin and the monitor, two admins) only one transitions
 * and audits. The ISO's side is recovery-service.ts.
 *
 * Issuing needs the preview switch (RESTOW_BAREMETAL_PREVIEW), a Linux machine that is not
 * removed (a revoked one is fine: it is often the broken one), a backup with a layout whose
 * verdict is not `unsupported`, a verified recovery ISO (`GET /api/v1/recovery-iso`) and fewer
 * than three open codes. The answer carries the code once; the database keeps only the hash of
 * its proof for the instance's origin.
 */

export type BaremetalUnavailableReason =
  | "not_linux"
  | "removed"
  | "no_layout"
  | "unsupported"
  | "iso_unverified"
  | "preview_off"
  | "snapshot_unknown";

function notAvailable(reason: BaremetalUnavailableReason, detail: string): ProblemError {
  return new ProblemError(409, "Bare metal recovery not available", {
    type: ENDPOINT_PROBLEMS.baremetalNotAvailable,
    detail,
    extensions: { reason },
  });
}

export function stateConflict(status: EndpointRecoveryStatus, detail: string): ProblemError {
  return new ProblemError(409, "Not possible in this state", {
    type: ENDPOINT_PROBLEMS.recoveryStateConflict,
    detail,
    extensions: { status },
  });
}

export function sessionEnded(detail = "The recovery session has ended."): ProblemError {
  return new ProblemError(401, "Credential expired", {
    type: ENDPOINT_PROBLEMS.recoverySessionEnded,
    detail,
  });
}

/** Sessions that run: redeemed and not ended (the list and the page say "Being restored"). */
export const RUNNING_RECOVERY_STATES: readonly EndpointRecoveryStatus[] = [
  "pending_approval",
  "active",
  "finishing",
];

/** The running session of a machine, as the list, the page and the bare metal card show it. */
export interface ActiveRecoveryDto {
  id: string;
  status: EndpointRecoveryStatus;
  phase: string | null;
}

/** The newest running session of each machine (`RUNNING_RECOVERY_STATES`). */
export async function activeRecoveriesOf(
  tx: Transaction,
  endpointIds: readonly string[],
): Promise<Map<string, ActiveRecoveryDto>> {
  const out = new Map<string, ActiveRecoveryDto>();
  if (endpointIds.length === 0) {
    return out;
  }
  const rows = await tx
    .select({
      id: endpointRecoveries.id,
      endpointId: endpointRecoveries.endpointId,
      status: endpointRecoveries.status,
      progress: endpointRecoveries.progress,
    })
    .from(endpointRecoveries)
    .where(
      and(
        inArray(endpointRecoveries.endpointId, [...endpointIds]),
        inArray(endpointRecoveries.status, [...RUNNING_RECOVERY_STATES]),
        // A boot probe of the lab is no recovery of the machine (docs/BAREMETAL.md 12.3).
        eq(endpointRecoveries.kind, "code"),
      ),
    )
    .orderBy(desc(endpointRecoveries.issuedAt));
  for (const row of rows) {
    if (!out.has(row.endpointId)) {
      out.set(row.endpointId, {
        id: row.id,
        status: row.status,
        phase: row.progress?.phase ?? null,
      });
    }
  }
  return out;
}

/** Codes and sessions that are still open (count against the limit, can be extended). */
export const OPEN_RECOVERY_STATES: readonly EndpointRecoveryStatus[] = [
  "issued",
  "pending_approval",
  "active",
  "finishing",
];

export interface RecoveryHardwareSummary {
  firmware: "uefi" | "bios";
  secureBoot: boolean | null;
  ramBytes: number;
  disks: number;
  diskBytes: number;
  nics: number;
}

export function hardwareSummaryOf(
  hardware: EndpointRecoveryHardware | null,
): RecoveryHardwareSummary | null {
  if (!hardware) {
    return null;
  }
  return {
    firmware: hardware.firmware,
    secureBoot: hardware.secureBoot,
    ramBytes: hardware.ramBytes,
    disks: hardware.disks.length,
    diskBytes: hardware.disks.reduce((sum, disk) => sum + disk.sizeBytes, 0),
    nics: hardware.nics.length,
  };
}

/** One code and its session as the web app sees it: never the code, its hash or a secret hash. */
export interface RecoveryDto {
  id: string;
  kind: "code";
  status: EndpointRecoveryStatus;
  issuedAt: string;
  expiresAt: string;
  createdBy: { id: string; name: string } | null;
  requireApproval: boolean;
  snapshotId: string | null;
  instanceOrigin: string | null;
  spkiCheck: string | null;
  usedAt: string | null;
  usedIp: string | null;
  matchCode: string | null;
  recoveryVersion: string | null;
  approvedAt: string | null;
  approvedBy: { id: string; name: string } | null;
  credentialsIssuedAt: string | null;
  releasedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  phase: string | null;
  hardwareSummary: RecoveryHardwareSummary | null;
}

export interface RecoveryDetailDto extends RecoveryDto {
  /** All of this is reported by the ISO. */
  hardware: EndpointRecoveryHardware | null;
  progress: EndpointRecovery["progress"];
  sshKeys: string[];
  sshHostKeys: { type: string; fingerprint: string }[];
  /**
   * The ISO's verification report (`restow-verify-v1`, docs/BAREMETAL.md 10.17) as far as it
   * parses; null when there is none or it does not (the raw value is never handed out).
   */
  verification: RecoveryVerification | null;
  warnings: { code: string; message: string }[];
  /** `next`: the cursor of the next page (`logAfter`), or null. */
  log: { items: { id: string; at: string; lines: string[] }[]; next: string | null };
}

export interface IssuedRecoveryCodeDto {
  id: string;
  /** Shown once, never stored. */
  code: string;
  expiresAt: string;
  instanceOrigin: string;
  instanceOriginConfigured: boolean;
  spkiCheck: string | null;
  snapshotId: string;
  requireApproval: boolean;
  iso: { version: string | null; url: string | null; sha256: string | null; verified: boolean };
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

async function userNames(
  tx: Transaction,
  ids: readonly (string | null)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(inArray(user.id, wanted));
  return new Map(rows.map((row) => [row.id, row.name?.trim() || row.email]));
}

export function toRecoveryDto(row: EndpointRecovery, names: Map<string, string>): RecoveryDto {
  const person = (id: string | null) => (id ? { id, name: names.get(id) ?? "" } : null);
  return {
    id: row.id,
    kind: "code",
    status: row.status,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    createdBy: person(row.createdBy),
    requireApproval: row.requireApproval,
    snapshotId: row.snapshotId,
    instanceOrigin: row.instanceOrigin,
    spkiCheck: spkiCheckOf(row.spkiSha256),
    usedAt: iso(row.usedAt),
    usedIp: row.usedIp,
    matchCode: row.sessionSecretHash ? recoveryMatchCode(row.sessionSecretHash) : null,
    recoveryVersion: row.recoveryVersion,
    approvedAt: iso(row.approvedAt),
    approvedBy: person(row.approvedBy),
    credentialsIssuedAt: iso(row.credentialsIssuedAt),
    releasedAt: iso(row.releasedAt),
    finishedAt: iso(row.finishedAt),
    cancelRequestedAt: iso(row.cancelRequestedAt),
    phase: row.progress?.phase ?? null,
    hardwareSummary: hardwareSummaryOf(row.hardware),
  };
}

async function dtoOf(tx: Transaction, row: EndpointRecovery): Promise<RecoveryDto> {
  return toRecoveryDto(row, await userNames(tx, [row.createdBy, row.approvedBy]));
}

/** A whole machine snapshot of the endpoint: its layout and what stage 1 said about it. */
export interface BaremetalSnapshot {
  id: string;
  time: string;
  layoutId: string;
  layoutSha256: string;
  verdict: string;
  check: "passed" | "failed" | "incomplete" | "none";
  restoreSizes: Record<string, unknown> | null;
  /** From the stage 1 report: what the replacement hardware needs (14.6 step 2). */
  minimumSizes: Record<string, unknown> | null;
  planner: Record<string, unknown> | null;
}

/** The endpoint's good backups with a layout, newest first (at most 50). */
export function baremetalSnapshots(
  tx: Transaction,
  endpointId: string,
): Promise<BaremetalSnapshot[]> {
  return loadBaremetalSnapshots(tx, endpointId, null);
}

/**
 * One good backup of the endpoint with its layout, looked up by its snapshot id and not among the
 * 50 newest: a code binds its snapshot for up to 48 hours, in which a machine with a tight
 * schedule makes more than 50 newer backups (docs/BAREMETAL.md 9.5). Null when the machine has no
 * such backup (any more).
 */
export async function baremetalSnapshot(
  tx: Transaction,
  endpointId: string,
  snapshotId: string,
): Promise<BaremetalSnapshot | null> {
  const [found] = await loadBaremetalSnapshots(tx, endpointId, snapshotId);
  return found ?? null;
}

/** The newest 50 good backups with a layout, or (with `snapshotId`) the newest run of that one. */
async function loadBaremetalSnapshots(
  tx: Transaction,
  endpointId: string,
  snapshotId: string | null,
): Promise<BaremetalSnapshot[]> {
  const runs = await tx
    .select({
      snapshotId: endpointRuns.snapshotId,
      finishedAt: endpointRuns.finishedAt,
      startedAt: endpointRuns.startedAt,
      layoutId: endpointLayouts.id,
      layoutSha256: endpointLayouts.sha256,
      verdict: endpointLayouts.verdict,
    })
    .from(endpointRuns)
    .innerJoin(endpointLayouts, eq(endpointLayouts.id, endpointRuns.layoutId))
    .where(
      and(
        eq(endpointRuns.endpointId, endpointId),
        eq(endpointRuns.kind, "backup"),
        inArray(endpointRuns.status, ["succeeded", "partial"]),
        snapshotId === null
          ? isNotNull(endpointRuns.snapshotId)
          : eq(endpointRuns.snapshotId, snapshotId),
      ),
    )
    .orderBy(desc(endpointRuns.startedAt))
    .limit(snapshotId === null ? 50 : 1);
  const ids = runs.map((run) => run.snapshotId as string);
  const reports =
    ids.length === 0
      ? []
      : await tx
          .select({
            snapshotId: endpointReports.snapshotId,
            readiness: endpointReports.readiness,
            summary: endpointReports.summary,
          })
          .from(endpointReports)
          .where(
            and(
              eq(endpointReports.endpointId, endpointId),
              eq(endpointReports.kind, "baremetal_check"),
              inArray(endpointReports.snapshotId, ids),
            ),
          )
          .orderBy(asc(endpointReports.checkedAt));
  // The newest report of each snapshot wins (ascending order: later ones overwrite).
  const bySnapshot = new Map(reports.map((report) => [report.snapshotId, report]));
  const seen = new Set<string>();
  const out: BaremetalSnapshot[] = [];
  for (const run of runs) {
    const id = run.snapshotId as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const report = bySnapshot.get(id);
    const sizes = report?.summary.restoreSizes;
    const recordOf = (value: unknown) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    out.push({
      id,
      time: (run.finishedAt ?? run.startedAt).toISOString(),
      layoutId: run.layoutId,
      layoutSha256: run.layoutSha256,
      verdict: run.verdict,
      check:
        report?.readiness === "green"
          ? "passed"
          : report?.readiness === "red"
            ? "failed"
            : report?.readiness === "yellow"
              ? "incomplete"
              : "none",
      restoreSizes: recordOf(sizes),
      minimumSizes: recordOf(report?.summary.minimumSizes),
      planner: recordOf(report?.summary.planner),
    });
  }
  return out;
}

async function loadMachine(tx: Transaction, tenantId: string, endpointId: string) {
  const [endpoint] = await tx
    .select()
    .from(endpoints)
    .where(and(eq(endpoints.tenantId, tenantId), eq(endpoints.id, endpointId)))
    .limit(1);
  if (!endpoint || (endpoint.removedAt && endpoint.removal?.state === "done")) {
    throw new ProblemError(404, "Endpoint not found");
  }
  return endpoint;
}

async function loadRecovery(
  tx: Transaction,
  endpointId: string,
  recoveryId: string,
  options: { forUpdate?: boolean } = {},
): Promise<EndpointRecovery> {
  const query = tx
    .select()
    .from(endpointRecoveries)
    .where(
      and(
        eq(endpointRecoveries.endpointId, endpointId),
        eq(endpointRecoveries.id, recoveryId),
        // The sessions of the lab's boot probes are the worker's, never an operator's to change.
        eq(endpointRecoveries.kind, "code"),
      ),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for("update") : await query;
  if (!row) {
    throw new ProblemError(404, "Recovery not found");
  }
  return row;
}

/** Nothing more happens for a session of a removed machine but its end (docs/BAREMETAL.md 9.7). */
function assertNotRemoved(endpoint: Pick<Endpoint, "removedAt">): void {
  if (endpoint.removedAt) {
    throw notAvailable("removed", "This machine was removed; its recovery sessions have ended.");
  }
}

function endpointName(endpoint: Pick<Endpoint, "displayName" | "hostname">): string {
  return endpoint.displayName?.trim() || endpoint.hostname;
}

/** Issue a recovery code (9.2). The route has checked the role and the recent sign-in. */
export async function issueRecoveryCode(
  database: Database,
  tenantId: string,
  endpointId: string,
  input: IssueRecoveryCodeInput,
  actor: EndpointActor,
  instance: { url: string; configured: boolean },
  now: Date = new Date(),
): Promise<IssuedRecoveryCodeDto> {
  if (!appConfig.baremetalPreview) {
    throw notAvailable(
      "preview_off",
      "Bare metal recovery is a preview this installation has not switched on.",
    );
  }
  const { snapshot } = await withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadMachine(tx, tenantId, endpointId);
    if (endpoint.os !== "linux") {
      throw notAvailable("not_linux", "Recovery codes are for Linux machines.");
    }
    if (endpoint.removedAt) {
      throw notAvailable("removed", "The machine was removed from Restow.");
    }
    const snapshots = await baremetalSnapshots(tx, endpointId);
    if (snapshots.length === 0) {
      throw notAvailable("no_layout", "The machine has no whole machine backup with a layout.");
    }
    const chosen = input.snapshotId
      ? snapshots.find((candidate) => candidate.id === input.snapshotId)
      : snapshots[0];
    if (!chosen) {
      throw notAvailable(
        "snapshot_unknown",
        "The snapshot is not a whole machine backup of this machine.",
      );
    }
    if (chosen.verdict === "unsupported") {
      throw notAvailable("unsupported", "The layout of this backup cannot be restored by the ISO.");
    }
    return { snapshot: chosen };
  });
  const isoState = await recoveryIsoState(undefined, instance.url || null);
  if (!isoState.verified) {
    throw notAvailable("iso_unverified", "This installation offers no verified recovery ISO yet.");
  }
  const origin = canonicalOrigin(instance.url, { allowHttp: true });
  if (!origin) {
    throw new ProblemError(503, "Instance address unknown", {
      type: ENDPOINT_PROBLEMS.instanceUnknown,
      detail: "The public address of this installation is not configured.",
    });
  }
  // Outside the transaction: the connection may take its five seconds.
  const spki = appConfig.publicTlsSpki ?? (await instanceTls.measure(origin, { timeoutMs: 5000 }));
  const code = generateRecoveryCode();
  const codeHash = hashRecoveryCodeProof(recoveryCodeProof(origin, code));
  const expiresAt = new Date(now.getTime() + input.validityHours * 60 * 60 * 1000);
  const row = await withTenantTx(database, tenantId, async (tx) => {
    // Serialise issuing for the machine, so two requests cannot both pass the limit.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`recovery:${endpointId}`}))`);
    const [open] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(endpointRecoveries)
      .where(
        and(
          eq(endpointRecoveries.endpointId, endpointId),
          eq(endpointRecoveries.kind, "code"),
          inArray(endpointRecoveries.status, [...OPEN_RECOVERY_STATES]),
          gt(endpointRecoveries.expiresAt, now),
        ),
      );
    if ((open?.count ?? 0) >= RECOVERY_OPEN_LIMIT) {
      throw new ProblemError(409, "Too many open codes", {
        type: ENDPOINT_PROBLEMS.recoveryLimitReached,
        detail: `At most ${RECOVERY_OPEN_LIMIT} recovery codes of a machine can be open at once. Revoke one first.`,
        extensions: { limit: RECOVERY_OPEN_LIMIT },
      });
    }
    const [created] = await tx
      .insert(endpointRecoveries)
      .values({
        tenantId,
        endpointId,
        kind: "code",
        status: "issued",
        codeHash,
        instanceOrigin: origin,
        spkiSha256: spki,
        requireApproval: input.requireApproval,
        snapshotId: snapshot.id,
        issuedAt: now,
        expiresAt,
        createdBy: actor.userId,
        updatedAt: now,
      })
      .returning();
    if (!created) {
      throw new Error("recovery insert returned no row");
    }
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.recoveryCodeCreated,
      endpointId,
      details: {
        recoveryId: created.id,
        kind: "code",
        validityHours: input.validityHours,
        expiresAt: expiresAt.toISOString(),
        snapshotId: snapshot.id,
        requireApproval: input.requireApproval,
        instanceOrigin: origin,
        spkiCheck: spkiCheckOf(spki),
      },
    });
    return created;
  });
  return {
    id: row.id,
    code: formatRecoveryCode(code),
    expiresAt: row.expiresAt.toISOString(),
    instanceOrigin: origin,
    instanceOriginConfigured: instance.configured,
    spkiCheck: spkiCheckOf(spki),
    snapshotId: snapshot.id,
    requireApproval: row.requireApproval,
    iso: {
      version: isoState.version,
      url: isoState.url,
      sha256: isoState.sha256,
      verified: isoState.verified,
    },
  };
}

/** Revoke a code nobody redeemed yet. */
export async function revokeRecoveryCode(
  database: Database,
  tenantId: string,
  endpointId: string,
  recoveryId: string,
  actor: EndpointActor,
  now: Date = new Date(),
): Promise<RecoveryDto> {
  return withTenantTx(database, tenantId, async (tx) => {
    const current = await loadRecovery(tx, endpointId, recoveryId);
    const [row] = await tx
      .update(endpointRecoveries)
      .set({ status: "revoked", revokedAt: now, revokedBy: actor.userId, updatedAt: now })
      .where(and(eq(endpointRecoveries.id, recoveryId), eq(endpointRecoveries.status, "issued")))
      .returning();
    if (!row) {
      throw stateConflict(
        current.status,
        "Only a code nobody redeemed can be revoked; a session is ended with cancel.",
      );
    }
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.recoveryCodeRevoked,
      endpointId,
      details: { recoveryId, kind: "code" },
    });
    return dtoOf(tx, row);
  });
}

/**
 * Extend a code and its session: `expires_at` becomes `now + validityHours` if that is later, but
 * never more than 48 hours after the code was issued (CHECK). An extension that would not move it
 * is refused. The state stays.
 */
export async function extendRecoveryCode(
  database: Database,
  tenantId: string,
  endpointId: string,
  recoveryId: string,
  validityHours: number,
  actor: EndpointActor,
  now: Date = new Date(),
): Promise<RecoveryDto> {
  const row = await withTenantTx(database, tenantId, async (tx) => {
    assertNotRemoved(await loadMachine(tx, tenantId, endpointId));
    const current = await loadRecovery(tx, endpointId, recoveryId, { forUpdate: true });
    if (!OPEN_RECOVERY_STATES.includes(current.status) || current.expiresAt <= now) {
      throw stateConflict(current.status, "Only an open code or session can be extended.");
    }
    const ceiling = current.issuedAt.getTime() + MAX_RECOVERY_VALIDITY_HOURS * 60 * 60 * 1000;
    const wanted = Math.max(current.expiresAt.getTime(), now.getTime() + validityHours * 3600_000);
    const expiresAt = new Date(Math.min(wanted, ceiling));
    if (expiresAt.getTime() <= current.expiresAt.getTime()) {
      throw stateConflict(
        current.status,
        "The code is valid that long already, or has reached 48 hours since it was issued.",
      );
    }
    const [updated] = await tx
      .update(endpointRecoveries)
      .set({ expiresAt, updatedAt: now })
      .where(eq(endpointRecoveries.id, recoveryId))
      .returning();
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.recoveryCodeExtended,
      endpointId,
      details: {
        recoveryId,
        validityHours,
        previousExpiresAt: current.expiresAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    });
    return dtoOf(tx, updated as EndpointRecovery);
  });
  forgetRecoverySession(recoveryId);
  return row;
}

/** The machine's codes and sessions, newest first. */
export async function listRecoveries(
  database: Database,
  tenantId: string,
  endpointId: string,
): Promise<{ items: RecoveryDto[] }> {
  return withTenantTx(database, tenantId, async (tx) => {
    await loadMachine(tx, tenantId, endpointId);
    const rows = await tx
      .select()
      .from(endpointRecoveries)
      .where(
        and(eq(endpointRecoveries.endpointId, endpointId), eq(endpointRecoveries.kind, "code")),
      )
      .orderBy(desc(endpointRecoveries.issuedAt))
      .limit(50);
    const names = await userNames(
      tx,
      rows.flatMap((row) => [row.createdBy, row.approvedBy]),
    );
    return { items: rows.map((row) => toRecoveryDto(row, names)) };
  });
}

/** A page cursor of the log: the time and the id of the last entry. */
function logCursorOf(item: { id: string; at: string } | undefined): string | null {
  return item ? `${item.at}_${item.id}` : null;
}

function parseLogCursor(cursor: string | undefined): { at: string; id: string } | null {
  const match = cursor ? /^(\d{4}-\d\d-\d\dT[\d:.]+Z)_([0-9a-f-]{36})$/.exec(cursor) : null;
  return match ? { at: match[1] as string, id: match[2] as string } : null;
}

/** One code or session with what the ISO reported and a page of its log. */
export async function getRecovery(
  database: Database,
  tenantId: string,
  endpointId: string,
  recoveryId: string,
  page: { logAfter?: string; logLimit: number } = { logLimit: 100 },
): Promise<RecoveryDetailDto> {
  return withTenantTx(database, tenantId, async (tx) => {
    await loadMachine(tx, tenantId, endpointId);
    const row = await loadRecovery(tx, endpointId, recoveryId);
    const after = parseLogCursor(page.logAfter);
    const entries = await tx
      .select()
      .from(endpointRecoveryLog)
      .where(
        and(
          eq(endpointRecoveryLog.recoveryId, recoveryId),
          after
            ? sql`(date_trunc('milliseconds', ${endpointRecoveryLog.createdAt}), ${endpointRecoveryLog.id}) > (${after.at}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(endpointRecoveryLog.createdAt), asc(endpointRecoveryLog.id))
      .limit(page.logLimit + 1);
    const more = entries.length > page.logLimit;
    const items = entries.slice(0, page.logLimit).map((entry) => ({
      id: entry.id,
      at: entry.createdAt.toISOString(),
      lines: entry.lines.split("\n"),
    }));
    return {
      ...(await dtoOf(tx, row)),
      hardware: row.hardware,
      progress: row.progress,
      sshKeys: row.sshKeys ?? [],
      sshHostKeys: row.sshHostKeys ?? [],
      verification: parseRecoveryVerification(row.verification),
      warnings: row.warnings ?? [],
      log: { items, next: more ? logCursorOf(items.at(-1)) : null },
    };
  });
}

/**
 * The 30 minutes for a release ran out (9.4), or the code expired while the session waited
 * (`expired`): fail the session, if it still waits, with one audit entry and the alert. The
 * monitor does the same; whichever comes first transitions.
 */
export async function failUnapproved(
  tx: Transaction,
  row: Pick<EndpointRecovery, "id" | "tenantId" | "endpointId">,
  endpointName: string,
  now: Date,
  reason: "not_approved" | "expired" = "not_approved",
): Promise<boolean> {
  const [failed] = await tx
    .update(endpointRecoveries)
    .set({ status: "failed", finishedAt: now, updatedAt: now })
    .where(
      and(eq(endpointRecoveries.id, row.id), eq(endpointRecoveries.status, "pending_approval")),
    )
    .returning({ id: endpointRecoveries.id });
  if (!failed) {
    return false;
  }
  await auditEndpoint(tx, {
    tenantId: row.tenantId,
    actor: { label: "system", userId: null, ip: null },
    action: ENDPOINT_AUDIT_ACTIONS.recoveryExpired,
    endpointId: row.endpointId,
    details: { recoveryId: row.id, from: "pending_approval", to: "failed", reason },
  });
  await raiseTenantEvent(tx, {
    tenantId: row.tenantId,
    event: "endpoint.recovery.failed",
    level: "error",
    message:
      reason === "expired"
        ? `The recovery of ${endpointName} failed: its code expired before the session was released.`
        : `The recovery of ${endpointName} failed: nobody released the session within 30 minutes.`,
    details: {
      endpointId: row.endpointId,
      objectName: endpointName,
      recoveryId: row.id,
      reason,
    },
    now,
  });
  return true;
}

/**
 * Release a session that waits (9.4): `pending_approval` -> `active`. The repository's shared
 * maintenance lock is held for the transition, so no prune runs while the session starts to read
 * (9.5, 9.7). After the 30 minutes the session has failed instead.
 */
export async function approveRecovery(
  database: Database,
  tenantId: string,
  endpointId: string,
  recoveryId: string,
  actor: EndpointActor,
  now: Date = new Date(),
): Promise<RecoveryDto> {
  const result = await withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadMachine(tx, tenantId, endpointId);
    assertNotRemoved(endpoint);
    const current = await loadRecovery(tx, endpointId, recoveryId);
    if (current.status !== "pending_approval") {
      throw stateConflict(
        current.status,
        "Only a session that waits for its release can be released.",
      );
    }
    if (current.usedAt && now.getTime() - current.usedAt.getTime() > RECOVERY_APPROVAL_TIMEOUT_MS) {
      await failUnapproved(tx, current, endpointName(endpoint), now);
      return { ended: "not_approved" as const };
    }
    if (current.expiresAt <= now) {
      // The code ran out while the session waited: it can no longer be released.
      await failUnapproved(tx, current, endpointName(endpoint), now, "expired");
      return { ended: "expired" as const };
    }
    return { ended: null };
  });
  if (result.ended) {
    forgetRecoverySession(recoveryId);
    throw sessionEnded(
      result.ended === "expired"
        ? "The code expired before the session was released; it has failed."
        : "Nobody released the session within 30 minutes; it has failed.",
    );
  }
  const dto = await holdForRecovery(endpointId, () =>
    withTenantTx(database, tenantId, async (tx) => {
      // Held against a removal that comes at the same moment (removal.ts cancels waiting sessions).
      const [machine] = await tx
        .select({ removedAt: endpoints.removedAt })
        .from(endpoints)
        .where(eq(endpoints.id, endpointId))
        .for("share")
        .limit(1);
      assertNotRemoved({ removedAt: machine?.removedAt ?? null });
      const [row] = await tx
        .update(endpointRecoveries)
        .set({ status: "active", approvedAt: now, approvedBy: actor.userId, updatedAt: now })
        .where(
          and(
            eq(endpointRecoveries.id, recoveryId),
            eq(endpointRecoveries.status, "pending_approval"),
            gt(endpointRecoveries.expiresAt, now),
          ),
        )
        .returning();
      if (!row) {
        const current = await loadRecovery(tx, endpointId, recoveryId);
        throw stateConflict(current.status, "The session no longer waits for its release.");
      }
      await auditEndpoint(tx, {
        tenantId,
        actor,
        action: ENDPOINT_AUDIT_ACTIONS.recoveryApproved,
        endpointId,
        details: {
          recoveryId,
          matchCode: row.sessionSecretHash ? recoveryMatchCode(row.sessionSecretHash) : null,
        },
      });
      return dtoOf(tx, row);
    }),
  );
  forgetRecoverySession(recoveryId);
  return dto;
}

/**
 * Reject a session that waits, or end a running one (9.4, 9.8): `cancelled`. The ISO sees
 * `cancelRequested` with its next poll; its repository access ends at once here and after at most
 * five seconds in every other process.
 */
export async function cancelRecovery(
  database: Database,
  tenantId: string,
  endpointId: string,
  recoveryId: string,
  actor: EndpointActor,
  now: Date = new Date(),
): Promise<RecoveryDto> {
  const dto = await withTenantTx(database, tenantId, async (tx) => {
    // Locked: an approve, release or the monitor at the same moment comes before or after, and the
    // audit names the state the session really left.
    const current = await loadRecovery(tx, endpointId, recoveryId, { forUpdate: true });
    const [row] = await tx
      .update(endpointRecoveries)
      .set({ status: "cancelled", cancelRequestedAt: now, finishedAt: now, updatedAt: now })
      .where(
        and(
          eq(endpointRecoveries.id, recoveryId),
          inArray(endpointRecoveries.status, ["pending_approval", "active", "finishing"]),
        ),
      )
      .returning();
    if (!row) {
      throw stateConflict(
        current.status,
        current.status === "issued"
          ? "Nobody redeemed this code yet; revoke it instead."
          : "The session has ended already.",
      );
    }
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.recoveryCancelled,
      endpointId,
      details: { recoveryId, from: current.status },
    });
    return dtoOf(tx, row);
  });
  forgetRecoverySession(recoveryId);
  return dto;
}

/** Hand the ISO public SSH keys for remote access (10.2), while the code or session is open. */
export async function setRecoverySshKeys(
  database: Database,
  tenantId: string,
  endpointId: string,
  recoveryId: string,
  keys: string[],
  actor: EndpointActor,
  now: Date = new Date(),
): Promise<RecoveryDto> {
  return withTenantTx(database, tenantId, async (tx) => {
    assertNotRemoved(await loadMachine(tx, tenantId, endpointId));
    const current = await loadRecovery(tx, endpointId, recoveryId, { forUpdate: true });
    if (!OPEN_RECOVERY_STATES.includes(current.status)) {
      throw stateConflict(current.status, "The session has ended.");
    }
    const cleaned = [...new Set(keys.map((key) => key.trim().split(/\s+/).join(" ")))];
    const [row] = await tx
      .update(endpointRecoveries)
      .set({ sshKeys: cleaned, updatedAt: now })
      .where(eq(endpointRecoveries.id, recoveryId))
      .returning();
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.configChanged,
      endpointId,
      details: {
        recoverySshKeys: cleaned.length,
        recoveryId,
        keyTypes: cleaned.map((key) => key.split(" ")[0]),
      },
    });
    return dtoOf(tx, row as EndpointRecovery);
  });
}
