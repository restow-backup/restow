import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { endpointKeys } from "@/features/endpoints/api";
import { useLiveOpen } from "@/features/history/live/provider";
import { useDebouncedValue } from "@/features/schedules/hooks";
import { useSession } from "@/lib/session";

import {
  type AddMembersInput,
  type BackupJob,
  type BackupJobList,
  type CreateBackupJobInput,
  type JobKind,
  type JobMemberOverrides,
  type ReplaceMembersInput,
  type RunBackupJobInput,
  type UpdateBackupJobInput,
  addJobMembers,
  backupJobKeys,
  createBackupJob,
  deleteBackupJob,
  fetchBackupJob,
  fetchBackupJobs,
  fetchJobCandidates,
  fetchJobDefaults,
  fetchJobMembers,
  fetchJobRuns,
  removeJobMember,
  replaceJobMembers,
  runBackupJob,
  setMemberOverrides,
  updateBackupJob,
} from "./api.js";

/**
 * Data hooks of the job pages. Every key carries the active tenant, nothing
 * runs before the session is settled, and every change refreshes the jobs (and
 * the machines, which carry the job they belong to). The live channel
 * (features/history/live) keeps what is loaded current; the pages refresh on
 * their own at a modest pace, and when the window gets focus again, only while
 * it is not connected.
 */

/** How often the pages ask again: quicker while something runs. */
export const IDLE_REFRESH_MS = 30_000;
export const RUNNING_REFRESH_MS = 8_000;
/**
 * A job page that was in the background is read again as soon as it gets the focus back (the app's
 * default is not to refetch on focus), unless it was read a moment ago.
 */
const FOCUS_STALE_MS = 5_000;

export function useJobsScope() {
  const { status, activeTenant } = useSession();
  return {
    tenantId: activeTenant?.id ?? null,
    enabled: status === "authenticated" && activeTenant !== null,
  };
}

/** Whether any job of the list has a backup running or waiting for its machine. */
export function anyRunning(jobs: readonly Pick<BackupJob, "state" | "lastRun">[] | undefined) {
  return (jobs ?? []).some(
    (job) =>
      job.state === "running" ||
      job.state === "queued" ||
      job.lastRun.running > 0 ||
      job.lastRun.queued > 0,
  );
}

export function refreshIntervalOf(jobs: readonly BackupJob[] | undefined): number {
  return anyRunning(jobs) ? RUNNING_REFRESH_MS : IDLE_REFRESH_MS;
}

/** The jobs of one kind (or of both, without a kind) and what no job covers. */
export function useBackupJobs(kind?: JobKind) {
  const { tenantId, enabled } = useJobsScope();
  const connected = useLiveOpen();
  return useQuery<BackupJobList>({
    queryKey: backupJobKeys.list(tenantId, kind),
    queryFn: () => fetchBackupJobs(kind),
    enabled,
    staleTime: FOCUS_STALE_MS,
    refetchOnWindowFocus: true,
    // The live channel moves state, last and next run; the list polls only while it is down.
    refetchInterval: (query) => (connected ? false : refreshIntervalOf(query.state.data?.items)),
  });
}

export function useBackupJob(jobId: string) {
  const { tenantId, enabled } = useJobsScope();
  const connected = useLiveOpen();
  return useQuery<BackupJob>({
    queryKey: backupJobKeys.detail(tenantId, jobId),
    queryFn: () => fetchBackupJob(jobId),
    enabled,
    retry: false,
    staleTime: FOCUS_STALE_MS,
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      connected ? false : refreshIntervalOf(query.state.data ? [query.state.data] : []),
  });
}

/** All covered objects or machines of a job; `enabled` waits for the tab that shows them. */
export function useJobMembers(jobId: string, enabled = true) {
  const scope = useJobsScope();
  const connected = useLiveOpen();
  return useQuery({
    queryKey: backupJobKeys.members(scope.tenantId, jobId),
    queryFn: () => fetchJobMembers(jobId),
    enabled: scope.enabled && enabled,
    retry: false,
    staleTime: FOCUS_STALE_MS,
    refetchOnWindowFocus: true,
    // The members change when their job's runs do: the channel re-reads them then (live/apply.ts).
    refetchInterval: connected ? false : IDLE_REFRESH_MS,
  });
}

