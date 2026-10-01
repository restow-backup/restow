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

export function releaseLegalHold(id: string): Promise<LegalHold> {
  return apiFetch<LegalHold>(`${LEGAL_HOLDS}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export const legalHoldKeys = {
  list: (tenantId: string | null) => ["tenant", tenantId, "archive", "legal-holds"] as const,
};
