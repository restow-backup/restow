import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components/ui/sonner";
import { ApiError, errorMessageKey } from "@/lib/api";
import { hasFeature, useSession } from "@/lib/session";

import { type StatsParams, fetchStats, statsKeys, statsParams } from "./api.js";
import { type DownloadRequest, downloadFile } from "./download.js";
import { STATS_NAMESPACE } from "./i18n.js";
import {
  type ResolvedPeriod,
  STATS_PATH,
  STATS_VIEW,
  type StatsScope,
  type StatsSearch,
  dayStart,
  effectiveScope,
  parseStatsSearch,
  resolvePeriod,
  toDay,
} from "./period.js";

/** Roles that may open the statistics (the API enforces the same). */
export const STATS_ROLES = ["provider_admin", "tenant_admin"] as const;

export type StatsAccess =
  | { kind: "loading" }
  | { kind: "noTenant"; providerAllowed: boolean }
  | { kind: "notAdmin"; tenantName: string }
  | {
      kind: "ready";
      scope: StatsScope;
      /** Cache scope: the provider totals or one tenant. */
      scopeKey: string;
      tenantName: string | null;
      /** A provider admin may switch to all tenants where the installation enables it. */
      providerAllowed: boolean;
    };

/**
 * What the signed-in user may see here. Provider admins choose between one
 * tenant and all tenants where the installation enables the gated feature
 * `stats.allTenants`; everyone else sees the active tenant, and only as its
 * admin.
 */
export function useStatsAccess(search: StatsSearch): StatsAccess {
  const session = useSession();
  const { status, isProviderAdmin, activeTenant } = session;
  if (status !== "authenticated") {
    return { kind: "loading" };
  }
  const providerAllowed = isProviderAdmin && hasFeature(session, "stats.allTenants");
  const scope = effectiveScope(search, providerAllowed);
  if (scope === "provider") {
    return { kind: "ready", scope, scopeKey: "provider", tenantName: null, providerAllowed };
  }
  if (!activeTenant) {
    return { kind: "noTenant", providerAllowed };
  }
  if (!isProviderAdmin && activeTenant.role !== "tenant_admin") {
    return { kind: "notAdmin", tenantName: activeTenant.name };
  }
  return {
    kind: "ready",
    scope,
    scopeKey: `tenant:${activeTenant.id}`,
    tenantName: activeTenant.name,
    providerAllowed,
  };
}

/** The URL state and a setter that writes it back. */
export function useStatsSearch() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = React.useMemo(() => parseStatsSearch(raw), [raw]);
  const navigate = useNavigate();
  const update = React.useCallback(
    (next: StatsSearch) => {
      void navigate({ to: STATS_PATH as never, search: { ...next, view: STATS_VIEW } as never });
    },
    [navigate],
  );
  return { search, update };
}

/**
 * The concrete period of the URL state. It is recomputed when the day
 * changes (the page may stay open over midnight), not on every render, so
 * the query key stays stable within a day.
 */
export function useResolvedPeriod(search: StatsSearch): ResolvedPeriod {
  const [today, setToday] = React.useState(() => toDay(new Date()));
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      const now = toDay(new Date());
      setToday((current) => (current === now ? current : now));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return React.useMemo(() => resolvePeriod(search, dayStart(today)), [search, today]);
}

/** The figures of one view; every period parameter is part of the query key. */
export function useStatsOverview(access: StatsAccess, period: ResolvedPeriod) {
  const ready = access.kind === "ready";
  const scope: StatsScope = ready ? access.scope : "tenant";
  const params = React.useMemo<StatsParams>(() => statsParams(period, scope), [period, scope]);
  const query = useQuery({
    queryKey: statsKeys.overview(ready ? access.scopeKey : "none", params),
    queryFn: () => fetchStats(params),
    enabled: ready,
    staleTime: 60_000,
    // A 403 or 404 will not change by asking again right away.
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status < 500) && failureCount < 2,
  });
  return { query, params };
}

/**
 * Downloads with progress and outcome as toasts. `pending(key)` tells which
 * download is running, so its button can show that and ignore repeat clicks.
 */
export function useDownloads() {
  const { t } = useTranslation(STATS_NAMESPACE);
  const { t: tc } = useTranslation();
  const [running, setRunning] = React.useState<ReadonlySet<string>>(() => new Set());
  const active = React.useRef(new Set<string>());

  const start = React.useCallback(
    async (key: string, request: DownloadRequest, preparing: string) => {
      if (active.current.has(key)) {
        return;
      }
      active.current.add(key);
      setRunning(new Set(active.current));
      const toastId = toast.loading(preparing);
      try {
        const filename = await downloadFile(request);
        toast.success(t("download.done"), { id: toastId, description: filename });
      } catch (error) {
        toast.error(t("download.failed"), {
          id: toastId,
          description: tc(errorMessageKey(error)),
        });
      } finally {
        active.current.delete(key);
        setRunning(new Set(active.current));
      }
    },
    [t, tc],
  );

  const pending = React.useCallback((key: string) => running.has(key), [running]);
  return React.useMemo(() => ({ start, pending }), [start, pending]);
}
