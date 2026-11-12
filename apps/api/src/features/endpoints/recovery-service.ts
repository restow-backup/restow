import { timingSafeEqual } from "node:crypto";
import {
  endpointPrefix,
  hashRecoveryCodeProof,
  isServerFinishWarningCode,
  listWithSizes,
  MIN_RECOVERY_VERSION,
  parseBasicAuthorization,
  parseRecoveryVerification,
  RECOVERY_CREDENTIALS_RETRY_MS,
  RECOVERY_IDEMPOTENCY_MS,
  RECOVERY_LOG_MAX_BYTES,
  RECOVERY_REBIND_AFTER_FINISH_MS,
  RECOVERY_SILENCE_AFTER_EXPIRY_MS,
  recoveryMatchCode,
  redactAgentLog,
  redactAgentMessage,
  redactRecoveryLogBatch,
  type SuccessContradiction,
  secretMatchesHash,
  successContradiction,
} from "@restow/core";
import {
  auditLog,
  type EndpointRecovery,
  type EndpointRecoveryStatus,
  endpointRecoveries,
  endpointRecoveryLog,
  endpoints,
  tenants,
} from "@restow/db";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { db, providerDb } from "../../db.js";
import { DeniedThrottle } from "../../lib/denied-audit.js";
import { readSecret } from "../../lib/secrets.js";
import { isUuid, type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { AGENT_UNAUTHORIZED_PROBLEM, FailureTracker } from "./agent-auth.js";
import { raiseTenantEvent } from "./alerts.js";
import { auditEndpoint, ENDPOINT_AUDIT_ACTIONS, recoveryActor } from "./audit.js";
import { compareAgentVersions, isAgentVersion } from "./distribution.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import {
  type BaremetalSnapshot,
  baremetalSnapshot,
  baremetalSnapshots,
  hardwareSummaryOf,
  RUNNING_RECOVERY_STATES,
  sessionEnded,
  stateConflict,
} from "./recovery-codes.js";
import {
  forgetRecoverySession,
  holdForRecovery,
  loadRecoverySession,
  type RecoverySessionAccess,
} from "./recovery-session-cache.js";
import { backendHolding, tenantStorage } from "./repository.js";
import type {
  RecoveryEventInput,
  RecoveryExchangeInput,
  RecoveryFinishInput,
  RecoveryProgressInput,
} from "./schemas.js";

/**
 * The recovery ISO's side of a recovery (docs/BAREMETAL.md 9.3 to 9.8): it exchanges a code for a
 * session, waits for its release, collects the repository credentials once, reads through the
 * `reader` restic route, reports progress, log lines and events, gives up its repository access
 * (`release`) and finishes. A session authenticates with HTTP Basic `<sessionId>:<sessionSecret>`;
 * the ISO made the secret itself, the server only knows its SHA-256.
 *
 * Failed exchanges and failed session logins count against the address in their own tracker
 * (`recoveryFailures`), not in the agents' `authFailures`: a machine room behind one NAT must not
 * lock its agents out with typos at the ISO, nor the agents the operator. An exchange with a dead
 * code (expired, used, revoked) does not count there: whoever holds the proof may learn why it
 * fails, and the tenant's admins learn that it was tried (audit and alert `recovery_code.rejected`).
 * A loop with a dead code must neither flood the admins nor the audit log: the audit entry and the
 * alert come once per code, reason and 10 minutes (the next one counts the repeats in between),
 * and an address gets 20 dead-code answers per 10 minutes (`deadCodeAttempts`), then 429.
 *
 * What the ISO reports as free text (progress message, warnings, verification, event detail) is
 * redacted here before it is stored or audited: the ISO's own redaction is not relied on.
 *
 * The ISO's word is not taken for the end either. A finish that reports `succeeded` is stored as
 * such only when the verification report it carries bears that out ({@link finishSession});
 * otherwise the session is `failed` and the rebind stays locked. And a session that has ended
 * (`succeeded`, `failed`, `cancelled`) takes nothing more: progress, log, event, release and
 * finish answer 409, and the first of them is audited, once per session ({@link refuseClosedWrite}).
 */

/** Failed exchanges and session logins per address: 20 in 10 minutes. */
export const recoveryFailures = new FailureTracker(20);

/** Exchanges with a dead code per address: 20 in 10 minutes (apart from `recoveryFailures`). */
export const deadCodeAttempts = new FailureTracker(20);

/** The audit entry and alert of a dead code: once per code, reason and 10 minutes. */
const deadCodeNotices = new DeniedThrottle();
/** Dead-code attempts not audited since the last entry of their code and reason. */
const deadCodeRepeats = new Map<string, number>();

const TEN_MINUTES_MS = 10 * 60 * 1000;
/** Above this many failures per 10 minutes across the installation, the server log hears of it. */
export const RECOVERY_FAILURE_WARN_THRESHOLD = 500;

/**
 * `restow_recovery_exchange_failures_total{reason}`: failed exchanges by reason, since the start of
 * the process. The API has no metrics endpoint yet; the counts are kept here for one to read.
 */
export const recoveryExchangeFailuresTotal = new Map<string, number>();
const installationWindow = { start: 0, count: 0, warned: false };

