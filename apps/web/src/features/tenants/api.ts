import { apiFetch } from "@/lib/api";

import {
  decodeAddMemberResult,
  decodeContactList,
  decodeMemberList,
  decodeRecipientList,
  decodeTenant,
  decodeTenantCustomer,
  decodeTenantDetail,
  decodeTenantHealth,
  decodeTenantList,
  decodeUsageOverview,
} from "./decoders";
import type {
  AddMemberInput,
  AddMemberResult,
  CreateTenantInput,
  MemberList,
  NotificationRecipient,
  NotificationRecipientInput,
  TenantContact,
  TenantContactInput,
  TenantCustomer,
  TenantDetail,
  TenantHealth,
  TenantItem,
  UpdateTenantCustomerInput,
  UpdateTenantInput,
  UsageOverview,
} from "./types";

/**
 * Typed calls for tenant management: `/api/v1/tenants` (provider admins; the
 * member routes also for the tenant's own admins), `/api/v1/usage` for the
 * protected mailboxes, and `/api/v1/verify/latest` per tenant for the
 * readiness column. Tenant management is installation-wide, so these calls
 * send no tenant header unless they target one tenant's data explicitly.
 */

/**
 * Query keys. Everything lives under `["tenants"]`, the key the session
 * already uses for the provider's tenant list, so one invalidation refreshes
 * the switcher and these pages together.
 */
export const tenantKeys = {
  all: ["tenants"] as const,
  list: ["tenants", "list"] as const,
  detail: (tenantId: string) => ["tenants", "detail", tenantId] as const,
  members: (tenantId: string) => ["tenants", "members", tenantId] as const,
  health: (tenantId: string) => ["tenants", "health", tenantId] as const,
  usage: ["tenants", "usage"] as const,
};

const base = "/tenants";

function tenantPath(tenantId: string, suffix = ""): string {
  return `${base}/${encodeURIComponent(tenantId)}${suffix}`;
}

const noTenant = { tenantId: null } as const;

export async function fetchTenantList(): Promise<TenantItem[]> {
  return decodeTenantList(await apiFetch<unknown>(base, noTenant));
}

export async function fetchTenantDetail(tenantId: string): Promise<TenantDetail> {
  return decodeTenantDetail(await apiFetch<unknown>(tenantPath(tenantId), noTenant));
}

export async function createTenant(input: CreateTenantInput): Promise<TenantItem> {
  return decodeTenant(await apiFetch<unknown>(base, { ...noTenant, method: "POST", body: input }));
}

export async function updateTenant(
  tenantId: string,
  patch: UpdateTenantInput,
): Promise<TenantItem> {
  return decodeTenant(
    await apiFetch<unknown>(tenantPath(tenantId), { ...noTenant, method: "PATCH", body: patch }),
  );
}

export async function updateTenantCustomer(
  tenantId: string,
  patch: UpdateTenantCustomerInput,
): Promise<TenantCustomer> {
  return decodeTenantCustomer(
    await apiFetch<unknown>(tenantPath(tenantId, "/customer"), {
      ...noTenant,
      method: "PATCH",
      body: patch,
    }),
  );
}

/** Replaces the whole contact list in one call (simpler and safer than per-row edits). */
export async function replaceTenantContacts(
  tenantId: string,
  contacts: TenantContactInput[],
): Promise<TenantContact[]> {
  return decodeContactList(
    await apiFetch<unknown>(tenantPath(tenantId, "/contacts"), {
      ...noTenant,
      method: "PUT",
      body: contacts,
    }),
  );
}

/** Replaces the whole notification recipient list in one call. */
export async function replaceTenantNotificationRecipients(
  tenantId: string,
  recipients: NotificationRecipientInput[],
): Promise<NotificationRecipient[]> {
  return decodeRecipientList(
    await apiFetch<unknown>(tenantPath(tenantId, "/notification-recipients"), {
      ...noTenant,
      method: "PUT",
      body: recipients,
    }),
  );
}

