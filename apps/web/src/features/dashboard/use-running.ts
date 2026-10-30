import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { useLivePveRuns, useLiveRuns, useLiveState } from "@/features/history/live/provider";
import { sessionScope, useSession } from "@/lib/session";

import {
  type AllTenantsRunning,
  dashboardKeys,
  fetchAllTenantsRunning,
  type RunningWidget,
} from "./api.js";
import {
  itemsOf,
  limitPve,
  RateHistory,
  type RatePoint,
  type RunningItem,
  SAMPLE_EVERY_MS,
  sortRunning,
  totalSeries,
} from "./running-model.js";

/**
 * Where the "Running now" widget gets its runs, and the throughput history its graphs draw.
 *
 * The tenant's page reads the live channel (the runs and the Proxmox VE runs it follows) once
 * the channel's snapshot is in, and the page's own snapshot (the widget in GET /dashboard)
 * before that and while the channel is not connected: the last state, with a word that live
 * updates are off. "All tenants" has no channel; it asks GET /tenant-running every
 * {@link ALL_RUNNING_REFRESH_MS}, no faster than the live channel's own pace.
 */

/** How often "All tenants" asks again while the page is in front. */
export const ALL_RUNNING_REFRESH_MS = 10_000;

/** What the widget says about how current it is. */
export type RunningFreshness =
  /** Moving on its own. */
  | { kind: "live" }
  /** The live connection is being opened. */
  | { kind: "connecting" }
  /** The connection was lost; the last state stays. */
  | { kind: "reconnecting"; asOf: number | null }
  /** The server offers no live connection here; the last state stays. */
  | { kind: "off"; asOf: number | null }
  /** Asked for again every few seconds ("All tenants"). */
  | { kind: "polling"; seconds: number }
  /** The last refresh failed; the last state stays. */
  | { kind: "refreshFailed"; asOf: number | null };

export interface RunningFeed {
  items: RunningItem[];
  freshness: RunningFreshness;
  /** The state is current: the graphs may take new points from it. */
  fresh: boolean;
  /** More runs are going on than listed. */
  truncated: boolean;
}

function epoch(value: string | null | undefined): number | null {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? null : at;
}

/** The tenant page: the live channel when it has spoken, else the page's snapshot. */
export function useTenantRunning(snapshot: RunningWidget | undefined): RunningFeed {
  const runs = useLiveRuns();
  const pve = useLivePveRuns();
  const state = useLiveState();
  const ready = pve !== null;
  const status = state?.status ?? null;

  return React.useMemo<RunningFeed>(() => {
    // The channel carries one Proxmox VE run beyond the limit: that is how it says "more".
    const listed = ready ? limitPve(Object.values(pve)) : null;
    const items = listed
      ? itemsOf(Object.values(runs), listed.runs)
      : itemsOf(snapshot?.runs ?? [], snapshot?.pve ?? []);
    const asOf = ready ? (state?.lastActivityAt ?? null) : epoch(snapshot?.generatedAt);
    // A live channel is not cut off at the runs it carries; the page's snapshot, once, was.
    const truncated = listed ? listed.truncated : (snapshot?.truncated ?? false);
    if (ready && status === "open") {
      return { items, freshness: { kind: "live" }, fresh: true, truncated };
    }
    if (status === "connecting" || status === "paused") {
      return { items, freshness: { kind: "connecting" }, fresh: false, truncated };
    }
    if (status === "reconnecting") {
      return { items, freshness: { kind: "reconnecting", asOf }, fresh: false, truncated };
    }
    if (status === "open") {
      // Open, but the first snapshot is not in yet: the page's own state stands until it is.
      return { items, freshness: { kind: "connecting" }, fresh: false, truncated };
    }
    return { items, freshness: { kind: "off", asOf }, fresh: false, truncated };
  }, [ready, runs, pve, snapshot, state?.lastActivityAt, status]);
}

