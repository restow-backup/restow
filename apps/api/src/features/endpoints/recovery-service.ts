import { timingSafeEqual } from "node:crypto";
import {
  endpointPrefix,
  hashRecoveryCodeProof,
  listWithSizes,
  MIN_RECOVERY_VERSION,
  parseBasicAuthorization,
  RECOVERY_CREDENTIALS_RETRY_MS,
  RECOVERY_IDEMPOTENCY_MS,
  RECOVERY_LOG_MAX_BYTES,
  RECOVERY_REBIND_AFTER_FINISH_MS,
  recoveryMatchCode,
  redactRecoveryLogLines,
  secretMatchesHash,
} from "@restow/core";
import {
  auditLog,
  type EndpointRecovery,
  endpointRecoveries,
  endpointRecoveryLog,
  endpoints,
  tenants,
} from "@restow/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { db, providerDb } from "../../db.js";
import { readSecret } from "../../lib/secrets.js";
import { isUuid, type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { AGENT_UNAUTHORIZED_PROBLEM, FailureTracker } from "./agent-auth.js";
import { raiseTenantEvent } from "./alerts.js";
import { auditEndpoint, ENDPOINT_AUDIT_ACTIONS, recoveryActor } from "./audit.js";
import { compareAgentVersions, isAgentVersion } from "./distribution.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import {
  baremetalSnapshots,
  hardwareSummaryOf,
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
 * code (expired, used, revoked) does not count: whoever holds the proof may learn why it fails,
 * and the tenant's admins learn that it was tried (audit and alert `recovery_code.rejected`).
 */

/** Failed exchanges and session logins per address: 20 in 10 minutes. */
export const recoveryFailures = new FailureTracker(20);

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
    // Another request claimed it a moment ago: answer as for that one (idempotent or used).
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

/** Whether a session may still be heard at `now`: before its expiry, or just after a good finish. */
export function sessionOpen(access: RecoverySessionAccess, now: number): boolean {
  if (access.status === "expired" || access.status === "issued" || access.status === "revoked") {
    return false;
  }
  if (access.expiresAt.getTime() > now) {
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

/** The restic route the ISO reads through, built from the origin the code was issued for. */
export function recoveryRepositoryUrl(origin: string, sessionId: string): string {
  return `rest:${origin.replace(/\/+$/, "")}/agent/recovery/restic/${sessionId}/`;
}

/**
 * The repository credentials (9.5): only while the session is active and not released, once, and
 * once more within five minutes of the first time (a lost answer), each time audited.
 */
export async function issueCredentials(
  access: RecoverySessionAccess,
  ip: string | null,
  now: Date = new Date(),
): Promise<RecoveryCredentials> {
  const prepared = await withTenantTx(db, access.tenantId, async (tx) => {
    const row = await lockSession(tx, access.id);
    if (row.status === "pending_approval") {
      throw new ProblemError(409, "Not released yet", {
        type: ENDPOINT_PROBLEMS.recoveryNotApproved,
        detail: "An administrator has not released this session yet.",
      });
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
    const snapshots = await baremetalSnapshots(tx, access.endpointId);
    const chosen = snapshots.find((snapshot) => snapshot.id === row.snapshotId) ?? null;
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
  const targets = await tenantStorage(db, access.tenantId);
  const prefix = endpointPrefix(access.endpointId);
  const storage = await backendHolding(targets, prefix);
  const index = await listWithSizes(storage, `${prefix}index/`).catch(() => []);
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

function assertReporting(access: RecoverySessionAccess): void {
  if (access.status === "expired") {
    throw sessionEnded();
  }
}

/** The ISO's progress (every 5 s): kept as the session's last one, with its SSH host keys. */
export async function recordProgress(
  access: RecoverySessionAccess,
  input: RecoveryProgressInput,
  now: Date = new Date(),
): Promise<void> {
  assertReporting(access);
  const { sshHostKeys, ...progress } = input;
  await withTenantTx(db, access.tenantId, (tx) =>
    tx
      .update(endpointRecoveries)
      .set({
        progress: { ...progress, updatedAt: now.toISOString() },
        ...(sshHostKeys ? { sshHostKeys } : {}),
        updatedAt: now,
      })
      .where(eq(endpointRecoveries.id, access.id)),
  );
}

/**
 * Lines of the ISO's log: without escape sequences and control characters, redacted, and at most
 * 2 MiB for the whole session; what does not fit is dropped and counted.
 */
export async function appendLog(
  access: RecoverySessionAccess,
  lines: readonly string[],
  now: Date = new Date(),
): Promise<{ accepted: number; dropped: number }> {
  assertReporting(access);
  const cleaned = redactRecoveryLogLines(lines);
  return withTenantTx(db, access.tenantId, async (tx) => {
    const row = await lockSession(tx, access.id);
    let room = RECOVERY_LOG_MAX_BYTES - row.logBytes;
    const kept: string[] = [];
    for (const line of cleaned) {
      const size = Buffer.byteLength(line, "utf8") + 1;
      if (size > room) break;
      kept.push(line);
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
        .set({ logBytes: row.logBytes + bytes, updatedAt: now })
        .where(eq(endpointRecoveries.id, access.id));
    }
    return { accepted: kept.length, dropped: cleaned.length - kept.length };
  });
}

/** An event of the ISO for the audit trail (remote access switched on, a key file made anew). */
export async function recordEvent(
  access: RecoverySessionAccess,
  input: RecoveryEventInput,
  ip: string | null,
): Promise<void> {
  assertReporting(access);
  await withTenantTx(db, access.tenantId, (tx) =>
    auditEndpoint(tx, {
      tenantId: access.tenantId,
      actor: recoveryActor(access.id, ip),
      action:
        input.kind === "remote_access_enabled"
          ? ENDPOINT_AUDIT_ACTIONS.recoveryRemoteAccessEnabled
          : ENDPOINT_AUDIT_ACTIONS.recoveryKeyfileRegenerated,
      endpointId: access.endpointId,
      details: { recoveryId: access.id, ...input.detail, reportedBy: "iso" },
    }),
  );
}

/**
 * The end of the repository access (9.8, 10.13): `active` -> `finishing`. From now on the restic
 * route and the credentials answer 401; progress, log, events and finish stay. Asking again while
 * finishing changes nothing.
 */
export async function releaseSession(
  access: RecoverySessionAccess,
  ip: string | null,
  now: Date = new Date(),
): Promise<{ status: "finishing" }> {
  await withTenantTx(db, access.tenantId, async (tx) => {
    const row = await lockSession(tx, access.id);
    if (row.status === "finishing") {
      return;
    }
    if (row.status === "pending_approval") {
      throw new ProblemError(409, "Not released yet", {
        type: ENDPOINT_PROBLEMS.recoveryNotApproved,
        detail: "An administrator has not released this session yet.",
      });
    }
    if (row.status !== "active") {
      throw sessionEnded();
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
  });
  forgetRecoverySession(access.id);
  return { status: "finishing" };
}

/** The ISO's result (9.8): final, audited; a failed one is alerted. */
export async function finishSession(
  access: RecoverySessionAccess,
  input: RecoveryFinishInput,
  ip: string | null,
  now: Date = new Date(),
): Promise<{ status: string }> {
  await withTenantTx(db, access.tenantId, async (tx) => {
    const row = await lockSession(tx, access.id);
    if (row.status !== "active" && row.status !== "finishing") {
      throw stateConflict(row.status, "Only an active session can finish.");
    }
    await tx
      .update(endpointRecoveries)
      .set({
        status: input.status,
        verification: input.verification,
        warnings: input.warnings,
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
        status: input.status,
        durationSeconds: input.durationSeconds,
        warnings: input.warnings.length,
        reportedBy: "iso",
      },
    });
    if (input.status === "failed") {
      const name = await endpointNameOf(tx, access.endpointId);
      await raiseTenantEvent(tx, {
        tenantId: access.tenantId,
        event: "endpoint.recovery.failed",
        level: "error",
        message: `The recovery of ${name} failed, as the recovery ISO reports.`,
        details: {
          endpointId: access.endpointId,
          objectName: name,
          recoveryId: access.id,
          reason: "reported",
        },
        now,
      });
    }
  });
  forgetRecoverySession(access.id);
  return { status: input.status };
}

/** `rebind` is for a session that finished well, at most 15 minutes ago (10.19). */
export function assertRebindAllowed(access: RecoverySessionAccess, now: number): void {
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