/** Count a failed exchange or session login for the address and the installation. */
export function recordRecoveryFailure(key: string, reason: string, now: number): void {
  recoveryFailures.record(key, now);
  recoveryExchangeFailuresTotal.set(reason, (recoveryExchangeFailuresTotal.get(reason) ?? 0) + 1);
  if (now - installationWindow.start >= TEN_MINUTES_MS) {
    installationWindow.start = now;
    installationWindow.count = 0;
    installationWindow.warned = false;
  }
  installationWindow.count += 1;
  if (installationWindow.count > RECOVERY_FAILURE_WARN_THRESHOLD && !installationWindow.warned) {
    installationWindow.warned = true;
    console.warn(
      JSON.stringify({
        level: "warn",
        component: "recovery",
        message: "many failed recovery code exchanges across the installation",
        failures: installationWindow.count,
        windowMinutes: 10,
      }),
    );
  }
}

function hashesEqual(a: string | null, b: string): boolean {
  if (!a) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function nameOf(endpoint: { displayName: string | null; hostname: string }): string {
  return endpoint.displayName?.trim() || endpoint.hostname;
}

// ---------------------------------------------------------------------------
// Exchange
// ---------------------------------------------------------------------------

export interface RecoveryExchangeResponse {
  sessionId: string;
  status: "pending_approval" | "active";
  matchCode: string;
  expiresAt: string;
  endpoint: { id: string; hostname: string; displayName: string | null; os: string };
  minRecoveryVersion: string;
}

function exchangeAnswer(
  row: EndpointRecovery,
  endpoint: { id: string; hostname: string; displayName: string | null; os: string },
): RecoveryExchangeResponse {
  return {
    sessionId: row.id,
    status: row.status === "active" ? "active" : "pending_approval",
    matchCode: recoveryMatchCode(row.sessionSecretHash as string),
    expiresAt: row.expiresAt.toISOString(),
    endpoint,
    minRecoveryVersion: MIN_RECOVERY_VERSION,
  };
}

type DeadReason = "expired" | "used" | "revoked";

const DEAD_PROBLEMS: Record<DeadReason, () => ProblemError> = {
  expired: () =>
    new ProblemError(410, "Recovery code expired", {
      type: ENDPOINT_PROBLEMS.recoveryCodeExpired,
      detail: "This recovery code has expired. Ask an administrator for a new one.",
    }),
  revoked: () =>
    new ProblemError(410, "Recovery code revoked", {
      type: ENDPOINT_PROBLEMS.recoveryCodeRevoked,
      detail: "This recovery code was revoked. Ask an administrator for a new one.",
    }),
  used: () =>
    new ProblemError(409, "Recovery code used", {
      type: ENDPOINT_PROBLEMS.recoveryCodeUsed,
      detail: "This recovery code was redeemed already. Ask an administrator for a new one.",
    }),
};

/**
 * Exchange a code for a session (9.3). The proof is looked up by its hash on the installation
 * role; the claim is atomic (`used_at IS NULL`), and a code that needs no release becomes active
 * only while the repository's shared maintenance lock is held (9.5): when it is busy the code stays
 * unused. The same proof with the same session secret answers the same session again (a lost
 * answer), within 15 minutes, while it waits or is active and before `release`.
 */
export async function exchangeRecoveryCode(
  input: RecoveryExchangeInput,
  context: { ip: string | null; failureKey: string },
  now: Date = new Date(),
  attempt = 0,
): Promise<RecoveryExchangeResponse> {
  const codeHash = hashRecoveryCodeProof(input.codeProof);
  const [found] = await providerDb
    .select({
      recovery: endpointRecoveries,
      hostname: endpoints.hostname,
      displayName: endpoints.displayName,
      os: endpoints.os,
      removedAt: endpoints.removedAt,
      tenantStatus: tenants.status,
    })
    .from(endpointRecoveries)
    .innerJoin(endpoints, eq(endpoints.id, endpointRecoveries.endpointId))
    .innerJoin(tenants, eq(tenants.id, endpointRecoveries.tenantId))
    .where(eq(endpointRecoveries.codeHash, codeHash))
    .limit(1);
  if (!found) {
    recordRecoveryFailure(context.failureKey, "unknown", now.getTime());
    throw new ProblemError(401, "Recovery code not valid", {
      type: ENDPOINT_PROBLEMS.recoveryCodeInvalid,
      detail:
        "No recovery code matches. Check the code, and the address: it must be exactly the one the code dialog shows.",
    });
  }
  const row = found.recovery;
  const endpoint = {
    id: row.endpointId,
    hostname: found.hostname,
    displayName: found.displayName,
    os: found.os,
  };
  if (found.tenantStatus !== "active") {
    throw new ProblemError(403, "Tenant suspended", {
      detail: "The tenant of this recovery code is currently suspended.",
    });
  }
  // The version is checked before anything is claimed: an old ISO does not use up the code.
  if (
    !isAgentVersion(input.recoveryVersion) ||
    compareAgentVersions(input.recoveryVersion, MIN_RECOVERY_VERSION) < 0
  ) {
    throw new ProblemError(426, "Recovery ISO too old", {
      type: ENDPOINT_PROBLEMS.recoveryTooOld,
      detail: `This server needs a recovery ISO from version ${MIN_RECOVERY_VERSION}.`,
      extensions: { minRecoveryVersion: MIN_RECOVERY_VERSION },
    });
  }

  let dead: DeadReason | null = null;
  if (row.status === "revoked" || row.revokedAt !== null || found.removedAt !== null) {
    dead = "revoked";
  } else if (row.usedAt !== null) {
    const sameSecret = hashesEqual(row.sessionSecretHash, input.sessionSecretSha256);
    const fresh = now.getTime() - row.usedAt.getTime() <= RECOVERY_IDEMPOTENCY_MS;
    if (
      sameSecret &&
      fresh &&
      (row.status === "pending_approval" || row.status === "active") &&
      row.releasedAt === null
    ) {
      return exchangeAnswer(row, endpoint);
    }
    dead = "used";
  } else if (row.status === "expired" || row.expiresAt <= now || row.status !== "issued") {
    dead = "expired";
  }
  if (dead) {
    const reason = dead;
    const at = now.getTime();
    if (deadCodeAttempts.isBlocked(context.failureKey, at)) {
      throw rateLimited(deadCodeAttempts.retryAfterMs(context.failureKey, at));
    }
    deadCodeAttempts.record(context.failureKey, at);
    const noticeKey = `${row.id}:${reason}`;
    if (!deadCodeNotices.allow(noticeKey, at)) {
      if (deadCodeRepeats.size >= 10_000) deadCodeRepeats.clear();
      deadCodeRepeats.set(noticeKey, (deadCodeRepeats.get(noticeKey) ?? 0) + 1);
      throw DEAD_PROBLEMS[reason]();
    }
    const repeats = deadCodeRepeats.get(noticeKey) ?? 0;
    deadCodeRepeats.delete(noticeKey);
    await withTenantTx(db, row.tenantId, async (tx) => {
      await auditEndpoint(tx, {
        tenantId: row.tenantId,
        actor: recoveryActor(row.id, context.ip),
        action: ENDPOINT_AUDIT_ACTIONS.recoveryCodeRejected,
        endpointId: row.endpointId,
        details: {
          recoveryId: row.id,
          reason,
          ip: context.ip,
          recoveryVersion: input.recoveryVersion,
          ...(repeats > 0 ? { repeats } : {}),
        },
      });
      await raiseTenantEvent(tx, {
        tenantId: row.tenantId,
        event: "endpoint.recovery_code.rejected",
        level: "error",
        message: `A ${reason} recovery code of ${nameOf(endpoint)} was tried${context.ip ? ` from ${context.ip}` : ""}.`,
        details: {
          endpointId: row.endpointId,
          objectName: nameOf(endpoint),
          recoveryId: row.id,
          reason,
          ip: context.ip,
        },
        now,
      });
    });
    throw DEAD_PROBLEMS[reason]();
  }

  const status = row.requireApproval ? "pending_approval" : "active";
  const claim = () =>
    withTenantTx(db, row.tenantId, async (tx) => {
      // The machine is held against its removal until the claim commits: a removal either comes
      // first (and this claim finds it removed) or sees the session (docs/BAREMETAL.md 9.7).
      const [machine] = await tx
        .select({ removedAt: endpoints.removedAt })
        .from(endpoints)
        .where(eq(endpoints.id, row.endpointId))
        .for("share")
        .limit(1);
      if (!machine || machine.removedAt !== null) {
        return null;
      }
      const [claimed] = await tx
        .update(endpointRecoveries)
        .set({
          status,
          usedAt: now,
          usedIp: context.ip,
          sessionSecretHash: input.sessionSecretSha256,
          recoveryVersion: input.recoveryVersion,
          hardware: input.hardware,
          ...(status === "active" ? { approvedAt: now } : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(endpointRecoveries.id, row.id),
            eq(endpointRecoveries.status, "issued"),
            isNull(endpointRecoveries.usedAt),
            isNull(endpointRecoveries.revokedAt),
            gt(endpointRecoveries.expiresAt, now),
          ),
        )
        .returning();
      if (!claimed) {
        return null;
      }
      const summary = hardwareSummaryOf(input.hardware);
      if (row.kind === "probe") {
        // The lab's boot probe (docs/BAREMETAL.md 12.3): audited, but no security event; the
        // worker issued the code itself and rates the probe.
        await auditEndpoint(tx, {
          tenantId: row.tenantId,
          actor: recoveryActor(row.id, context.ip),
          action: ENDPOINT_AUDIT_ACTIONS.bootProbeStarted,
          endpointId: row.endpointId,
          details: {
            recoveryId: row.id,
            recoveryVersion: input.recoveryVersion,
            hardware: summary,
          },
        });
        return claimed;
      }
      await auditEndpoint(tx, {
        tenantId: row.tenantId,
        actor: recoveryActor(row.id, context.ip),
        action: ENDPOINT_AUDIT_ACTIONS.recoveryStarted,
        endpointId: row.endpointId,
        details: {
          recoveryId: row.id,
          status,
          ip: context.ip,
          recoveryVersion: input.recoveryVersion,
          hardware: summary,
        },
      });
      await raiseTenantEvent(tx, {
        tenantId: row.tenantId,
        event: "endpoint.recovery.started",
        level: "error",
        message: row.requireApproval
          ? `A recovery code of ${nameOf(endpoint)} was redeemed${context.ip ? ` from ${context.ip}` : ""}; the session waits for its release.`
          : `A recovery code of ${nameOf(endpoint)} was redeemed${context.ip ? ` from ${context.ip}` : ""}; the session reads the backups.`,
        details: {
          endpointId: row.endpointId,
          objectName: nameOf(endpoint),
          recoveryId: row.id,
          status,
          ip: context.ip,
          recoveryVersion: input.recoveryVersion,
        },
        now,
      });
      return claimed;
    });
  const claimed =
    status === "active" ? await holdForRecovery(row.endpointId, claim) : await claim();
  if (!claimed) {
    // Another request claimed it a moment ago, or the machine was removed: answer as for that one
    // (idempotent, used or revoked).
    if (attempt > 0) {
      throw DEAD_PROBLEMS.used();
    }
    return exchangeRecoveryCode(input, context, now, attempt + 1);
  }
  forgetRecoverySession(claimed.id);
  return exchangeAnswer(claimed, endpoint);
}

// ---------------------------------------------------------------------------
// Session authentication
// ---------------------------------------------------------------------------

const DUMMY_HASH = "0".repeat(64);

function rateLimited(retryAfterMs: number): ProblemError {
  return new ProblemError(429, "Too many requests", {
    type: "urn:restow:problem:rate-limited",
    detail: "Slow down and retry later.",
    extensions: { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) },
  });
}

/**
 * Whether a session may still be heard at `now`: before its expiry; a running one (`active`,
 * `finishing`) also in the 30 minutes after it that the monitor waits before it fails the session,
 * so an ISO still verifying can report and finish (the restic route and the credentials end at
 * `expiresAt` all the same); and a good finish for 15 minutes, for the rebind.
 */
export function sessionOpen(access: RecoverySessionAccess, now: number): boolean {
  if (access.status === "expired" || access.status === "issued" || access.status === "revoked") {
    return false;
  }
  if (access.expiresAt.getTime() > now) {
    return true;
  }
  if (
    (access.status === "active" || access.status === "finishing") &&
    now < access.expiresAt.getTime() + RECOVERY_SILENCE_AFTER_EXPIRY_MS
  ) {
    return true;
  }
  return (
    access.status === "succeeded" &&
    access.finishedAt !== null &&
    now - access.finishedAt.getTime() <= RECOVERY_REBIND_AFTER_FINISH_MS
  );
}

/** The session of a request's Basic credentials, or a 401 / 429. */
export async function authenticateRecoverySession(
  c: Context,
  failureKey: string,
  now: number = Date.now(),
): Promise<RecoverySessionAccess> {
  if (recoveryFailures.isBlocked(failureKey, now)) {
    const wait = recoveryFailures.retryAfterMs(failureKey, now);
    c.header("retry-after", String(Math.ceil(wait / 1000)));
    throw rateLimited(wait);
  }
  const credentials = parseBasicAuthorization(c.req.header("authorization"));
  const refuse = () => {
    recordRecoveryFailure(failureKey, "session", now);
    c.header("www-authenticate", 'Basic realm="restow-recovery"');
    return new ProblemError(401, "Unauthorized", {
      type: AGENT_UNAUTHORIZED_PROBLEM,
      detail: "The recovery session or its secret is not valid.",
    });
  };
  if (!credentials || !isUuid(credentials.username)) {
    throw refuse();
  }
  const access = await loadRecoverySession(credentials.username);
  const matches = secretMatchesHash(credentials.password, access?.secretHash ?? DUMMY_HASH);
  if (!access?.secretHash || !matches) {
    throw refuse();
  }
  if (!access.tenantActive) {
    throw new ProblemError(403, "Tenant suspended", {
      detail: "The tenant of this recovery session is currently suspended.",
    });
  }
  if (access.endpointRemoved || !sessionOpen(access, now)) {
    throw sessionEnded();
  }
  return access;
}

async function lockSession(tx: Transaction, sessionId: string): Promise<EndpointRecovery> {
  const [row] = await tx
    .select()
    .from(endpointRecoveries)
    .where(eq(endpointRecoveries.id, sessionId))
    .for("update")
    .limit(1);
  if (!row) {
    throw sessionEnded();
  }
  return row;
}

async function endpointNameOf(tx: Transaction, endpointId: string): Promise<string> {
  const [row] = await tx
    .select({ hostname: endpoints.hostname, displayName: endpoints.displayName })
    .from(endpoints)
    .where(eq(endpoints.id, endpointId))
    .limit(1);
  return row ? nameOf(row) : endpointId;
}

// ---------------------------------------------------------------------------
// Session routes
// ---------------------------------------------------------------------------

export interface RecoverySessionState {
  sessionId: string;
  status: string;
  expiresAt: string;
  cancelRequested: boolean;
  approved: boolean;
}

export function currentState(access: RecoverySessionAccess): RecoverySessionState {
  return {
    sessionId: access.id,
    status: access.status,
    expiresAt: access.expiresAt.toISOString(),
    cancelRequested: access.cancelRequestedAt !== null,
    approved: access.status !== "pending_approval",
  };
}

export interface RecoveryCredentials {
  repository: { url: string; password: string };
  snapshotId: string | null;
  layoutSha256: string | null;
  snapshots: { id: string; time: string; layoutSha256: string; check: string }[];
  indexBytes: number;
  restoreSizes: Record<string, unknown> | null;
  minRecoveryVersion: string;
}

function notApproved(): ProblemError {
  return new ProblemError(409, "Not released yet", {
    type: ENDPOINT_PROBLEMS.recoveryNotApproved,
    detail: "An administrator has not released this session yet.",
  });
}

/** The backup a code was issued for is no whole machine backup with a layout (any more). */
function snapshotGone(snapshotId: string): ProblemError {
  return new ProblemError(409, "Backup of the code not available", {
    type: ENDPOINT_PROBLEMS.baremetalNotAvailable,
    detail: `The backup this code was issued for (snapshot ${snapshotId.slice(0, 8)}) is no whole machine backup with a layout of this machine any more. Ask an administrator for a new code.`,
    extensions: { reason: "snapshot_unknown", snapshotId },
  });
}

/** The restic route the ISO reads through, built from the origin the code was issued for. */
export function recoveryRepositoryUrl(origin: string, sessionId: string): string {
  return `rest:${origin.replace(/\/+$/, "")}/agent/recovery/restic/${sessionId}/`;
}

/**
 * The repository credentials (9.5): only while the session is active and not released, once, and
 * once more within five minutes of the first time (a lost answer), each time audited. The layout
 * of the code's snapshot comes with them, whatever its age; when the machine has no such backup
 * with a layout any more, the answer is 409 `baremetal-not-available` (`snapshot_unknown`).
 */
export async function issueCredentials(
  access: RecoverySessionAccess,
  ip: string | null,
  now: Date = new Date(),
): Promise<RecoveryCredentials> {
  // An access that has ended for good is refused before the storage is looked at (the state may
  // be up to five seconds old: a release that waits is decided in the transaction below).
  if (
    (access.status !== "active" && access.status !== "pending_approval") ||
    access.releasedAt !== null ||
    access.expiresAt <= now
  ) {
    throw sessionEnded("The session's repository access has ended.");
  }
  // The storage is resolved first: a fetch is counted only for an answer that can be built.
  const targets = await tenantStorage(db, access.tenantId);
  const prefix = endpointPrefix(access.endpointId);
  const storage = await backendHolding(targets, prefix);
  const index = await listWithSizes(storage, `${prefix}index/`).catch(() => []);
  const prepared = await withTenantTx(db, access.tenantId, async (tx) => {
    const row = await lockSession(tx, access.id);
    if (row.status === "pending_approval") {
      throw notApproved();
    }
    if (row.status !== "active" || row.releasedAt !== null || row.expiresAt <= now) {
      throw sessionEnded("The session's repository access has ended.");
    }
    const [handed] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, access.tenantId),
          eq(auditLog.action, ENDPOINT_AUDIT_ACTIONS.recoveryCredentialsIssued),
          eq(auditLog.target, access.endpointId),
          sql`${auditLog.details}->>'recoveryId' = ${access.id}`,
        ),
      );
    const times = handed?.count ?? 0;
    const late =
      row.credentialsIssuedAt !== null &&
      now.getTime() - row.credentialsIssuedAt.getTime() > RECOVERY_CREDENTIALS_RETRY_MS;
    if (times >= 2 || (times === 1 && late)) {
      throw new ProblemError(409, "Credentials collected", {
        type: ENDPOINT_PROBLEMS.recoveryCredentialsCollected,
        detail: "The credentials of this session were collected already.",
      });
    }
    // The code's snapshot is looked up by its id and not among the 50 newest: more than 50 newer
    // backups may exist by now, and without its layout the ISO could not check the manifest it
    // reads. Without that backup nothing is handed out, and no fetch is counted.
    const snapshots = await baremetalSnapshots(tx, access.endpointId);
    let chosen: BaremetalSnapshot | null = null;
    if (row.snapshotId !== null) {
      chosen =
        snapshots.find((snapshot) => snapshot.id === row.snapshotId) ??
        (await baremetalSnapshot(tx, access.endpointId, row.snapshotId));
      if (!chosen) {
        throw snapshotGone(row.snapshotId);
      }
      if (!snapshots.includes(chosen)) {
        snapshots.push(chosen);
      }
    }
    const [endpoint] = await tx
      .select({ repositorySecretId: endpoints.repositorySecretId })
      .from(endpoints)
      .where(eq(endpoints.id, access.endpointId))
      .limit(1);
    const password = endpoint?.repositorySecretId
      ? await readSecret(tx, { id: endpoint.repositorySecretId, tenantId: access.tenantId })
      : null;
    if (password === null) {
      throw new ProblemError(409, "Repository password missing", {
        type: ENDPOINT_PROBLEMS.repositoryUnavailable,
        detail: "The repository password of this machine is not available.",
      });
    }
    if (times === 0) {
      await tx
        .update(endpointRecoveries)
        .set({ credentialsIssuedAt: now, updatedAt: now })
        .where(eq(endpointRecoveries.id, access.id));
    }
    await auditEndpoint(tx, {
      tenantId: access.tenantId,
      actor: recoveryActor(access.id, ip),
      action: ENDPOINT_AUDIT_ACTIONS.recoveryCredentialsIssued,
      endpointId: access.endpointId,
      details: { recoveryId: access.id, snapshotId: row.snapshotId, repeat: times === 1, ip },
    });
    return { row, password, snapshots, chosen };
  });
  return {
    repository: {
      url: recoveryRepositoryUrl(access.instanceOrigin ?? "", access.id),
      password: prepared.password,
    },
    snapshotId: prepared.row.snapshotId,
    layoutSha256: prepared.chosen?.layoutSha256 ?? null,
    snapshots: prepared.snapshots.map((snapshot) => ({
      id: snapshot.id,
      time: snapshot.time,
      layoutSha256: snapshot.layoutSha256,
      check: snapshot.check,
    })),
    indexBytes: index.reduce((sum, entry) => sum + entry.size, 0),
    restoreSizes: prepared.chosen?.restoreSizes ?? null,
    minRecoveryVersion: MIN_RECOVERY_VERSION,
  };
}

