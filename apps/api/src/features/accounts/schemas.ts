import { z } from "zod";
import { passwordSchema } from "../../schemas.js";

/**
 * Request schemas for the accounts feature: provisioning a sign-in for a
 * person without Microsoft SSO, and the public set-password exchange.
 */

/** Local copy of the tenant role enum (apps/api/src/middleware/rbac.ts `TenantRole`). */
export const accountRoleSchema = z.enum(["tenant_admin", "tenant_user"]);

export const provisionAccountSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  /** Falls back to the email address when left out. */
  name: z.string().trim().min(1).max(200).optional(),
  role: accountRoleSchema,
});
export type ProvisionAccountInput = z.infer<typeof provisionAccountSchema>;

export const tenantIdParamSchema = z.object({ tenantId: z.string().uuid() });

/** Pending accounts are bounded, not fully paginated (see `service.ts` `listPendingAccounts`). */
export const listAccountsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const accountUserParamSchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().min(1),
});
export type AccountUserParam = z.infer<typeof accountUserParamSchema>;

export const setPasswordTokenParamSchema = z.object({ token: z.string().min(1).max(512) });

/** Same password policy as the emergency password path (apps/api/src/schemas.ts). */
export const setPasswordSchema = z.object({
  token: z.string().min(1).max(512),
  password: passwordSchema,
});
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;
