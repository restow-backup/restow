import type { TenantRole } from "@/lib/api";

/**
 * Shapes of the accounts feature, mirroring the DTOs of
 * apps/api/src/features/accounts (provisioning and the public set-password
 * exchange). The decoders in `decoders.ts` turn raw payloads into these types.
 */

export type AccountLinkStatus = "valid" | "expired" | "used" | "invalid";

export interface PendingAccount {
  userId: string;
  name: string;
  email: string;
  role: TenantRole;
  invitedAt: string | null;
  /** The status of the newest link issued for this person. */
  linkStatus: AccountLinkStatus;
  linkExpiresAt: string | null;
}

export interface ProvisionAccountInput {
  email: string;
  role: TenantRole;
}

/** Whether the set-password link could also be emailed through the configured transport. */
export type MailOutcome = "sent" | "not_configured" | "failed";

/** POST .../accounts and the reissue endpoint share this response shape. */
export interface ProvisionResult {
  userId: string;
  email: string;
  name: string;
  role: TenantRole;
  /** A brand new account was created; false when an existing one was reused. */
  created: boolean;
  /**
   * False when the person already had a working way to sign in: only the
   * tenant membership was added, and there is no link to show or copy.
   */
  linkIssued: boolean;
  linkExpiresAt: string | null;
  /** The raw token, present exactly once so the admin can copy or email it; null when no link was issued. */
  setPasswordToken: string | null;
  mailOutcome: MailOutcome;
}

export interface LinkCheckResult {
  status: AccountLinkStatus;
  /** A masked hint ("j***@example.com"), never the full address. */
  emailHint: string | null;
}

export interface RedeemResult {
  userId: string;
  email: string;
}