/** The public SSH keys an admin put in for the ISO's remote access. */
export async function sshKeysOf(access: RecoverySessionAccess): Promise<{ keys: string[] }> {
  const [row] = await withTenantTx(db, access.tenantId, (tx) =>
    tx
      .select({ keys: endpointRecoveries.sshKeys })
      .from(endpointRecoveries)
      .where(eq(endpointRecoveries.id, access.id))
      .limit(1),
  );
  return { keys: row?.keys ?? [] };
}

/** What the ISO writes to its session: the calls a closed session refuses. */
export type RecoveryWrite = "progress" | "log" | "event" | "release" | "finish";

/** The states a session ends in for good (9.9): nothing is written to it after. */
const CLOSED_STATES: readonly EndpointRecoveryStatus[] = ["succeeded", "failed", "cancelled"];

function isClosed(status: EndpointRecoveryStatus): boolean {
  return CLOSED_STATES.includes(status);
}

/** A write found its session closed (decided on the locked row; refused after the transaction). */
interface ClosedSession {
  closed: EndpointRecoveryStatus;
}

/**
 * Sessions whose refused write this process has audited or found audited: they need no look at
 * the database for the next one. Whether an entry is written is decided there, under the session's
 * row lock, so two processes write one entry between them.
 */
export const refusedWriteNotices = new Set<string>();

