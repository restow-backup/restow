import {
  type QuotaUsage,
  type ResticLockRegistry,
  type StorageBackend,
  endpointBudgetBytes,
  endpointPrefix,
  endpointQuotaLimits,
  handleResticRequest,
  measureRepositoryBytes,
  remainingQuotaBytes,
} from "@restow/core";
import { endpointRepositoryLocks, endpoints } from "@restow/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db.js";
import { DeniedThrottle } from "../../lib/denied-audit.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import {
  type AgentContext,
  authenticateAgent,
  resticApiLimiter,
  touchEndpoint,
} from "./agent-auth.js";
import { ENDPOINT_AUDIT_ACTIONS, agentActor, auditEndpoint } from "./audit.js";
import { RESTIC_PATH } from "./meta.js";
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

resticRoutes.all("/:endpointId/*", async (c) => {
  const endpointId = c.req.param("endpointId");
  const agent = await authenticateAgent(c, { limiter: resticApiLimiter });
  if (agent.endpointId !== endpointId) {
    throw new ProblemError(403, "Forbidden", {
      detail: "The credentials belong to another endpoint.",
    });
  }
  await touchEndpoint(agent);
  const { storage } = await tenantStorage(db, agent.tenantId);
  const url = new URL(c.req.url);
  const base = `${RESTIC_PATH}/${endpointId}`;
  const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) || "/" : "/";
  return handleResticRequest(c.req.raw, {
    storage,
    prefix: endpointPrefix(endpointId),
    principal: "agent",
    path,
    query: url.searchParams,
    locks: agentLockRegistry(agent),
    remainingBytes: async () => remainingQuotaBytes(await quotaUsageOf(agent, storage)),
    onAllowed: async ({ action, bytes }) => {
      if (action === "write") {
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