export function useJobRuns(jobId: string, limit: number, enabled = true) {
  const scope = useJobsScope();
  const connected = useLiveOpen();
  return useQuery({
    queryKey: backupJobKeys.runs(scope.tenantId, jobId, limit),
    queryFn: () => fetchJobRuns(jobId, limit),
    enabled: scope.enabled && enabled,
    retry: false,
    staleTime: FOCUS_STALE_MS,
    refetchOnWindowFocus: true,
    refetchInterval: connected ? false : IDLE_REFRESH_MS,
  });
}

/** The recommended values of a new job of this kind, and the choices of the editor. */
export function useJobDefaults(kind: JobKind, enabled = true) {
  const scope = useJobsScope();
  return useQuery({
    queryKey: backupJobKeys.defaults(scope.tenantId, kind),
    queryFn: () => fetchJobDefaults(kind),
    enabled: scope.enabled && enabled,
    retry: false,
    staleTime: 60_000,
  });
}

/** The objects or machines a job can take, as the person types; each says which job it belongs to. */
export function useJobCandidates(kind: JobKind, search: string, enabled = true, limit = 200) {
  const scope = useJobsScope();
  const debounced = useDebouncedValue(search, 250);
  return useQuery({
    queryKey: backupJobKeys.candidates(scope.tenantId, kind, debounced.trim(), limit),
    queryFn: () => fetchJobCandidates(kind, debounced, limit),
    enabled: scope.enabled && enabled,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 15_000,
  });
}

/** Refresh the jobs and the machines (a machine's job changes with a job's scope). */
function useRefreshJobs() {
  const { tenantId } = useJobsScope();
  const queryClient = useQueryClient();
  return React.useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: backupJobKeys.all(tenantId) }),
        queryClient.invalidateQueries({ queryKey: endpointKeys.all(tenantId) }),
      ]),
    [queryClient, tenantId],
  );
}

export function useCreateBackupJob() {
  const refresh = useRefreshJobs();
  return useMutation({
    mutationFn: (input: CreateBackupJobInput) => createBackupJob(input),
    onSettled: refresh,
  });
}

export function useUpdateBackupJob(jobId: string) {
  const refresh = useRefreshJobs();
  return useMutation({
    mutationFn: (patch: UpdateBackupJobInput) => updateBackupJob(jobId, patch),
    onSettled: refresh,
  });
}

/** Switch a job on or off from a list row (any job). */
export function useToggleBackupJob() {
  const refresh = useRefreshJobs();
  return useMutation({
    mutationFn: (input: { jobId: string; enabled: boolean }) =>
      updateBackupJob(input.jobId, { enabled: input.enabled }),
    onSettled: refresh,
  });
}

export function useDeleteBackupJob() {
  const refresh = useRefreshJobs();
  return useMutation({
    mutationFn: (jobId: string) => deleteBackupJob(jobId),
    onSettled: refresh,
  });
}

export function useReplaceJobMembers(jobId: string) {
  const refresh = useRefreshJobs();
  return useMutation({
    mutationFn: (input: ReplaceMembersInput) => replaceJobMembers(jobId, input),
    onSettled: refresh,
  });
}

export function useAddJobMembers(jobId: string) {
  const refresh = useRefreshJobs();
  return useMutation({
    mutationFn: (input: AddMembersInput) => addJobMembers(jobId, input),
    onSettled: refresh,
  });
}

export function useSetMemberOverrides(jobId: string) {
  const refresh = useRefreshJobs();
  return useMutation({
    mutationFn: (input: { targetId: string; overrides: JobMemberOverrides }) =>
      setMemberOverrides(jobId, input.targetId, input.overrides),
    onSettled: refresh,
  });
}

export function useRemoveJobMember(jobId: string) {
  const refresh = useRefreshJobs();
  return useMutation({
    mutationFn: (targetId: string) => removeJobMember(jobId, targetId),
    onSettled: refresh,
  });
}

/** Run a job now (all of it, or the chosen objects or machines). */
export function useRunBackupJob() {
  const refresh = useRefreshJobs();
  return useMutation({
    mutationFn: (input: { jobId: string } & RunBackupJobInput) => {
      const { jobId, ...body } = input;
      return runBackupJob(jobId, body);
    },
    onSettled: refresh,
  });
}