/**
 * A closed session takes nothing more from the ISO (9.8, 9.9): its result is final, and neither
 * its progress nor the audit trail may be written by whoever still holds the session secret. The
 * answer is 409 `recovery-state-conflict` with the state; the first refused write of a session is
 * audited (`endpoint.recovery.report_refused`, with the call), every later one is not.
 */
async function refuseClosedWrite(
  access: RecoverySessionAccess,
  status: EndpointRecoveryStatus,
  call: RecoveryWrite,
  ip: string | null,
): Promise<never> {
  if (!refusedWriteNotices.has(access.id)) {
    await withTenantTx(db, access.tenantId, async (tx) => {
      await lockSession(tx, access.id);
      const [known] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, access.tenantId),
            eq(auditLog.action, ENDPOINT_AUDIT_ACTIONS.recoveryReportRefused),
            eq(auditLog.target, access.endpointId),
            sql`${auditLog.details}->>'recoveryId' = ${access.id}`,
          ),
        );
      if ((known?.count ?? 0) === 0) {
        await auditEndpoint(tx, {
          tenantId: access.tenantId,
          actor: recoveryActor(access.id, ip),
          action: ENDPOINT_AUDIT_ACTIONS.recoveryReportRefused,
          endpointId: access.endpointId,
          details: { recoveryId: access.id, status, call, ip },
        });
      }
    });
    if (refusedWriteNotices.size >= 10_000) refusedWriteNotices.clear();
    refusedWriteNotices.add(access.id);
  }
  throw stateConflict(status, "The session has ended; it takes no more reports.");
}

