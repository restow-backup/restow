import type { Database } from "@restow/db";
import { type Context, Hono } from "hono";
import { config } from "../../../../apps/api/src/config.js";
import { db, providerDb } from "../../../../apps/api/src/db.js";
import type { SessionRouteContribution } from "../../../../apps/api/src/extensions.js";
import { contentDisposition } from "../../../../apps/api/src/features/restore/headers.js";
import { audit } from "../../../../apps/api/src/lib/audit.js";
import { clientIp } from "../../../../apps/api/src/lib/request.js";
import {
  type SessionEnv,
  TENANT_HEADER,
  requireSession,
  resolveTenantAccess,
} from "../../../../apps/api/src/middleware/session.js";
import { parseOrProblem } from "../../../../apps/api/src/schemas.js";
import { capabilityGuard } from "../license/gate.js";
import { type AuditEntryDto, redactAuditEntryForDemo } from "./dto.js";
import { auditCsv, auditJson, collectAuditExport } from "./export.js";
import { mountPath } from "./meta.js";
import {
  chainQuerySchema,
  entryIdParamSchema,
  exportAuditQuerySchema,
  listAuditQuerySchema,
} from "./schemas.js";
import {
  type AuditScope,
  getAuditEntry,
  listAuditActions,
  listAuditEntries,
  selectChains,
  verifyAuditChains,
} from "./service.js";

/**
 * /api/v1/audit — the audit log viewer and its integrity check.
 *
 * Provider admins read every chain (all tenants and the installation chain)
 * and narrow it with `?tenant=<id>|installation`. Everyone else needs the
 * tenant_admin role in the tenant named by `X-Restow-Tenant` (or the
 * session's active organization) and reads that tenant's chain only; end
 * users have no access.
 */

export const auditRoutes = new Hono<SessionEnv>();

auditRoutes.use("*", requireSession);

// Audit data names people, addresses and IPs: never cache it anywhere.
auditRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

async function scopeOf(c: Context<SessionEnv>): Promise<AuditScope> {
  const providerAccess = c.get("providerAccess");
  // The installation-wide log is for provider admins with every tenant; one
  // limited to some reads a tenant's log, like a tenant admin, and only for
  // a tenant in scope (resolveTenantAccess).
  if (c.get("isProviderAdmin") && (providerAccess?.allTenants ?? true)) {
    return { kind: "provider" };
  }
  const { tenant } = await resolveTenantAccess(
    {
      auth: c.get("auth"),
      user: c.get("user"),
      isProviderAdmin: c.get("isProviderAdmin"),
      providerAccess,
      memberships: c.get("memberships"),
    },
    c.req.header(TENANT_HEADER),
    "tenant_admin",
  );
  return { kind: "tenant", tenantId: tenant.id };
}

/**
 * The pool a scope reads on: every chain (and the installation chain, which
 * has no tenant) only on the installation pool, one tenant's chain on the
 * application pool, where Row Level Security holds the boundary as well.
 */
function poolFor(scope: AuditScope): Database {
  return scope.kind === "provider" ? providerDb : db;
}

/** Applied to every entry this route hands back; a no-op outside demo mode. */
function redact(entry: AuditEntryDto): AuditEntryDto {
  return config.demo.enabled ? redactAuditEntryForDemo(entry) : entry;
}

// Static paths first, so they never match as an entry id.

auditRoutes.get("/", async (c) => {
  const query = parseOrProblem(listAuditQuerySchema, c.req.query());
  const scope = await scopeOf(c);
  const selection = selectChains(scope, query.tenant);
  const page = await listAuditEntries(poolFor(scope), selection, query);
  return c.json({ ...page, items: page.items.map(redact) });
});

/** Action of the audit entry an export leaves: who took the log away, and which part of it. */
export const AUDIT_EXPORTED_ACTION = "audit.exported";

// The matching entries as CSV or JSON (with the hashes, oldest first) for an auditor.
auditRoutes.get("/export", async (c) => {
  const { format, ...filters } = parseOrProblem(exportAuditQuerySchema, c.req.query());
  const scope = await scopeOf(c);
  const selection = selectChains(scope, filters.tenant);
  const pool = poolFor(scope);
  const exported = await collectAuditExport(pool, selection, filters, redact);
  const now = new Date();
  const user = c.get("user");
  // Taking the log away is itself on the record, in the chain it was taken from.
  await audit(pool, {
    tenantId: selection.kind === "tenant" ? selection.tenantId : null,
    actor: user.email,
    actorUserId: user.id,
    action: AUDIT_EXPORTED_ACTION,
    target: null,
    targetType: null,
    ip: clientIp(c),
    details: { format, filters, entries: exported.entries.length, truncated: exported.truncated },
  });
  const day = now.toISOString().slice(0, 10);
  const headers = {
    "content-disposition": contentDisposition(`audit-log-${day}.${format}`),
    "cache-control": "no-store",
  };
  if (format === "json") {
    return c.body(JSON.stringify(auditJson(exported, filters, now), null, 2), 200, {
      ...headers,
      "content-type": "application/json; charset=utf-8",
    });
  }
  return c.body(auditCsv(exported.entries), 200, {
    ...headers,
    "content-type": "text/csv; charset=utf-8",
  });
});

auditRoutes.get("/actions", async (c) => {
  const { tenant } = parseOrProblem(chainQuerySchema, c.req.query());
  const scope = await scopeOf(c);
  const selection = selectChains(scope, tenant);
  return c.json({ items: await listAuditActions(poolFor(scope), selection) });
});

auditRoutes.get("/verify", async (c) => {
  const { tenant } = parseOrProblem(chainQuerySchema, c.req.query());
  const scope = await scopeOf(c);
  const selection = selectChains(scope, tenant);
  return c.json(await verifyAuditChains(poolFor(scope), selection));
});

auditRoutes.get("/:id", async (c) => {
  const { id } = parseOrProblem(entryIdParamSchema, c.req.param());
  const scope = await scopeOf(c);
  return c.json(redact(await getAuditEntry(poolFor(scope), scope, id)));
});

/**
 * Mounted under `/api/v1/audit` behind the `audit.log` capability
 * (Business and Service Provider): without it every path answers 404.
 */
export const auditLogRoutes: SessionRouteContribution = {
  path: mountPath,
  guard: capabilityGuard(db, "audit.log"),
  routes: auditRoutes,
};
