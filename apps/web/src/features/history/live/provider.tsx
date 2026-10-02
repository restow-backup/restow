import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { openEventStream } from "@/features/jobs/sse";
import { sessionScope, useSession } from "@/lib/session";

import { type Run, historyKeys } from "../api";
import { type LiveContext, type LiveRuns, applyEvent, createRefetcher, newKnown } from "./apply";
import {
  type ChannelDeps,
  LiveChannel,
  type LiveState,
  acquireChannel,
  documentVisibility,
} from "./channel";

/**
 * Opens the live channel for the page: one stream per browser tab, however many parts of the
 * page read it. It sits in the shell, so every page moves without a request of its own: job
 * lists and details, History, the overview and the machine pages. It stays off where it has
 * nothing to follow or may not look: under "All tenants" (there is no tenant stream), for people
 * who are not administrators, and while the session is not settled.
 *
 * The state it publishes ({@link useLiveState}) is what the indicator shows and what decides
 * whether a page polls: while the channel is live a page does not, while it is not the pages keep
 * their own, slower polling as before.
 */

/** Only operators may open the stream (the API answers 403 to everyone else). */
const OPERATOR_ROLES: readonly string[] = ["provider_admin", "tenant_admin"];

interface LiveContextValue {
  channel: LiveChannel | null;
}

const LiveChannelContext = React.createContext<LiveContextValue>({ channel: null });

const IDLE_STATE: LiveState | null = null;

const noopSubscribe = () => () => undefined;

/** The channel's state, or null where there is no channel (off, or no provider above). */
export function useLiveState(): LiveState | null {
  const { channel } = React.useContext(LiveChannelContext);
  return React.useSyncExternalStore(
    channel ? channel.subscribe : noopSubscribe,
    channel ? channel.getState : () => IDLE_STATE,
    () => IDLE_STATE,
  );
}

/** Whether the channel is connected and delivering right now. */
export function useLiveOpen(): boolean {
  return useLiveState()?.status === "open";
}

/**
 * The polling interval a query should use: none while the channel delivers, `intervalMs`
 * (the page's own, as before the channel) while it does not.
 */
export function useLivePolling<T extends number | false>(intervalMs: T): T | false {
  return useLiveOpen() ? false : intervalMs;
}

export interface LiveChannelProviderProps {
  children: React.ReactNode;
  /** Replaces the stream opener and the clock (tests). */
  deps?: Partial<ChannelDeps>;
}

export function LiveChannelProvider({ children, deps }: LiveChannelProviderProps) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [channel, setChannel] = React.useState<LiveChannel | null>(null);
  const tenantId = session.activeTenant?.id ?? null;
  const operator = session.role !== null && OPERATOR_ROLES.includes(session.role);
  const enabled =
    session.status === "authenticated" &&
    tenantId !== null &&
    operator &&
    sessionScope(session) === "tenant";
  // The tests' deps are fixed for the life of the provider.
  const depsRef = React.useRef(deps);

  React.useEffect(() => {
    if (!enabled || tenantId === null) {
      setChannel(null);
      return;
    }
    const { refetch, cancel } = createRefetcher(queryClient);
    const context: LiveContext = { client: queryClient, tenantId, refetch, known: newKnown() };
    const handle = acquireChannel(tenantId, () => {
      const channelDeps: ChannelDeps = {
        open: openEventStream,
        now: () => Date.now(),
        visibility: documentVisibility,
        ...depsRef.current,
      };
      return new LiveChannel(tenantId, channelDeps, {
        onEvent: (event) => applyEvent(context, event),
        // A long stay in the background or a long outage: what is on screen may be out of date.
        onStale: () => {
          void queryClient.invalidateQueries({
            predicate: (query) => {
              const [scope, id, domain] = query.queryKey;
              return scope === "tenant" && id === tenantId && LIVE_DOMAINS.has(String(domain));
            },
            refetchType: "active",
          });
        },
      });
    });
    setChannel(handle.channel);
    return () => {
      handle.release();
      cancel();
      setChannel(null);
    };
  }, [enabled, tenantId, queryClient]);

  const value = React.useMemo(() => ({ channel }), [channel]);
  return <LiveChannelContext.Provider value={value}>{children}</LiveChannelContext.Provider>;
}

/** The parts of the cache the channel keeps current; these are read again after a long gap. */
const LIVE_DOMAINS: ReadonlySet<string> = new Set([
  "history",
  "backup-jobs",
  "endpoints",
  "jobs",
  "dashboard",
  "verify",
]);

// --- Reading the live runs -----------------------------------------------------------------------

const NO_RUNS: LiveRuns = {};

/**
 * The runs the channel follows, by id. A page without the channel has none; its rows then have no
 * live progress and read what their own queries brought.
 */
export function useLiveRuns(): LiveRuns {
  const { activeTenant } = useSession();
  const tenantId = activeTenant?.id ?? null;
  const query = useQuery<LiveRuns>({
    queryKey: historyKeys.live(tenantId),
    queryFn: () => NO_RUNS,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  return query.data ?? NO_RUNS;
}

/** One run's live state; undefined while the channel has not named it. */
export function useLiveRun(runId: string | null): Run | undefined {
  const runs = useLiveRuns();
  return runId ? runs[runId] : undefined;
}

/** The runs of a backup job that are going right now, the one started first first. */
export function useRunningRunsOf(jobId: string): Run[] {
  const runs = useLiveRuns();
  return React.useMemo(
    () =>
      Object.values(runs)
        .filter((run) => run.state === "running" && run.job?.id === jobId)
        .sort(
          (a, b) => Date.parse(a.startedAt ?? a.createdAt) - Date.parse(b.startedAt ?? b.createdAt),
        ),
    [runs, jobId],
  );
}
