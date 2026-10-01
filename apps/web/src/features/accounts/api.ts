import { apiFetch } from "@/lib/api";

import {
  decodeLinkCheck,
  decodePendingAccountList,
  decodeProvisionResult,
  decodeRedeemResult,
} from "./decoders";
import type {
  LinkCheckResult,
  ProvisionAccountInput,
  ProvisionResult,
  RedeemResult,
} from "./types";

/**
 * Typed calls for account provisioning (`/api/v1/tenants/:tenantId/accounts`,
 * tenant-admin only) and the public set-password exchange
 * (`/api/v1/accounts/set-password`, no session, no tenant header).
 */

/** These calls are identified by the tenant id in the path, not the active tenant. */
const noTenant = { tenantId: null } as const;

function accountsPath(tenantId: string, suffix = ""): string {
  return `/tenants/${encodeURIComponent(tenantId)}/accounts${suffix}`;
}

export async function fetchPendingAccounts(tenantId: string) {
  return decodePendingAccountList(await apiFetch<unknown>(accountsPath(tenantId), noTenant));
}

export async function provisionAccount(
  tenantId: string,
  input: ProvisionAccountInput,
): Promise<ProvisionResult> {
  return decodeProvisionResult(
    await apiFetch<unknown>(accountsPath(tenantId), { ...noTenant, method: "POST", body: input }),
  );
}

export async function reissueAccountLink(
  tenantId: string,
  userId: string,
): Promise<ProvisionResult> {
  return decodeProvisionResult(
    await apiFetch<unknown>(accountsPath(tenantId, `/${encodeURIComponent(userId)}/reissue`), {
      ...noTenant,
      method: "POST",
    }),
  );
}

export async function checkSetPasswordToken(token: string): Promise<LinkCheckResult> {
  return decodeLinkCheck(
    await apiFetch<unknown>(`/accounts/set-password/${encodeURIComponent(token)}`, noTenant),
  );
}

export async function redeemSetPasswordToken(input: {
  token: string;
  password: string;
}): Promise<RedeemResult> {
  return decodeRedeemResult(
    await apiFetch<unknown>("/accounts/set-password", { ...noTenant, method: "POST", body: input }),
  );
}