/**
 * The state a write found on the row it holds: null while the session takes reports
 * (`pending_approval`, `active`, `finishing`), the state when it is closed, and 401 for a session
 * that is none (any more).
 */
function closedOn(status: EndpointRecoveryStatus): ClosedSession | null {
  if (RUNNING_RECOVERY_STATES.includes(status)) {
    return null;
  }
  if (isClosed(status)) {
    return { closed: status };
  }
  throw sessionEnded();
}

/** The ISO's progress (every 5 s): kept as the session's last one, with its SSH host keys. */
export async function recordProgress(
  access: RecoverySessionAccess,
  input: RecoveryProgressInput,
  ip: string | null,
  now: Date = new Date(),
): Promise<void> {
  if (isClosed(access.status)) {
    return refuseClosedWrite(access, access.status, "progress", ip);
  }
  const { sshHostKeys, ...progress } = input;
  // The state is asked again by the UPDATE itself: a finish or cancel a moment ago wins.
  const found = await withTenantTx(db, access.tenantId, async (tx) => {
    const [written] = await tx
      .update(endpointRecoveries)
      .set({
        progress: {
          ...progress,
          message: redactAgentMessage(progress.message, 500),
          updatedAt: now.toISOString(),
        },
        ...(sshHostKeys ? { sshHostKeys } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(endpointRecoveries.id, access.id),
          inArray(endpointRecoveries.status, [...RUNNING_RECOVERY_STATES]),
        ),
      )
      .returning({ id: endpointRecoveries.id });
    if (written) {
      return null;
    }
    const [row] = await tx
      .select({ status: endpointRecoveries.status })
      .from(endpointRecoveries)
      .where(eq(endpointRecoveries.id, access.id))
      .limit(1);
    if (!row) {
      throw sessionEnded();
    }
    return closedOn(row.status);
  });
  if (found) {
    return refuseClosedWrite(access, found.closed, "progress", ip);
  }
}

/**
 * Lines of the ISO's log: without escape sequences and control characters, redacted, and at most
 * 2 MiB for the whole session; what does not fit is dropped and counted. A key block masks every
 * line up to its END line, also when the ISO sends it in two calls (`logInKeyBlock`).
 */
export async function appendLog(
  access: RecoverySessionAccess,
  lines: readonly string[],
  ip: string | null,
  now: Date = new Date(),
): Promise<{ accepted: number; dropped: number }> {
  if (isClosed(access.status)) {
    return refuseClosedWrite(access, access.status, "log", ip);
  }
  const result = await withTenantTx(db, access.tenantId, async (tx) => {
    const row = await lockSession(tx, access.id);
    const closed = closedOn(row.status);
    if (closed) {
      return closed;
    }
    let room = RECOVERY_LOG_MAX_BYTES - row.logBytes;
    let inKeyBlock = row.logInKeyBlock;
    const kept: string[] = [];
    for (const raw of lines) {
      const step = redactRecoveryLogBatch([raw], inKeyBlock);
      const line = step.lines[0] as string;
      const size = Buffer.byteLength(line, "utf8") + 1;
      if (size > room) break;
      kept.push(line);
      inKeyBlock = step.inKeyBlock;
      room -= size;
    }
    if (kept.length > 0) {
      const bytes = RECOVERY_LOG_MAX_BYTES - row.logBytes - room;
      await tx.insert(endpointRecoveryLog).values({
        tenantId: access.tenantId,
        recoveryId: access.id,
        lines: kept.join("\n"),
        createdAt: now,
      });
      await tx
        .update(endpointRecoveries)
        .set({ logBytes: row.logBytes + bytes, logInKeyBlock: inKeyBlock, updatedAt: now })
        .where(eq(endpointRecoveries.id, access.id));
    }
    return { accepted: kept.length, dropped: lines.length - kept.length };
  });
  if ("closed" in result) {
    return refuseClosedWrite(access, result.closed, "log", ip);
  }
  return result;
}

/** An event of the ISO for the audit trail (remote access switched on, a key file made anew). */
export async function recordEvent(
  access: RecoverySessionAccess,
  input: RecoveryEventInput,
  ip: string | null,
): Promise<void> {
  if (isClosed(access.status)) {
    return refuseClosedWrite(access, access.status, "event", ip);
  }
  const found = await withTenantTx(db, access.tenantId, async (tx) => {
    const closed = closedOn((await lockSession(tx, access.id)).status);
    if (closed) {
      return closed;
    }
    await auditEndpoint(tx, {
      tenantId: access.tenantId,
      actor: recoveryActor(access.id, ip),
      action:
        input.kind === "remote_access_enabled"
          ? ENDPOINT_AUDIT_ACTIONS.recoveryRemoteAccessEnabled
          : ENDPOINT_AUDIT_ACTIONS.recoveryKeyfileRegenerated,
      endpointId: access.endpointId,
      // The server's own keys come last: the ISO's detail cannot name another session.
      details: { ...redactIsoDetail(input.detail), recoveryId: access.id, reportedBy: "iso" },
    });
    return null;
  });
  if (found) {
    return refuseClosedWrite(access, found.closed, "event", ip);
  }
}

/** The ISO's event detail, each value redacted. */
function redactIsoDetail(detail: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(detail).map(([key, value]) => [key, redactAgentMessage(value, 1024)]),
  );
}

