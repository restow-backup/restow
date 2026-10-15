import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { updatesKeys } from "@/features/updates/hooks";
import { ApiError, apiFetch, NetworkError } from "@/lib/api";

/**
 * Client of Installation > Database (apps/api/src/features/updates/database.ts): where
 * the database keeps its data, the disks under it and under the local repository, moving
 * it to another disk through the opt-in updater, and the old copy a move leaves. The types
 * mirror the api's and the updater's (database-protocol.ts) by hand.
 */

export type DataLocation = { kind: "volume" | "bind"; source: string };

export const MOVE_STEPS = [
  "stop_application",
  "stop_database",
  "copy",
  "verify",
  "trial",
  "switch",
  "start_database",
  "start_application",
] as const;
export type MoveStepId = (typeof MOVE_STEPS)[number];

export type MoveStatus = "running" | "succeeded" | "rolled_back" | "needs_attention";

export const MOVE_FAILURE_CODES = [
  "stop_application.failed",
  "stop_database.failed",
  "stop_database.unclean",
  "copy.failed",
  "verify.mismatch",
  "verify.failed",
  "trial.failed",
  "trial.mismatch",
  "switch.compose_unsupported",
  "switch.failed",
  "start_database.failed",
  "start_database.wrong_location",
  "start_application.failed",
  "interrupted",
] as const;

export const MOVE_PROBLEM_CODES = [
  "path_invalid",
  "path_missing",
  "not_writable",
  "same_filesystem",
  "filesystem_unsuitable",
  "insufficient_space",
  "tablespaces",
  "compose_unsupported",
  "location_unknown",
  "env_unwritable",
  "busy",
] as const;

export interface MoveProblem {
  code: string;
  detail: string | null;
}

export interface MoveCheck {
  ok: boolean;
  problems: MoveProblem[];
  targetDir: string;
  filesystem: string | null;
  freeBytes: number | null;
  totalBytes: number | null;
  dataBytes: number | null;
  requiredBytes: number | null;
  checkedAt: string;
}

export interface MoveStep {
  id: MoveStepId;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  startedAt: string | null;
  finishedAt: string | null;
}

export interface MoveRecord {
  id: string;
  status: MoveStatus;
  requestedBy: { userId: string | null; label: string; ip: string | null };
  startedAt: string;
  finishedAt: string | null;
  from: DataLocation;
  targetDir: string;
  dataDir: string;
  step: MoveStepId | null;
  steps: MoveStep[];
  progress: number;
  dataBytes: number | null;
  verified: { entries: number; bytes: number } | null;
  failure: { code: string; step: MoveStepId | null; detail: string } | null;
  keptCopy: string | null;
  log: string[];
}

export interface OldCopy {
  id: string;
  location: DataLocation;
  moveId: string;
  movedAt: string;
}

export interface OldCopyRemoval {
  copyId: string;
  location: DataLocation;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  detail: string;
}

export interface DataUsage {
  dataBytes: number;
  filesystemTotalBytes: number;
  filesystemFreeBytes: number;
  filesystem: string | null;
  measuredAt: string;
}

export interface UpdateSpace {
  dumpBytes: number;
  dumpBasis: "last_dump" | "tables" | "none";
  imageBytes: number;
  migrationBytes: number;
  marginBytes: number;
  stateFreeBytes: number | null;
  stateRequiredBytes: number;
  databaseFreeBytes: number | null;
  databaseRequiredBytes: number;
  sameFilesystem: boolean | null;
  enough: boolean;
}

export interface DiskStatus {
  kind: "database" | "repository";
  location: string | null;
  freeBytes: number;
  totalBytes: number;
  thresholdBytes: number;
  low: boolean;
}

export type DatabaseUpdaterAvailability = "ready" | "unsupported" | "unavailable" | "demo";

export interface DatabaseView {
  updater: DatabaseUpdaterAvailability;
  updateActive: boolean;
  location: DataLocation | null;
  usage: DataUsage | null;
  movable: boolean | null;
  move: MoveRecord | null;
  oldCopies: OldCopy[];
  removal: OldCopyRemoval | null;
  updateSpace: UpdateSpace | null;
  disks: { database: DiskStatus | null; repository: DiskStatus | null };
  projectDir: string | null;
}

