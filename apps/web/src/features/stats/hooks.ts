import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components/ui/sonner";
import { ApiError, errorMessageKey } from "@/lib/api";
import { type SessionContextValue, hasFeature, useSession } from "@/lib/session";

import { type StatsParams, fetchStats, statsKeys, statsParams } from "./api.js";
import { type DownloadRequest, downloadFile } from "./download.js";
import { STATS_NAMESPACE } from "./i18n.js";
import {
  ALL_TENANTS_STATS_PATH,
  type ResolvedPeriod,
  STATS_PATH,
  STATS_VIEW,
  type StatsScope,
  type StatsSearch,
  dayStart,
  parseStatsSearch,
  resolvePeriod,
  toDay,
} from "./period.js";

/** Roles that may open the statistics (the API enforces the same). */
export const STATS_ROLES = ["provider_admin", "tenant_admin"] as const;

/** Roles that may open the statistics of all tenants (the API also wants every tenant). */
export const ALL_TENANTS_STATS_ROLES = ["provider_admin"] as const;

export type StatsAccess =
  | { kind: "loading" }
  | { kind: "noTenant"; providerAllowed: boolean }
  | { kind: "notAdmin"; tenantName: string }
  /** The page of all tenants, for someone who may not see it (or an installation without it). */
  | { kind: "providerUnavailable"; hasTenant: boolean }
  | {
      kind: "ready";
      scope: StatsScope;
      /** Cache scope: the provider totals or one tenant. */
      scopeKey: string;
      tenantName: string | null;
      /** The viewer may also open the statistics of all tenants. */
      providerAllowed: boolean;
    };

type AccessSession = Pick<
  SessionContextValue,
  "isProviderAdmin" | "providerAllTenants" | "features"
>;

/**
 * Whether the session may see the statistics of all tenants: a provider admin
 * whose team role covers every tenant, where the installation enables the
 * gated feature `stats.allTenants` (Service Provider). The API applies the same
 * rules (apps/api features/stats/routes.ts).
 */
export function mayViewAllTenantsStats(session: AccessSession): boolean {
  return (
    session.isProviderAdmin &&
    session.providerAllTenants !== false &&
    hasFeature(session, "stats.allTenants")
  );
}

/**
 * What the signed-in user may see on the statistics page of `scope`. The
 * tenant scope (Overview › Statistics) is always the active tenant, and only
 * for its admins (provider admins in every tenant they may enter); the
 * provider scope is its own page for those {@link mayViewAllTenantsStats} lets in.
 */
export function useStatsAccess(scope: StatsScope): StatsAccess {
  const session = useSession();
  const { status, isProviderAdmin, activeTenant } = session;
  if (status !== "authenticated") {
    return { kind: "loading" };
  }
  const providerAllowed = mayViewAllTenantsStats(session);
  if (scope === "provider") {
    return providerAllowed
      ? { kind: "ready", scope, scopeKey: "provider", tenantName: null, providerAllowed }
      : { kind: "providerUnavailable", hasTenant: activeTenant !== null };
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

/** Where the statistics of `scope` live, with the search that opens them. */
export function statsLocation(
  scope: StatsScope,
  search: StatsSearch,
): { to: string; search: Record<string, unknown> } {
  return scope === "provider"
    ? { to: ALL_TENANTS_STATS_PATH, search: { ...search } }
    : { to: STATS_PATH, search: { ...search, view: STATS_VIEW } };
}

/** The URL state of the statistics page of `scope` and a setter that writes it back. */
export function useStatsSearch(scope: StatsScope) {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = React.useMemo(() => parseStatsSearch(raw), [raw]);
  const navigate = useNavigate();
  const update = React.useCallback(
    (next: StatsSearch) => {
      const target = statsLocation(scope, next);
      void navigate({ to: target.to as never, search: target.search as never });
    },
    [navigate, scope],
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