/**
 * A value the ISO reported (the verification report), every string in it redacted line by line
 * (a command's output keeps its lines); below 32 levels the rest is kept as redacted JSON text.
 */
export function redactIsoValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return redactAgentLog(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth > 32) {
    return redactAgentLog(JSON.stringify(value));
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactIsoValue(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactIsoValue(item, depth + 1)]),
  );
}

/**
 * The end of the repository access (9.8, 10.13): `active` -> `finishing`. From now on the restic
 * route and the credentials answer 401; progress, log, events and finish stay. Asking again while
 * finishing changes nothing; a closed session answers 409.
 */
export async function releaseSession(
  access: RecoverySessionAccess,
  ip: string | null,
  now: Date = new Date(),
): Promise<{ status: "finishing" }> {
  const found = await withTenantTx(db, access.tenantId, async (tx) => {
    const row = await lockSession(tx, access.id);
    if (row.status === "finishing") {
      return null;
    }
    if (row.status === "pending_approval") {
      throw notApproved();
    }
    const closed = closedOn(row.status);
    if (closed) {
      return closed;
    }
    await tx
      .update(endpointRecoveries)
      .set({ status: "finishing", releasedAt: now, updatedAt: now })
      .where(eq(endpointRecoveries.id, access.id));
    await auditEndpoint(tx, {
      tenantId: access.tenantId,
      actor: recoveryActor(access.id, ip),
      action: ENDPOINT_AUDIT_ACTIONS.recoveryReleased,
      endpointId: access.endpointId,
      details: { recoveryId: access.id },
    });
    return null;
  });
  if (found) {
    return refuseClosedWrite(access, found.closed, "release", ip);
  }
  forgetRecoverySession(access.id);
  return { status: "finishing" };
}