export const DATABASE_MOVE_REFUSED_PROBLEM = "urn:restow:problem:database-move-refused";
export const DATABASE_BUSY_PROBLEM = "urn:restow:problem:database-busy";
export const DATABASE_UNSUPPORTED_PROBLEM = "urn:restow:problem:database-move-unsupported";
export const DATABASE_DIRECTORY_INVALID_PROBLEM = "urn:restow:problem:database-directory-invalid";

export const databaseKeys = {
  view: ["installation", "database"] as const,
};

export function fetchDatabase(refresh = false): Promise<DatabaseView> {
  return apiFetch<DatabaseView>(`/updates/database${refresh ? "?refresh=1" : ""}`, {
    tenantId: null,
  });
}

export function checkDatabaseDirectory(targetDir: string): Promise<MoveCheck> {
  return apiFetch<MoveCheck>("/updates/database/check", {
    method: "POST",
    body: { targetDir },
    tenantId: null,
  });
}

export function moveDatabase(targetDir: string): Promise<DatabaseView> {
  return apiFetch<DatabaseView>("/updates/database/move", {
    method: "POST",
    body: { targetDir },
    tenantId: null,
  });
}

export function removeOldCopy(id: string): Promise<DatabaseView> {
  return apiFetch<DatabaseView>(`/updates/database/old-copies/${encodeURIComponent(id)}`, {
    method: "DELETE",
    tenantId: null,
  });
}

/** A move or a removal runs: the page follows it closely. */
export function databaseBusy(view: DatabaseView | undefined): boolean {
  return view?.move?.status === "running" || view?.removal?.status === "running";
}

/** While a move runs the api itself is stopped: those answers are expected, not failures. */
export function isAwayDuringMove(error: unknown): boolean {
  return (
    error instanceof NetworkError ||
    (error instanceof ApiError && [502, 503, 504].includes(error.status))
  );
}

export const DATABASE_BUSY_REFRESH_MS = 3_000;

export function useDatabase() {
  return useQuery({
    queryKey: databaseKeys.view,
    queryFn: () => fetchDatabase(),
    staleTime: 15_000,
    refetchInterval: (query) => (databaseBusy(query.state.data) ? DATABASE_BUSY_REFRESH_MS : false),
    // While the application is stopped for a move, the last view stays and the polling goes on.
    retry: (count, error) => isAwayDuringMove(error) && count < 1000,
    retryDelay: DATABASE_BUSY_REFRESH_MS,
  });
}

export function useCheckDatabaseDirectory() {
  return useMutation({ mutationFn: (targetDir: string) => checkDatabaseDirectory(targetDir) });
}

function useViewWriter() {
  const queryClient = useQueryClient();
  return (view: DatabaseView) => {
    queryClient.setQueryData(databaseKeys.view, view);
    void queryClient.invalidateQueries({ queryKey: updatesKeys.maintenance });
  };
}

export function useMoveDatabase() {
  const write = useViewWriter();
  return useMutation({
    mutationFn: (targetDir: string) => moveDatabase(targetDir),
    onSuccess: write,
  });
}

export function useRemoveOldCopy() {
  const write = useViewWriter();
  return useMutation({ mutationFn: (id: string) => removeOldCopy(id), onSuccess: write });
}

/** The text key of a check's problem, `installation:database.problems.<code>`. */
export function problemKey(code: string): string {
  return (MOVE_PROBLEM_CODES as readonly string[]).includes(code)
    ? `database.problems.${code}`
    : "database.problems.unknown";
}

/** The text key of a move's failure, `installation:database.failure.<step>.<reason>`. */
export function failureKey(code: string): string {
  return (MOVE_FAILURE_CODES as readonly string[]).includes(code)
    ? `database.failure.${code}`
    : "database.failure.unknown";
}

/** The problems a refused move or check carries (the api's `problems` extension). */
export function problemsOf(error: unknown): MoveProblem[] {
  if (!(error instanceof ApiError)) {
    return [];
  }
  const problems = (error.problem as { problems?: unknown } | null)?.problems;
  return Array.isArray(problems)
    ? problems.filter(
        (entry): entry is MoveProblem =>
          typeof entry === "object" && entry !== null && typeof entry.code === "string",
      )
    : [];
}

/** A location as the page names it. */
export function locationText(location: DataLocation): string {
  return location.source;
}
