import {
  endpointBudgetBytes,
  endpointPrefix,
  endpointQuotaLimits,
  handleResticRequest,
  measureRepositoryBytes,
  type QuotaUsage,
  type ResticLockRegistry,
  remainingQuotaBytes,
  type StorageBackend,
} from "@restow/core";
import { endpointRepositoryLocks, endpointRuns, endpoints, endpointTasks } from "@restow/db";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db, providerDb } from "../../db.js";
import { DeniedThrottle } from "../../lib/denied-audit.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { admitUpload } from "../run-size/guards.js";
import { runSizeGuards } from "../run-size/instance.js";
import { type RepositorySource, readFromIn, sourceOfTarget } from "../storage/repository-source.js";
import {
  type AgentContext,
  authenticateAgent,
  resticApiLimiter,
  touchEndpoint,
} from "./agent-auth.js";
import { agentActor, auditEndpoint, ENDPOINT_AUDIT_ACTIONS } from "./audit.js";
import { RESTIC_PATH } from "./meta.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import { tenantStorage } from "./repository.js";

/**
 * /agent/restic/:endpointId: the restic REST backend (protocol v2) an agent
 * writes its backups through (docs/AGENT.md). The protocol itself lives in
 * @restow/core (`handleResticRequest`); this route decides who is asking.
 *
 * The caller is always the append-only principal here: it reads everything and
 * adds new objects, nothing else. It can neither overwrite nor delete a
 * backup, and the repository password it holds is of no use for that either,
 * because the write protection is enforced by this server, not by restic.
 * The server's own full-access work (retention, check, browsing, restore
 * tests) does not come through here: it uses a loopback listener that lives
 * for one operation only (@restow/core `withRepository`).
 *
 * Two records are kept on the way (docs/AGENT.md, "Sperren", "Speicherbudget"):
 *
 *   - every lock file the agent writes is recorded, and it may delete only
 *     those; the server's own locks are out of its reach;
 *   - the bytes the repository takes (`endpoints.repository_bytes`), measured
 *     by listing it the first time they are needed and kept current with
 *     every upload and deletion. An upload that does not fit the endpoint's
 *     or the tenant's storage budget is refused (403 endpoint-quota-exceeded);
 *     the refusal is noted on the endpoint, so the monitor can tell the admin.
 *
 * An attempt to do what append-only forbids is audited, throttled to one
 * entry per endpoint and kind of attempt every ten minutes: a machine that
 * tries to delete its backups is worth an admin's attention.
 */
export const resticRoutes = new Hono();

const denials = new DeniedThrottle();

type AgentKey = Pick<AgentContext, "endpointId" | "tenantId">;

/** The lock files this agent wrote, in `endpoint_repository_locks`. */
export function agentLockRegistry(agent: AgentKey): ResticLockRegistry {
  const where = (name: string) =>
    and(
      eq(endpointRepositoryLocks.endpointId, agent.endpointId),
      eq(endpointRepositoryLocks.name, name),
    );
  return {
    isOwn: async (name) =>
      (
        await withTenantTx(db, agent.tenantId, (tx) =>
          tx
            .select({ id: endpointRepositoryLocks.id })
            .from(endpointRepositoryLocks)
            .where(where(name))
            .limit(1),
        )
      ).length > 0,
    created: async (name) => {
      await withTenantTx(db, agent.tenantId, (tx) =>
        tx
          .insert(endpointRepositoryLocks)
          .values({ tenantId: agent.tenantId, endpointId: agent.endpointId, name })
          .onConflictDoNothing(),
      );
    },
    removed: async (name) => {
      await withTenantTx(db, agent.tenantId, (tx) =>
        tx.delete(endpointRepositoryLocks).where(where(name)),
      );
    },
  };
}

/** Measurements in progress, one per endpoint: concurrent uploads wait for the same listing. */
const measuring = new Map<string, Promise<number>>();

/** List the repository once to learn its size, and keep it unless an upload counted first. */
function measureOnce(agent: AgentKey, storage: StorageBackend): Promise<number> {
  const pending = measuring.get(agent.endpointId);
  if (pending) {
    return pending;
  }
  const measured = (async () => {
    const bytes = await measureRepositoryBytes(storage, endpointPrefix(agent.endpointId));
    await withTenantTx(db, agent.tenantId, (tx) =>
      tx
        .update(endpoints)
        .set({ repositoryBytes: bytes, repositoryMeasuredAt: new Date() })
        .where(and(eq(endpoints.id, agent.endpointId), isNull(endpoints.repositoryBytes))),
    );
    return bytes;
  })().finally(() => measuring.delete(agent.endpointId));
  measuring.set(agent.endpointId, measured);
  return measured;
}

