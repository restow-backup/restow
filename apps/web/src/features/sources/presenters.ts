import { z } from "zod";

import type { BadgeProps } from "@/components/ui/badge";
import type { Failure } from "@/features/failures/api";
import { ApiError, errorMessageKey } from "@/lib/api";
import type { ConsentError, RetainedData, SourceDto, SourceStatus } from "./types";

/**
 * Pure view logic: which badge a status gets, the one-line summary of a
 * source card, how the consent round trip's query parameters become a
 * message, and how API problems map to feature messages. Everything returns
 * i18n keys with their values, never text.
 */

/** A source that is connected is a state, shown as the neutral outline; green is for a passed restore check. */
export const STATUS_VARIANT: Record<SourceStatus, NonNullable<BadgeProps["variant"]>> = {
  pending: "muted",
  active: "outline",
  error: "destructive",
  disabled: "secondary",
};

/**
 * `ok`: in order, which is a state and not a proof (the text colour, a check
 * mark); `neutral`: nothing to say or not known. Neither is the green of a
 * passed restore check (brand guide, section 4).
 */
export type Tone = "neutral" | "ok" | "warning" | "destructive";

/** An i18n key with its interpolation values. */
export interface Message {
  key: string;
  values?: Record<string, string | number>;
}

export interface Summary extends Message {
  tone: Tone;
}

/** One line that says what a source needs next, for the list cards (namespace `sources`). */
export function summarizeSource(source: SourceDto): Summary {
  if (source.status === "disabled") {
    return { key: "list.paused", tone: "neutral" };
  }
  if (source.kind === "m365") {
    const m365 = source.m365;
    if (!m365?.entraTenantId) {
      return m365?.consentError
        ? { key: "list.consentDeniedShort", tone: "destructive" }
        : { key: "list.consentPending", tone: "warning" };
    }
    const verification = m365.verification;
    if (!verification) {
      return { key: "list.notVerified", tone: "warning" };
    }
    if (verification.ok) {
      return { key: "list.permissionsOk", tone: "ok" };
    }
    const missing = verification.permissions?.missing.length ?? 0;
    if (missing > 0) {
      return { key: "list.permissionsIncomplete", values: { count: missing }, tone: "destructive" };
    }
    return { key: "list.verificationFailed", tone: "destructive" };
  }

  const probe = source.imap?.lastProbe ?? null;
  if (!probe) {
    return { key: "list.imapNotTested", tone: "warning" };
  }
  return probe.ok
    ? { key: "list.imapOk", tone: "ok" }
    : { key: "list.imapFailed", tone: "destructive" };
}

/**
 * A problem the last backup run reported, when the connection check itself is
 * green (or never ran): the check panels already explain their own failures.
 */
export function syncProblem(source: SourceDto): string | null {
  if (source.status !== "error" || !source.errorMessage) {
    return null;
  }
  const checkFailed =
    source.kind === "m365"
      ? source.m365?.verification?.ok === false
      : source.imap?.lastProbe?.ok === false;
  return checkFailed ? null : source.errorMessage;
}

/** What the detail page says about a source in error (see {@link describeSourceProblem}). */
export type SourceProblem =
  /** The server classified the cause: it is explained in three parts (what happened, why, what to do). */
  | { kind: "classified"; failure: Failure; message: string | null; at: string }
  /** Recorded before causes were kept: only the recorded message exists. */
  | { kind: "recorded"; message: string };

/**
 * The problem of a source in error, as far as the page can explain it. A
 * classified cause explains itself, so the plain recorded message stays out of
 * the way (it is part of the technical details). Without one, the old rule
 * applies: the last run's message, unless the check panels already show why.
 */
export function describeSourceProblem(source: SourceDto): SourceProblem | null {
  if (source.status !== "error") {
    return null;
  }
  const failure = source.failure ?? null;
  if (failure) {
    return {
      kind: "classified",
      failure,
      message: source.errorMessage,
      at: source.lastSyncAt ?? source.updatedAt,
    };
  }
  const message = syncProblem(source);
  return message ? { kind: "recorded", message } : null;
}

/** The classified cause of a source in error, for the compact line on list cards; null otherwise. */
export function sourceCause(source: Pick<SourceDto, "status" | "failure">): Failure | null {
  return source.status === "error" ? (source.failure ?? null) : null;
}

// --- Consent round trip -----------------------------------------------------------

export const CONSENT_OUTCOMES = [
  "granted",
  "denied",
  "identity_not_verified",
  "tenant_already_connected",
  "tenant_mismatch",
  "invalid_state",
  "unknown_source",
] as const;

export const consentSearchSchema = z.object({
  consent: z.enum(CONSENT_OUTCOMES).optional(),
  verified: z.enum(["ok", "failed"]).optional(),
  error: z.string().max(200).optional(),
  reason: z.string().max(50).optional(),
  /** The Restow tenant the consent link was created for. */
  tenant: z.string().uuid().optional(),
});

export type ConsentSearch = z.infer<typeof consentSearchSchema>;