/** What a finish answers: the state the session ended in, and why it is not the reported one. */
export interface RecoveryFinishResult {
  status: "succeeded" | "failed" | "cancelled";
  /** Only when the server did not take the ISO's word: what it reported, and the reason's code. */
  reported?: "succeeded";
  reason?: SuccessContradiction["code"];
}

/**
 * Why a finish that reports `succeeded` is not stored as one (10.17), or null: the report it
 * carries must parse as `restow-verify-v1`, hold all ten checks, none of them failed, and name a
 * whole machine backup of this machine (the code's or another one the credentials offered). The
 * report is judged as it is stored (redacted), so the state and what the page shows agree.
 */
async function reportedSuccessContradiction(
  tx: Transaction,
  endpointId: string,
  verification: Record<string, unknown>,
): Promise<SuccessContradiction | null> {
  const contradiction = successContradiction(verification);
  if (contradiction) {
    return contradiction;
  }
  const snapshotId = parseRecoveryVerification(verification)?.snapshotId ?? "";
  if (!(await baremetalSnapshot(tx, endpointId, snapshotId))) {
    return { code: "success_snapshot_unknown", checks: [] };
  }
  return null;
}

/**
 * The ISO's result (9.8): final, audited; a failed one is alerted. `succeeded` is the ISO's claim,
 * and it unlocks the rebind (10.19): it is stored only when the verification report bears it out
 * ({@link reportedSuccessContradiction}). Otherwise the session ends as `failed`, with the reason
 * as a warning of the server's own (`SERVER_FINISH_WARNING_CODES`), in the audit entry and in the
 * alert, and the answer says so. A session that has ended already answers 409.
 */