/** What the endpoint and its tenant use and may use. */
export async function quotaUsageOf(agent: AgentKey, storage: StorageBackend): Promise<QuotaUsage> {
  const { endpoint, tenantUsed } = await withTenantTx(db, agent.tenantId, async (tx) => {
    const [row] = await tx
      .select({ bytes: endpoints.repositoryBytes, settings: endpoints.settings })
      .from(endpoints)
      .where(eq(endpoints.id, agent.endpointId))
      .limit(1);
    const [total] = await tx
      .select({ bytes: sql<string | null>`sum(${endpoints.repositoryBytes})` })
      .from(endpoints)
      .where(eq(endpoints.tenantId, agent.tenantId));
    return { endpoint: row, tenantUsed: Number(total?.bytes ?? 0) };
  });
  const limits = endpointQuotaLimits();
  let used = endpoint?.bytes ?? null;
  let tenant = tenantUsed;
  if (used === null) {
    used = await measureOnce(agent, storage);
    tenant += used;
  }
  return {
    endpointUsed: used,
    endpointBudget: endpointBudgetBytes(endpoint?.settings, limits),
    tenantUsed: tenant,
    tenantBudget: limits.tenantBytes,
  };
}

/** Count bytes an upload added (or a deletion freed); a size not measured yet is measured later. */
async function addUsage(agent: AgentKey, delta: number): Promise<void> {
  if (delta === 0) {
    return;
  }
  await withTenantTx(db, agent.tenantId, (tx) =>
    tx
      .update(endpoints)
      .set({ repositoryBytes: sql`greatest(0, ${endpoints.repositoryBytes} + ${delta})` })
      .where(and(eq(endpoints.id, agent.endpointId), isNotNull(endpoints.repositoryBytes))),
  );
}

/** A refused upload is noted at most once a minute per endpoint (restic sends several at once). */
const REFUSAL_NOTE_MS = 60_000;
const refusalsNoted = new Map<string, number>();

async function noteRefusal(agent: AgentKey, now: number): Promise<void> {
  if (now - (refusalsNoted.get(agent.endpointId) ?? 0) < REFUSAL_NOTE_MS) {
    return;
  }
  refusalsNoted.set(agent.endpointId, now);
  if (refusalsNoted.size > 10_000) {
    refusalsNoted.clear();
  }
  await withTenantTx(db, agent.tenantId, (tx) =>
    tx
      .update(endpoints)
      .set({ quotaRefusedAt: new Date(now) })
      .where(eq(endpoints.id, agent.endpointId)),
  );
}

/**
 * The target a machine's running restore reads instead of the primary, or null (docs/STORAGE.md,
 * "Restoring from a copy"). The server decided it when the restore task was created: the
 * primary no longer held the repository, a copy target's repository copy did, and the task was
 * given the copy's snapshot id (`params.readFrom`, service.ts `createTask`).
 *
 * Decided by the machine's newest running run alone, read afresh for every request, never by
 * looking at the storage here: the agent runs one run at a time and registers it before it
 * starts restic, so a backup never opens the copy (whose `config` and keys are not the
 * primary's) and then writes with them to the primary, however the primary comes and goes.
 */
async function restoreSourceOf(
  agent: AgentKey,
  run: Awaited<ReturnType<typeof runningRunOf>>,
): Promise<RepositorySource | null> {
  const readFrom = run?.kind === "restore" ? readFromIn(run.params?.readFrom) : null;
  if (!readFrom) {
    return null;
  }
  const source = await sourceOfTarget(agent.tenantId, readFrom.targetId);
  return source?.fallback ? source : null;
}

/**
 * The machine's newest running run: what it restores from ({@link restoreSourceOf}).
 */
async function runningRunOf(agent: AgentKey) {
  // One statement on the installation pool (the agent is authenticated, the tenant is its
  // own); the running runs of a tenant are few (`endpoint_runs_tenant_status_idx`).
  const [run] = await providerDb
    .select({ id: endpointRuns.id, kind: endpointRuns.kind, params: endpointTasks.params })
    .from(endpointRuns)
    .leftJoin(endpointTasks, eq(endpointTasks.id, endpointRuns.taskId))
    .where(
      and(
        eq(endpointRuns.tenantId, agent.tenantId),
        eq(endpointRuns.status, "running"),
        eq(endpointRuns.endpointId, agent.endpointId),
      ),
    )
    .orderBy(desc(endpointRuns.createdAt))
    .limit(1);
  return run ?? null;
}