/** Marks the tenant for deletion (202); the purge runs as an audited job. */
export async function deleteTenant(tenantId: string): Promise<TenantItem> {
  return decodeTenant(
    await apiFetch<unknown>(tenantPath(tenantId), { ...noTenant, method: "DELETE" }),
  );
}

export async function fetchMembers(tenantId: string): Promise<MemberList> {
  return decodeMemberList(await apiFetch<unknown>(tenantPath(tenantId, "/members"), noTenant));
}

export async function addMember(tenantId: string, input: AddMemberInput): Promise<AddMemberResult> {
  return decodeAddMemberResult(
    await apiFetch<unknown>(tenantPath(tenantId, "/members"), {
      ...noTenant,
      method: "POST",
      body: input,
    }),
  );
}

export async function updateMemberRole(
  tenantId: string,
  userId: string,
  role: AddMemberInput["role"],
): Promise<void> {
  await apiFetch<unknown>(tenantPath(tenantId, `/members/${encodeURIComponent(userId)}`), {
    ...noTenant,
    method: "PATCH",
    body: { role },
  });
}

export async function removeMember(tenantId: string, userId: string): Promise<void> {
  await apiFetch<void>(tenantPath(tenantId, `/members/${encodeURIComponent(userId)}`), {
    ...noTenant,
    method: "DELETE",
  });
}

export async function cancelInvitation(tenantId: string, invitationId: string): Promise<void> {
  await apiFetch<void>(tenantPath(tenantId, `/invitations/${encodeURIComponent(invitationId)}`), {
    ...noTenant,
    method: "DELETE",
  });
}

export async function fetchUsageOverview(): Promise<UsageOverview> {
  return decodeUsageOverview(await apiFetch<unknown>("/usage", noTenant));
}

/** Readiness of one tenant, requested in that tenant's context. */
export async function fetchTenantHealth(tenantId: string): Promise<TenantHealth> {
  return decodeTenantHealth(await apiFetch<unknown>("/verify/latest", { tenantId }));
}

// --- Notification test mail (installation settings' transport) -----------------

/** Why POST /settings/mail/test failed (apps/api/src/features/settings/mail.ts). */
export type MailTestFailureReason =
  | "timeout"
  | "graph_app_missing"
  | "graph_tenant_missing"
  | "transport_error";

export interface MailTestResult {
  ok: boolean;
  transport: "smtp" | "graph";
  recipient: string;
  failure: { reason: MailTestFailureReason; detail: string | null } | null;
}

function decodeMailTestResult(payload: unknown): MailTestResult {
  const raw = (typeof payload === "object" && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  const failure =
    typeof raw.failure === "object" && raw.failure !== null
      ? (raw.failure as { reason?: unknown; detail?: unknown })
      : null;
  return {
    ok: raw.ok === true,
    transport: raw.transport === "graph" ? "graph" : "smtp",
    recipient: typeof raw.recipient === "string" ? raw.recipient : "",
    failure: failure
      ? {
          reason:
            typeof failure.reason === "string" ? (failure.reason as never) : "transport_error",
          detail: typeof failure.detail === "string" ? failure.detail : null,
        }
      : null,
  };
}

/**
 * Send a test notification through the installation's configured mail
 * transport (Settings → Mail), to prove the wizard's recipients are
 * reachable. Provider-admin only, same as the rest of tenant management.
 *
 * Two different kinds of failure reach the caller: an unconfigured transport,
 * or any other request-level problem (forbidden, rate-limited, a server
 * error), throws `ApiError` like every other call in this file — it never
 * ran, so there is nothing to show as a result. A transport that IS
 * configured but fails to send (timeout, a missing Graph app or tenant, a
 * transport error) resolves with an honest `ok: false` and `failure.reason`,
 * because the attempt did happen and the wizard shows why it did not work.
 */
export async function sendNotificationTestMail(to: string): Promise<MailTestResult> {
  return decodeMailTestResult(
    await apiFetch<unknown>("/settings/mail/test", { ...noTenant, method: "POST", body: { to } }),
  );
}