export interface AllTenantsFeed extends RunningFeed {
  isPending: boolean;
  /** An answer has been received at some time (it stays while a refresh fails). */
  hasData: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  isFetching: boolean;
  /** The earliest planned start over the tenants. */
  next: AllTenantsRunning["next"];
  unavailable: number;
}

/** "All tenants": every tenant's runs from GET /tenant-running, asked for at a steady pace. */
export function useAllTenantsRunning(): AllTenantsFeed {
  const session = useSession();
  const tenantId = session.activeTenant?.id ?? null;
  const enabled =
    session.status === "authenticated" &&
    tenantId !== null &&
    session.isProviderAdmin &&
    sessionScope(session) === "all";
  const query = useQuery({
    queryKey: dashboardKeys.allRunning(tenantId),
    queryFn: fetchAllTenantsRunning,
    enabled,
    refetchInterval: ALL_RUNNING_REFRESH_MS,
    // Nobody looks while the tab is behind another: no reads for it.
    refetchIntervalInBackground: false,
  });
  const data = query.data;
  const items = React.useMemo(
    () =>
      sortRunning(
        (data?.tenants ?? []).flatMap((tenant) =>
          itemsOf(tenant.runs, tenant.pve, { id: tenant.tenantId, name: tenant.name }),
        ),
      ),
    [data],
  );
  const asOf = query.dataUpdatedAt > 0 ? query.dataUpdatedAt : null;
  const freshness: RunningFreshness = query.isError
    ? { kind: "refreshFailed", asOf }
    : { kind: "polling", seconds: ALL_RUNNING_REFRESH_MS / 1000 };
  return {
    items,
    freshness,
    fresh: query.isSuccess && !query.isError,
    truncated: data?.tenants.some((tenant) => tenant.truncated) ?? false,
    isPending: query.isPending,
    hasData: data !== undefined,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
    isFetching: query.isFetching,
    next: data?.next ?? null,
    unavailable: data?.unavailable ?? 0,
  };
}

export interface RunningSeries {
  /** One run's points, oldest first. */
  points(key: string): readonly RatePoint[];
  /** The total over all runs, one point per few seconds up to `now`. */
  total: RatePoint[];
  /** Some run has said a speed within the window; without, the graph has nothing to draw. */
  hasData: boolean;
  /** The moment the graphs end at. */
  now: number;
}

/**
 * The throughput history of the runs on the page, buffered here: a run with measurements gives
 * its speed from them, every other run is looked at every {@link SAMPLE_EVERY_MS} and adds a
 * point when it has a new report, and only while the state is current (a stale state would draw
 * a flat line that never happened). The history
 * starts over when the scope (the tenant) changes.
 */
export function useRunningSeries(
  items: readonly RunningItem[],
  scopeKey: string,
  fresh: boolean,
): RunningSeries {
  const history = React.useMemo(() => {
    void scopeKey;
    return new RateHistory();
  }, [scopeKey]);
  const itemsRef = React.useRef(items);
  const freshRef = React.useRef(fresh);
  itemsRef.current = items;
  freshRef.current = fresh;
  const [tick, setTick] = React.useState(() => Date.now());

  const take = React.useCallback(() => {
    const now = Date.now();
    for (const item of itemsRef.current) {
      history.sample(item, now, freshRef.current);
    }
    history.prune(now);
    setTick(now);
  }, [history]);

  // A run that appears, or a state that is current again, is taken in at once, not at the next beat.
  const keys = items.map((item) => item.key).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `keys` and `fresh` are what trigger the sample.
  React.useEffect(() => {
    take();
  }, [take, keys, fresh]);

  React.useEffect(() => {
    const timer = setInterval(take, SAMPLE_EVERY_MS);
    return () => clearInterval(timer);
  }, [take]);

  return React.useMemo<RunningSeries>(
    () => ({
      points: (key) => history.points(key),
      total: totalSeries(history.all(), tick),
      hasData: history.all().some((points) => points.length > 0),
      now: tick,
    }),
    [history, tick],
  );
}