/**
 * The machine's newest running backup run, whatever else runs beside it (a restore check or a
 * SQL Server check started during a long backup): the run the size and space guard counts the
 * uploads of (#99). The agent authenticates as the machine, not per run, so an upload cannot name
 * its run; while a backup and a native SQL Server backup (`sql`, which writes too) run at the same
 * time, the SQL backup's uploads count towards the backup (more, never less).
 */
async function runningBackupOf(agent: AgentKey) {
  const [run] = await providerDb
    .select({ id: endpointRuns.id })
    .from(endpointRuns)
    .where(
      and(
        eq(endpointRuns.tenantId, agent.tenantId),
        eq(endpointRuns.status, "running"),
        eq(endpointRuns.endpointId, agent.endpointId),
        eq(endpointRuns.kind, "backup"),
      ),
    )
    .orderBy(desc(endpointRuns.createdAt))
    .limit(1);
  return run ?? null;
}

/**
 * A write while the machine restores from another target than the primary: the copy is for
 * restoring, a backup never goes into it. 403, which restic takes as final.
 */
function repositoryNotOnPrimary(source: RepositorySource): ProblemError {
  return new ProblemError(403, "Repository not on the primary storage target", {
    type: ENDPOINT_PROBLEMS.repositoryUnavailable,
    detail: `This machine is restoring from the copy of its repository on ${
      source.target.name ? `"${source.target.name}"` : "another storage target"
    }; nothing is written there. Backups go to the primary storage target once the restore has ended.`,
  });
}

resticRoutes.all("/:endpointId/*", async (c) => {
  const endpointId = c.req.param("endpointId");
  const agent = await authenticateAgent(c, { limiter: resticApiLimiter });
  if (agent.endpointId !== endpointId) {
    throw new ProblemError(403, "Forbidden", {
      detail: "The credentials belong to another endpoint.",
    });
  }
  await touchEndpoint(agent);
  const url = new URL(c.req.url);
  const base = `${RESTIC_PATH}/${endpointId}`;
  const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) || "/" : "/";
  // The primary, as ever. Only a restore whose task was created to read a copy target's
  // repository copy reads that copy, and writes and releases its lock there; nothing else is
  // written meanwhile: a backup must never land in a repository copy.
  const running = await runningRunOf(agent);
  const source = await restoreSourceOf(agent, running);
  if (source && c.req.method === "POST" && !path.startsWith("/locks/")) {
    throw repositoryNotOnPrimary(source);
  }
  const storage = source
    ? source.target.backend
    : (await tenantStorage(db, agent.tenantId)).storage;
  // The size and space guard of backup runs (#99): the uploads of the running backup run, read
  // for uploads only.
  const backup = !source && c.req.method === "POST" ? await runningBackupOf(agent) : null;
  const guard = backup
    ? runSizeGuards.forRun({
        tenantId: agent.tenantId,
        kind: "endpoint",
        objectId: endpointId,
        runId: backup.id,
        storage,
      })
    : null;
  return handleResticRequest(c.req.raw, {
    storage,
    prefix: endpointPrefix(endpointId),
    principal: "agent",
    path,
    query: url.searchParams,
    locks: agentLockRegistry(agent),
    remainingBytes: async () => remainingQuotaBytes(await quotaUsageOf(agent, storage)),
    admitUpload: guard ? (declared, resource) => admitUpload(guard, declared, resource) : undefined,
    onAllowed: async ({ action, bytes }) => {
      if (action === "write") {
        guard?.record(bytes);
        await addUsage(agent, bytes);
      } else if (action === "delete") {
        await addUsage(agent, -bytes);
      }
    },
    onQuotaExceeded: () => noteRefusal(agent, Date.now()),
    onDenied: ({ action, resource, reason }) => {
      const type =
        resource.kind === "object" || resource.kind === "list" ? resource.type : resource.kind;
      if (!denials.allow(`${endpointId}:${action}:${type}:${reason}`, Date.now())) {
        return;
      }
      void auditEndpoint(db, {
        tenantId: agent.tenantId,
        actor: agentActor(agent.hostname, agent.ip),
        action: ENDPOINT_AUDIT_ACTIONS.repositoryDenied,
        endpointId,
        details: { action, type, reason, method: c.req.method },
      }).catch(() => undefined);
    },
  });
});
