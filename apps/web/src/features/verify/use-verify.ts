import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  type ReadinessOverview,
  type ReportPage,
  type RunVerifyRequest,
  type ScrubMode,
  fetchReadinessOverview,
  fetchReport,
  fetchReports,
  startScrub,
  startVerify,
  verifyKeys,
} from "@/features/verify/api";
import { formatBytes, formatDateTime, formatInteger, formatRelative } from "@/lib/format";
import { useSession } from "@/lib/session";

/**
 * Data hooks for the readiness pages. Every key carries the active tenant,
 * nothing runs before the session is settled, and the overview refreshes on
 * its own while checks are queued or running.
 */

const LIVE_REFRESH_MS = 5_000;
const IDLE_REFRESH_MS = 60_000;

function useTenantScope() {
  const { status, activeTenant } = useSession();
  return { tenantId: activeTenant?.id ?? null, enabled: status === "authenticated" };
}

function isBusy(overview: ReadinessOverview | undefined): boolean {
  return (overview?.summary.running ?? 0) > 0 || overview?.storage.running != null;
}

export function useReadinessOverview() {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: verifyKeys.overview(tenantId),
    queryFn: fetchReadinessOverview,
    enabled,
    refetchInterval: (query) => (isBusy(query.state.data) ? LIVE_REFRESH_MS : IDLE_REFRESH_MS),
  });
}

export function useReport(reportId: string) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: verifyKeys.report(tenantId, reportId),
    queryFn: () => fetchReport(reportId),
    enabled,
    // A report never changes once written.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/** Report history of one object, page by page. */
export function useReportHistory(objectId: string | null) {
  const { tenantId, enabled } = useTenantScope();
  return useInfiniteQuery({
    queryKey: verifyKeys.reports(tenantId, objectId),
    queryFn: ({ pageParam }) =>
      fetchReports({ objectId: objectId ?? undefined, cursor: pageParam, limit: 10 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ReportPage) => last.next ?? undefined,
    enabled: enabled && objectId !== null,
  });
}

export function useStartVerify() {
  const { tenantId } = useTenantScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: RunVerifyRequest) => startVerify(request),
    onSettled: () => queryClient.invalidateQueries({ queryKey: verifyKeys.all(tenantId) }),
  });
}

export function useStartScrub() {
  const { tenantId } = useTenantScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mode: ScrubMode) => startScrub(mode),
    onSettled: () => queryClient.invalidateQueries({ queryKey: verifyKeys.overview(tenantId) }),
  });
}

/** Locale-bound formatters so every component says the same thing the same way. */
export function useVerifyFormat() {
  const { t, i18n } = useTranslation("verify");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return React.useMemo(
    () => ({
      t,
      language,
      bytes: (value: number) => formatBytes(value, language),
      integer: (value: number) => formatInteger(value, language),
      relative: (value: string | null) => formatRelative(value, language),
      dateTime: (value: string | null) => formatDateTime(value, language),
      seconds: (ms: number) =>
        new Intl.NumberFormat(language, {
          style: "unit",
          unit: "second",
          unitDisplay: "short",
          maximumFractionDigits: 1,
        }).format(ms / 1000),
    }),
    [t, language],
  );
}

export type VerifyFormat = ReturnType<typeof useVerifyFormat>;
