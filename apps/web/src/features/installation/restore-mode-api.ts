import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, apiFetch, errorMessageKey } from "@/lib/api";

/**
 * Client for restore mode after restoring a database dump (`apps/api/src/features/restore-mode`,
 * docs/STORAGE.md "Restore mode and progress markers"). The types mirror the api's service by
 * hand: the web never imports from apps/api. Installation level: no tenant header.
 */

export interface RestoreModeActor {
  label: string;
  userId?: string | null;
  email?: string | null;
  host?: string | null;
}

export interface RestoreModeTarget {
  tenantId: string;
  tenantName: string | null;
  targetId: string;
  outcome: "ok" | "ahead" | "unreachable" | "foreign" | "none" | string;
  storageMaxSeq: number | null;
  dbSeq: number;
  unknownKeyVersions: number[];
  detail: string | null;
  checkedAt: string;
}

export interface RestoreModeView {
  active: {
    id: string;
    source: "cli" | "api" | "detected" | string;
    reason: string | null;
    activatedAt: string;
    activatedBy: RestoreModeActor;
    holdJobsBefore: string;
    detection: {
      tenantId: string;
      targetId: string;
      markerSeq: number | null;
      dbSeq: number;
    } | null;
  } | null;
  history: {
    id: string;
    source: string;
    activatedAt: string;
    endedAt: string | null;
    endedBy: RestoreModeActor | null;
    checked: string | null;
    storageOnlyData: string | null;
  }[];
  targets: RestoreModeTarget[];
  refusals: { pass: string; tenantId: string | null; count: number; lastAt: string }[];
  heldJobs: { held: number; waiting: number };
  unknownKeyVersions: { tenantId: string; targetId: string; versions: number[] }[];
  keyFindings: {
    tenantId: string;
    targetId: string;
    keyVersion: number;
    /** A sealed repository password document: its storage key (keyVersion is 0). */
    objectKey?: string | null;
    kind: "conflict" | "damaged" | string;
    firstSeenAt: string;
  }[];
}

export interface RestoreModeBannerState {
  active: boolean;
  since: string | null;
  source: string | null;
}

export interface EndRestoreModeInput {
  checked: string;
  confirmation: "END";
  storageOnlyData: "keep" | "release";
  acceptUnreachable?: string[];
}

export const RESTORE_MODE_PROBLEM = "urn:restow:problem:restore-mode";
export const MIN_CHECKED_LENGTH = 20;

const BASE = "/restore-mode";

export const restoreModeKeys = {
  view: ["restore-mode", "view"] as const,
  banner: ["restore-mode", "banner"] as const,
};

export function fetchRestoreMode(): Promise<RestoreModeView> {
  return apiFetch<RestoreModeView>(BASE, { tenantId: null });
}

export function fetchRestoreModeBanner(): Promise<RestoreModeBannerState> {
  return apiFetch<RestoreModeBannerState>(`${BASE}/banner`, { tenantId: null });
}

export function checkRestoreMode(): Promise<{ view: RestoreModeView }> {
  return apiFetch(`${BASE}/check`, { method: "POST", tenantId: null, body: {} });
}

export function startRestoreMode(input: { reason: string }): Promise<{ view: RestoreModeView }> {
  return apiFetch(`${BASE}/start`, { method: "POST", tenantId: null, body: input });
}

export function importRestoreModeKeys(): Promise<{
  imported: { tenantId: string; keyVersion: number }[];
  refused: { tenantId: string; keyVersion: number; reason: string }[];
}> {
  return apiFetch(`${BASE}/import-keys`, {
    method: "POST",
    tenantId: null,
    body: {},
  });
}

export function endRestoreMode(input: EndRestoreModeInput): Promise<{ view: RestoreModeView }> {
  return apiFetch(`${BASE}/end`, { method: "POST", tenantId: null, body: input });
}

/** The refusals of the end step the api names by `code` (features/restore-mode/service.ts). */
const RESTORE_MODE_ERROR_CODES = new Set([
  "checked_length",
  "confirmation",
  "off",
  "unreachable",
  "unknown_key_versions",
  "changed",
]);

/**
 * The i18n key (with its namespace) that words a failed restore mode request: a refusal of the
 * end step by its `code`, anything else through the common error keys.
 */
export function restoreModeErrorKey(error: unknown): string {
  if (error instanceof ApiError && error.problem?.type === RESTORE_MODE_PROBLEM) {
    const code = (error.problem as { code?: unknown }).code;
    if (typeof code === "string" && RESTORE_MODE_ERROR_CODES.has(code)) {
      return `installation:restoreMode.errors.${code}`;
    }
  }
  return `common:${errorMessageKey(error)}`;
}

/** Whether the end step was refused because a storage target did not answer. */
export function isUnreachableRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.problem?.type === RESTORE_MODE_PROBLEM &&
    (error.problem as { code?: unknown }).code === "unreachable"
  );
}

/** Whether the start form may be sent. */
export function startFormReady(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length > 0 && trimmed.length <= 500;
}

/** Whether the end form may be sent. */
export function endFormReady(input: { checked: string; confirmation: string }): boolean {
  return input.checked.trim().length >= MIN_CHECKED_LENGTH && input.confirmation === "END";
}

export function useRestoreMode() {
  return useQuery({ queryKey: restoreModeKeys.view, queryFn: fetchRestoreMode, staleTime: 10_000 });
}

/** The banner's state: provider administrators only, read every minute. */
export function useRestoreModeBanner(enabled: boolean) {
  return useQuery({
    queryKey: restoreModeKeys.banner,
    queryFn: fetchRestoreModeBanner,
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

function useViewWriter() {
  const queryClient = useQueryClient();
  return (result: { view?: RestoreModeView }) => {
    if (result.view) {
      queryClient.setQueryData(restoreModeKeys.view, result.view);
    }
    void queryClient.invalidateQueries({ queryKey: restoreModeKeys.banner });
  };
}

export function useCheckRestoreMode() {
  const write = useViewWriter();
  return useMutation({ mutationFn: checkRestoreMode, onSuccess: write });
}

export function useStartRestoreMode() {
  const write = useViewWriter();
  return useMutation({ mutationFn: startRestoreMode, onSuccess: write });
}

export function useImportRestoreModeKeys() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: importRestoreModeKeys,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: restoreModeKeys.view }),
  });
}

export function useEndRestoreMode() {
  const write = useViewWriter();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: endRestoreMode,
    onSuccess: write,
    // A refusal for unreachable targets comes after a fresh comparison: show it, so the
    // targets to accept appear in the form.
    onError: (error) => {
      if (isUnreachableRefusal(error)) {
        void queryClient.invalidateQueries({ queryKey: restoreModeKeys.view });
      }
    },
  });
}
