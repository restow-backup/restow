import { apiFetch } from "@/lib/api";

/**
 * Typed client for /api/v1/archive/legal-holds (ee/api/src/legal-holds).
 * The routes answer 404 without the `archive.legalHold` capability, so the
 * section only calls them for an edition that includes it.
 */

export interface LegalHold {
  id: string;
  reason: string;
  protectedObjectId: string | null;
  active: boolean;
  createdAt: string;
  releasedAt: string | null;
}

export interface CreateLegalHoldInput {
  reason: string;
  protectedObjectId?: string | null;
}

const LEGAL_HOLDS = "/archive/legal-holds";

export function fetchLegalHolds(): Promise<{ items: LegalHold[] }> {
  return apiFetch<{ items: LegalHold[] }>(LEGAL_HOLDS);
}

export function createLegalHold(input: CreateLegalHoldInput): Promise<LegalHold> {
  return apiFetch<LegalHold>(LEGAL_HOLDS, { method: "POST", body: input });
}

/** Release a hold; the reason is recorded in the audit log (`archive.legal_hold.released`). */
export function releaseLegalHold(id: string, reason: string): Promise<LegalHold> {
  return apiFetch<LegalHold>(`${LEGAL_HOLDS}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: { reason },
  });
}

export const legalHoldKeys = {
  list: (tenantId: string | null) => ["tenant", tenantId, "archive", "legal-holds"] as const,
};
