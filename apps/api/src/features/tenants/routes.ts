import type { Tenant } from "@restow/db";
import { type Context, Hono } from "hono";
import { db, providerDb } from "../../db.js";
import { providerMayEnterTenant } from "../../lib/provider-access.js";
import { clientIp } from "../../lib/request.js";
import { decideTenantAccess } from "../../middleware/rbac.js";
import {
  type SessionEnv,
  assertTenantAdmits,
  requireProviderAdmin,
  requireSession,
} from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import {
  addMemberSchema,
  createTenantSchema,
  invitationParamSchema,
  memberParamSchema,
  replaceNotificationRecipientsSchema,
  replaceTenantContactsSchema,
  tenantIdParamSchema,
  updateMemberSchema,
  updateTenantCustomerSchema,
  updateTenantSchema,
} from "./schemas.js";
import {
  type Actor,
  addMember,
  cancelInvitation,
  createTenant,
  deleteTenant,
  findTenant,
  getTenant,
  listMembers,
  listTenants,
  removeMember,
  replaceTenantContacts,
  replaceTenantNotificationRecipients,
  updateMemberRole,
  updateTenant,
  updateTenantCustomer,
} from "./service.js";

/**
 * /api/v1/tenants — provider-level tenant management plus per-tenant members.
 *
 * Tenant CRUD is reserved for provider admins. Member management is open to the
 * tenant's own admins as well, so a customer can manage who may restore, while
 * the tenant is active; a suspended tenant's members are managed by the provider.
 */

export const tenantsRoutes = new Hono<SessionEnv>();

function actorOf(c: Context<SessionEnv>): Actor {
  const user = c.get("user");
  return {
    id: user.id,
    email: user.email,
    ip: clientIp(c),
    isProviderAdmin: c.get("isProviderAdmin"),
  };
}

/**
 * Load the tenant from `:id` and require tenant-admin (or provider) access to
 * it. A tenant that is not active is closed to its own admins like every
 * other tenant route (middleware/session.ts); the provider keeps full access.
 */
async function tenantForAdmin(c: Context<SessionEnv>): Promise<Tenant> {
  const { id } = parseOrProblem(tenantIdParamSchema, c.req.param());
  const tenant = await findTenant(db, id);
  const membership = tenant?.organizationId
    ? (c.get("memberships").find((m) => m.organizationId === tenant.organizationId) ?? null)
    : null;
  const decision = decideTenantAccess({
    isProviderAdmin: c.get("isProviderAdmin"),
    membershipRole: membership?.role ?? null,
    minimumRole: "tenant_admin",
  });
  // Non-members (and unknown ids) get the same answer: nothing to see.
  if (!tenant || (!decision.allowed && decision.reason === "not_a_member")) {
    throw new ProblemError(404, "Tenant not found");
  }
  if (!decision.allowed) {
    throw new ProblemError(403, "Insufficient role", {
      detail: "Managing members requires the tenant_admin role.",
      extensions: { requiredRole: "tenant_admin", role: decision.role },
    });
  }
  assertTenantAdmits(tenant, decision.role);
  return tenant;
}

// --- Tenants (provider admin) ------------------------------------------------

tenantsRoutes.get("/", requireProviderAdmin, async (c) => {
  // A provider admin limited to some tenants (lib/provider-access.ts) sees only those.
  const access = c.get("providerAccess");
  const items = await listTenants(providerDb);
  return c.json({
    items: access ? items.filter((tenant) => providerMayEnterTenant(access, tenant.id)) : items,
  });
});

tenantsRoutes.post("/", requireProviderAdmin, async (c) => {
  const input = await parseJsonBody(c.req, createTenantSchema);
  return c.json(await createTenant(db, providerDb, input, actorOf(c)), 201);
});

tenantsRoutes.get("/:id", requireProviderAdmin, async (c) => {
  const { id } = parseOrProblem(tenantIdParamSchema, c.req.param());
  return c.json(await getTenant(db, id));
});

tenantsRoutes.patch("/:id", requireProviderAdmin, async (c) => {
  const { id } = parseOrProblem(tenantIdParamSchema, c.req.param());
  const patch = await parseJsonBody(c.req, updateTenantSchema);
  return c.json(await updateTenant(db, id, patch, actorOf(c)));
});

tenantsRoutes.delete("/:id", requireProviderAdmin, async (c) => {
  const { id } = parseOrProblem(tenantIdParamSchema, c.req.param());
  return c.json(await deleteTenant(db, id, actorOf(c)), 202);
});

// --- Customer data, contacts and notification recipients (provider admin, tenant wizard) ----

tenantsRoutes.patch("/:id/customer", requireProviderAdmin, async (c) => {
  const { id } = parseOrProblem(tenantIdParamSchema, c.req.param());
  const patch = await parseJsonBody(c.req, updateTenantCustomerSchema);
  return c.json(await updateTenantCustomer(db, providerDb, id, patch, actorOf(c)));
});

tenantsRoutes.put("/:id/contacts", requireProviderAdmin, async (c) => {
  const { id } = parseOrProblem(tenantIdParamSchema, c.req.param());
  const contacts = await parseJsonBody(c.req, replaceTenantContactsSchema);
  return c.json(await replaceTenantContacts(db, id, contacts, actorOf(c)));
});

tenantsRoutes.put("/:id/notification-recipients", requireProviderAdmin, async (c) => {
  const { id } = parseOrProblem(tenantIdParamSchema, c.req.param());
  const recipients = await parseJsonBody(c.req, replaceNotificationRecipientsSchema);
  return c.json(await replaceTenantNotificationRecipients(db, id, recipients, actorOf(c)));
});

// --- Members (provider admin or the tenant's admins) --------------------------

tenantsRoutes.get("/:id/members", requireSession, async (c) => {
  const tenant = await tenantForAdmin(c);
  return c.json(await listMembers(db, tenant));
});

tenantsRoutes.post("/:id/members", requireSession, async (c) => {
  const tenant = await tenantForAdmin(c);
  const input = await parseJsonBody(c.req, addMemberSchema);
  const result = await addMember(db, tenant, input, actorOf(c));
  return c.json(result, result.status === "member" ? 201 : 202);
});

tenantsRoutes.patch("/:id/members/:userId", requireSession, async (c) => {
  const tenant = await tenantForAdmin(c);
  const { userId } = parseOrProblem(memberParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, updateMemberSchema);
  return c.json(await updateMemberRole(db, tenant, userId, input.role, actorOf(c)));
});

tenantsRoutes.delete("/:id/members/:userId", requireSession, async (c) => {
  const tenant = await tenantForAdmin(c);
  const { userId } = parseOrProblem(memberParamSchema, c.req.param());
  await removeMember(db, tenant, userId, actorOf(c));
  return c.body(null, 204);
});

tenantsRoutes.delete("/:id/invitations/:invitationId", requireSession, async (c) => {
  const tenant = await tenantForAdmin(c);
  const { invitationId } = parseOrProblem(invitationParamSchema, c.req.param());
  await cancelInvitation(db, tenant, invitationId, actorOf(c));
  return c.body(null, 204);
});