export async function finishSession(
  access: RecoverySessionAccess,
  input: RecoveryFinishInput,
  ip: string | null,
  now: Date = new Date(),
): Promise<RecoveryFinishResult> {
  const outcome = await withTenantTx(
    db,
    access.tenantId,
    async (tx): Promise<RecoveryFinishResult | ClosedSession> => {
      const row = await lockSession(tx, access.id);
      if (isClosed(row.status)) {
        return { closed: row.status };
      }
      if (row.status !== "active" && row.status !== "finishing") {
        throw stateConflict(row.status, "Only an active session can finish.");
      }
      const verification = redactIsoValue(input.verification) as Record<string, unknown>;
      // A code of the server's own is the server's to give: the ISO cannot report it.
      const warnings = input.warnings
        .map((warning) => ({
          code: redactAgentMessage(warning.code, 64),
          message: redactAgentMessage(warning.message, 1000),
        }))
        .filter((warning) => !isServerFinishWarningCode(warning.code));
      const contradiction =
        input.status === "succeeded"
          ? await reportedSuccessContradiction(tx, access.endpointId, verification)
          : null;
      const status = contradiction ? "failed" : input.status;
      if (contradiction) {
        warnings.unshift({ code: contradiction.code, message: contradiction.checks.join(", ") });
      }
      await tx
        .update(endpointRecoveries)
        .set({
          status,
          verification,
          warnings,
          finishedAt: now,
          releasedAt: row.releasedAt ?? now,
          updatedAt: now,
        })
        .where(eq(endpointRecoveries.id, access.id));
      await auditEndpoint(tx, {
        tenantId: access.tenantId,
        actor: recoveryActor(access.id, ip),
        action: ENDPOINT_AUDIT_ACTIONS.recoveryFinished,
        endpointId: access.endpointId,
        details: {
          recoveryId: access.id,
          from: row.status,
          status,
          ...(contradiction
            ? {
                reported: input.status,
                reason: contradiction.code,
                checks: contradiction.checks,
              }
            : {}),
          durationSeconds: input.durationSeconds,
          warnings: input.warnings.length,
          reportedBy: "iso",
        },
      });
      // A failed boot probe is the worker's to rate and announce (baremetal.red), not a failed
      // recovery of the machine.
      if (status === "failed" && access.kind !== "probe") {
        const name = await endpointNameOf(tx, access.endpointId);
        await raiseTenantEvent(tx, {
          tenantId: access.tenantId,
          event: "endpoint.recovery.failed",
          level: "error",
          message: contradiction
            ? `The recovery of ${name} is stored as failed: the recovery ISO reported a success that its verification report does not bear out.`
            : `The recovery of ${name} failed, as the recovery ISO reports.`,
          details: {
            endpointId: access.endpointId,
            objectName: name,
            recoveryId: access.id,
            reason: contradiction ? "not_verified" : "reported",
            ...(contradiction ? { code: contradiction.code, checks: contradiction.checks } : {}),
          },
          now,
        });
      }
      return contradiction
        ? { status: "failed", reported: "succeeded", reason: contradiction.code }
        : { status };
    },
  );
  forgetRecoverySession(access.id);
  if ("closed" in outcome) {
    return refuseClosedWrite(access, outcome.closed, "finish", ip);
  }
  return outcome;
}

/** `rebind` is for a session that finished well, at most 15 minutes ago (10.19). */
export function assertRebindAllowed(access: RecoverySessionAccess, now: number): void {
  if (access.kind === "probe") {
    // A probe restores a copy in the lab: it never takes the machine's place.
    throw stateConflict(access.status, "The session of a boot probe never rebinds the machine.");
  }
  if (
    access.status !== "succeeded" ||
    access.finishedAt === null ||
    now - access.finishedAt.getTime() > RECOVERY_REBIND_AFTER_FINISH_MS
  ) {
    throw stateConflict(
      access.status,
      "A machine is rebound from the ISO only within 15 minutes after a successful recovery.",
    );
  }
}
