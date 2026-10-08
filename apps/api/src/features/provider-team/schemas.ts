import { z } from "zod";
import { PROVIDER_ROLES } from "../../lib/provider-access.js";

/** The most tenants one member can be limited to by hand; "every tenant" has no limit. */
export const MAX_SCOPED_TENANTS = 1000;

const tenantScope = {
  /** Every tenant, including those created later; an owner always has every tenant. */
  allTenants: z.boolean(),
  /** The tenants of a member limited to some; ignored when `allTenants` is true. */
  tenantIds: z.array(z.string().uuid()).max(MAX_SCOPED_TENANTS).default([]),
};

/** POST /provider-team: invite a new provider admin. */
export const inviteMemberSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    name: z.string().trim().min(1).max(120),
    role: z.enum(PROVIDER_ROLES),
    ...tenantScope,
  })
  .strict();
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

/** PATCH /provider-team/:userId: change a member's role or tenants. */
export const updateMemberSchema = z
  .object({
    role: z.enum(PROVIDER_ROLES),
    ...tenantScope,
  })
  .strict();
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export const memberParamSchema = z.object({ userId: z.string().min(1).max(128) });
