import { type TenantRole, unwrapList } from "@/lib/api";

import type {
  AccountLinkStatus,
  LinkCheckResult,
  MailOutcome,
  PendingAccount,
  ProvisionResult,
  RedeemResult,
} from "./types";

/**
 * Tolerant decoders for the payloads this feature reads: missing or
 * malformed fields become honest defaults rather than breaking the page.
 */

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asBool(value: unknown): boolean {
  return value === true;
}

const MAIL_OUTCOMES: readonly MailOutcome[] = ["sent", "not_configured", "failed"];

function asMailOutcome(value: unknown): MailOutcome {
  return MAIL_OUTCOMES.includes(value as MailOutcome) ? (value as MailOutcome) : "not_configured";
}

const LINK_STATUSES: readonly AccountLinkStatus[] = ["valid", "expired", "used", "invalid"];

function asLinkStatus(value: unknown): AccountLinkStatus {
  return LINK_STATUSES.includes(value as AccountLinkStatus)
    ? (value as AccountLinkStatus)
    : "invalid";
}

function asTenantRole(value: unknown): TenantRole {
  return value === "tenant_admin" ? "tenant_admin" : "tenant_user";
}

export function decodeProvisionResult(payload: unknown): ProvisionResult {
  const raw = asObject(payload);
  return {
    userId: asString(raw.userId),
    email: asString(raw.email),
    name: asString(raw.name),
    role: asTenantRole(raw.role),
    created: asBool(raw.created),
    linkIssued: asBool(raw.linkIssued),
    linkExpiresAt: asNullableString(raw.linkExpiresAt),
    setPasswordToken: asNullableString(raw.setPasswordToken),
    mailOutcome: asMailOutcome(raw.mailOutcome),
  };
}

function decodePendingAccount(payload: unknown): PendingAccount {
  const raw = asObject(payload);
  return {
    userId: asString(raw.userId),
    name: asString(raw.name),
    email: asString(raw.email),
    role: asTenantRole(raw.role),
    invitedAt: asNullableString(raw.invitedAt),
    linkStatus: asLinkStatus(raw.linkStatus),
    linkExpiresAt: asNullableString(raw.linkExpiresAt),
  };
}

/** `{ items: PendingAccountDto[] }` (or a bare array); rows without an id are dropped. */
export function decodePendingAccountList(payload: unknown): PendingAccount[] {
  return unwrapList<unknown>(payload)
    .map(decodePendingAccount)
    .filter((row) => row.userId.length > 0);
}

export function decodeLinkCheck(payload: unknown): LinkCheckResult {
  const raw = asObject(payload);
  return { status: asLinkStatus(raw.status), emailHint: asNullableString(raw.emailHint) };
}

export function decodeRedeemResult(payload: unknown): RedeemResult {
  const raw = asObject(payload);
  return { userId: asString(raw.userId), email: asString(raw.email) };
}
