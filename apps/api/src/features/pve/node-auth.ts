import { parseBasicAuthorization, secretMatchesHash } from "@restow/core";
import { pveClusters, pveNodes, tenants } from "@restow/db";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { db, providerDb } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { isUuid, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { SlidingWindowRateLimiter } from "../apikeys/rate-limit.js";
import { authFailures } from "../endpoints/agent-auth.js";

/**
 * Authentication of a PVE node (restow-pve): HTTP Basic `nodeId:nodeSecret`
 * over HTTPS, the same scheme and the same failure throttle as the endpoint
 * agent (features/endpoints/agent-auth.ts). The lookup runs on the
 * installation role before a tenant is known; everything afterwards runs in
 * a transaction pinned to the node's tenant. A revoked node and a node of a
 * suspended tenant are refused.
 */

export const NODE_UNAUTHORIZED_PROBLEM = "urn:restow:problem:pve-node-unauthorized";
export const NODE_REVOKED_PROBLEM = "urn:restow:problem:pve-node-revoked";

/** Block uploads are many; 20,000 calls per node and 10 minutes, as for restic. */
export const nodeApiLimiter = new SlidingWindowRateLimiter(20_000, 10 * 60 * 1000);

export interface NodeContext {
  nodeId: string;
  tenantId: string;
  clusterId: string;
  name: string;
  storageId: string;
  ip: string | null;
}

export type NodeEnv = { Variables: { node: NodeContext } };

const DUMMY_HASH = "0".repeat(64);

function unauthorized(c: Context): ProblemError {
  c.header("www-authenticate", 'Basic realm="restow-pve"');
  return new ProblemError(401, "Unauthorized", {
    type: NODE_UNAUTHORIZED_PROBLEM,
    detail: "The node id or node secret is not valid.",
  });
}

export async function authenticateNode(c: Context): Promise<NodeContext> {
  const now = Date.now();
  const ip = clientIp(c);
  const key = ip ?? "unknown";
  if (authFailures.isBlocked(key, now)) {
    throw new ProblemError(429, "Too many requests", {
      type: "urn:restow:problem:rate-limited",
      detail: "Slow down and retry later.",
    });
  }
  const credentials = parseBasicAuthorization(c.req.header("authorization"));
  if (!credentials || !isUuid(credentials.username)) {
    authFailures.record(key, now);
    throw unauthorized(c);
  }
  const [row] = await providerDb
    .select({
      id: pveNodes.id,
      tenantId: pveNodes.tenantId,
      clusterId: pveNodes.clusterId,
      name: pveNodes.name,
      secretHash: pveNodes.secretHash,
      revokedAt: pveNodes.revokedAt,
      storageId: pveClusters.storageId,
      tenantStatus: tenants.status,
    })
    .from(pveNodes)
    .innerJoin(pveClusters, eq(pveClusters.id, pveNodes.clusterId))
    .innerJoin(tenants, eq(tenants.id, pveNodes.tenantId))
    .where(eq(pveNodes.id, credentials.username))
    .limit(1);
  const matches = secretMatchesHash(credentials.password, row?.secretHash ?? DUMMY_HASH);
  if (!row || !matches) {
    authFailures.record(key, now);
    throw unauthorized(c);
  }
  if (row.revokedAt) {
    throw new ProblemError(401, "Node revoked", {
      type: NODE_REVOKED_PROBLEM,
      detail: "This node was revoked in Restow. Enroll it again or uninstall restow-pve.",
    });
  }
  if (row.tenantStatus !== "active") {
    throw new ProblemError(403, "Tenant suspended", {
      detail: "The tenant of this node is currently suspended.",
    });
  }
  const decision = nodeApiLimiter.consume(row.id, now);
  if (!decision.allowed) {
    c.header("retry-after", String(Math.ceil(decision.retryAfterMs / 1000)));
    throw new ProblemError(429, "Too many requests", { type: "urn:restow:problem:rate-limited" });
  }
  return {
    nodeId: row.id,
    tenantId: row.tenantId,
    clusterId: row.clusterId,
    name: row.name,
    storageId: row.storageId,
    ip,
  };
}

const TOUCH_MS = 60_000;
const touched = new Map<string, number>();

async function touch(node: NodeContext, now = Date.now()): Promise<void> {
  if (now - (touched.get(node.nodeId) ?? 0) < TOUCH_MS) {
    return;
  }
  touched.set(node.nodeId, now);
  if (touched.size > 10_000) {
    touched.clear();
  }
  await withTenantTx(db, node.tenantId, (tx) =>
    tx
      .update(pveNodes)
      .set({ lastSeenAt: new Date(now) })
      .where(eq(pveNodes.id, node.nodeId)),
  );
}

export const requireNode: MiddlewareHandler<NodeEnv> = async (c, next) => {
  const node = await authenticateNode(c);
  c.set("node", node);
  await touch(node);
  await next();
};