/** Parse search params field by field: unknown or malformed values are dropped, never thrown. */
export function parseConsentSearch(search: Record<string, unknown>): ConsentSearch {
  const result: ConsentSearch = {};
  for (const key of Object.keys(consentSearchSchema.shape) as (keyof ConsentSearch)[]) {
    const parsed = consentSearchSchema.shape[key].safeParse(search[key]);
    if (parsed.success && parsed.data !== undefined) {
      Object.assign(result, { [key]: parsed.data });
    }
  }
  return result;
}

export interface ConsentMessage extends Message {
  tone: Exclude<Tone, "neutral">;
}

/** The message to show after Entra redirected back; null when no consent parameters are present. */
export function describeConsentResult(search: ConsentSearch): ConsentMessage | null {
  switch (search.consent) {
    case "granted":
      if (search.verified === "ok") {
        return { key: "m365.consentResult.grantedVerifiedOk", tone: "ok" };
      }
      if (search.verified === "failed") {
        return { key: "m365.consentResult.grantedVerifiedFailed", tone: "warning" };
      }
      return { key: "m365.consentResult.granted", tone: "ok" };
    case "denied":
      return {
        key: "m365.consentResult.denied",
        values: { error: search.error ?? "access_denied" },
        tone: "destructive",
      };
    case "tenant_already_connected":
    case "tenant_mismatch":
      return { key: `m365.consentResult.${search.consent}`, tone: "warning" };
    case "identity_not_verified":
      return { key: "m365.consentResult.identity_not_verified", tone: "destructive" };
    case "invalid_state":
    case "unknown_source":
      return { key: `m365.consentResult.${search.consent}`, tone: "destructive" };
    default:
      return null;
  }
}

/** True while the source is waiting for the admin consent to come back. */
export function isAwaitingConsent(source: SourceDto | undefined): boolean {
  return source?.kind === "m365" && !source.m365?.entraTenantId;
}

/** How long after a consent the page keeps looking for the verification the callback runs. */
export const VERIFICATION_GRACE_MS = 2 * 60 * 1000;

/**
 * The consent just arrived and the callback's verification has not landed
 * yet: keep polling for a short while so the checklist appears by itself.
 */
export function isAwaitingVerification(source: SourceDto | undefined, now: number): boolean {
  const grantedAt = source?.m365?.consentGrantedAt;
  if (!grantedAt) {
    return false;
  }
  const granted = Date.parse(grantedAt);
  if (!(now - granted < VERIFICATION_GRACE_MS)) {
    return false;
  }
  const checkedAt = source?.m365?.verification?.checkedAt;
  return !checkedAt || Date.parse(checkedAt) < granted;
}

const KNOWN_CONSENT_ERRORS = new Set([
  "access_denied",
  "consent_not_granted",
  "tenant_mismatch",
  "tenant_already_connected",
  "sign_in_failed",
  "identity_mismatch",
  "not_an_admin",
  "role_check_failed",
  "app_not_configured",
]);

/** Explain a recorded consent failure. */
export function consentErrorMessage(error: ConsentError): Message {
  return KNOWN_CONSENT_ERRORS.has(error.error)
    ? { key: `m365.consentError.codes.${error.error}` }
    : { key: "m365.consentError.codes.other", values: { code: error.error } };
}

/**
 * Whether a recorded consent failure is news for the current connection: a
 * failed attempt older than the consent that connected the source is history.
 */
export function isCurrentConsentError(
  error: ConsentError | null | undefined,
  consentGrantedAt: string | null | undefined,
): error is ConsentError {
  if (!error) {
    return false;
  }
  if (!consentGrantedAt) {
    return true;
  }
  return Date.parse(error.at) > Date.parse(consentGrantedAt);
}

// --- API problems -------------------------------------------------------------------

const PROBLEM_KEYS: Record<string, string> = {
  "urn:restow:problem:source-name-taken": "sources:errors.nameTaken",
  "urn:restow:problem:password-required": "sources:errors.passwordRequired",
  "urn:restow:problem:entra-not-configured": "sources:errors.entraNotConfigured",
  "urn:restow:problem:consent-required": "sources:errors.consentRequired",
  "urn:restow:problem:source-incomplete": "sources:errors.sourceIncomplete",
  "urn:restow:problem:source-per-mailbox": "sources:errors.perMailboxNoSourceTest",
  "urn:restow:problem:imap-host-not-allowed": "sources:errors.imapHostNotAllowed",
};

/** The fully qualified i18n key for a failed call: feature problems first, else the common mapping. */
export function sourceErrorKey(error: unknown): string {
  if (error instanceof ApiError && error.problem) {
    const key = PROBLEM_KEYS[error.problem.type];
    if (key) {
      return key;
    }
  }
  return `common:${errorMessageKey(error)}`;
}

/** Which form field a problem belongs to, when the API names one. */
export function problemField(error: unknown): string | null {
  if (error instanceof ApiError && typeof error.problem?.field === "string") {
    return error.problem.field;
  }
  return null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The data that blocked a delete (409 `source-has-data`), or null for any other failure. */
export function retainedDataOf(error: unknown): RetainedData | null {
  if (
    !(error instanceof ApiError) ||
    error.problem?.type !== "urn:restow:problem:source-has-data"
  ) {
    return null;
  }
  const retained = (error.problem.retained ?? {}) as Record<string, unknown>;
  return {
    snapshots: count(retained.snapshots),
    archiveItems: count(retained.archiveItems),
    legalHolds: count(retained.legalHolds),
  };
}
