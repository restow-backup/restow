import type { BadgeProps } from "@/components/ui/badge";
import { ApiError, errorMessageKey } from "@/lib/api";

import type { AccountLinkStatus, MailOutcome } from "./types";

/**
 * Pure presentation rules for account provisioning: badges for the pending
 * accounts list and the translation of API failures. Every `key` is
 * namespaced, so components call `t(message.key, message.values)` from any
 * namespace.
 */

export interface Message {
  key: string;
  values?: Record<string, unknown>;
}

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

const LINK_STATUS_BADGE: Record<AccountLinkStatus, BadgeVariant> = {
  valid: "outline",
  expired: "warning",
  used: "muted",
  invalid: "destructive",
};

export function linkStatusBadge(status: AccountLinkStatus): {
  variant: BadgeVariant;
  labelKey: string;
} {
  return { variant: LINK_STATUS_BADGE[status], labelKey: `accounts:pending.linkStatus.${status}` };
}

/** Never claims mail was sent unless it actually was (the honesty rule). */
export function mailOutcomeView(outcome: MailOutcome): {
  variant: "default" | "info" | "warning";
  titleKey: string;
} {
  switch (outcome) {
    case "sent":
      // Mail that went out is a plain confirmation, not a passed restore check: no green.
      return { variant: "default", titleKey: "accounts:provision.mail.sent" };
    case "failed":
      return { variant: "warning", titleKey: "accounts:provision.mail.failed" };
    default:
      return { variant: "info", titleKey: "accounts:provision.mail.notConfigured" };
  }
}

/** The shared fallback: `common:errors.*` for the HTTP status. */
export function genericError(error: unknown): Message {
  return { key: `common:${errorMessageKey(error)}` };
}

/** The API's own typed refusals for provisioning and reissuing, each naming its actual cause. */
const PROVISION_PROBLEM_KEYS: Record<string, string> = {
  "urn:restow:problem:account-cross-tenant": "accounts:provision.errors.crossTenant",
  "urn:restow:problem:account-provider-admin-target":
    "accounts:provision.errors.providerAdminTarget",
  "urn:restow:problem:account-not-pending": "accounts:provision.errors.notPending",
};

/** Why provisioning or reissuing a link failed: an honest, specific reason when we have one. */
export function provisionError(error: unknown): Message {
  const type = error instanceof ApiError ? error.problem?.type : undefined;
  if (typeof type === "string" && type in PROVISION_PROBLEM_KEYS) {
    return { key: PROVISION_PROBLEM_KEYS[type] as string };
  }
  return genericError(error);
}

const LINK_PROBLEM_PREFIX = "urn:restow:problem:account-link-";
const KNOWN_LINK_STATUSES: ReadonlySet<string> = new Set(["used", "expired", "invalid"]);

/** Why redeeming a set-password link failed: an honest, specific reason when we have one. */
export function setPasswordError(error: unknown): Message {
  if (error instanceof ApiError && error.status === 429) {
    return { key: "accounts:setPassword.rateLimited" };
  }
  const type = error instanceof ApiError ? error.problem?.type : undefined;
  if (typeof type === "string" && type.startsWith(LINK_PROBLEM_PREFIX)) {
    const status = type.slice(LINK_PROBLEM_PREFIX.length);
    if (KNOWN_LINK_STATUSES.has(status)) {
      return { key: `accounts:setPassword.linkError.${status}` };
    }
  }
  return genericError(error);
}
