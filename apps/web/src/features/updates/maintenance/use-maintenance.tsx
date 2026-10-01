import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components/ui/sonner";

import { type UpdaterPhase, fetchEdgeStatus, fetchMaintenance } from "../api";
import "../i18n";
import { updatesKeys } from "../hooks";
import { isMaintenanceActive, remainingSeconds, spanLabel } from "../presenters";
import {
  type MaintenanceSnapshot,
  type PollDeps,
  decideReload,
  effectivePhase,
  isAnnouncement,
  nextReloadRecord,
  pollIntervalMs,
  pollMaintenance,
  readDismissedRun,
  readReloadRecord,
  reloadIsBlocked,
  rememberDismissedRun,
  writeReloadRecord,
} from "./maintenance-state";

/**
 * The maintenance state of the running installation, for every signed-in
 * user: polled, independent of the tenant, and quiet. A poll that fails while
 * nothing is going on says nothing (no toast, no error state); one that fails
 * because the server is restarting during an update is "maintenance in
 * progress" and the polling goes on, through the api and the edge.
 */

const DEFAULT_DEPS: PollDeps = {
  fetchApi: fetchMaintenance,
  fetchEdge: () => fetchEdgeStatus(),
  now: () => Date.now(),
};

export interface MaintenanceState {
  /** The latest answer, merged with the edge's status while the api is away; `null` before the first one. */
  snapshot: MaintenanceSnapshot | null;
  /** The phase to act on right now (see `effectivePhase`). */
  phase: UpdaterPhase;
  /** This page saw the current run announced or running. */
  sawActiveRun: boolean;
  /** The run whose result this browser dismissed. */
  dismissedRunId: string | null;
  dismiss: (runId: string) => void;
}

export interface UseMaintenanceOptions {
  /** Reload the page (a test double replaces `window.location.reload`). */
  reload?: () => void;
  /** The sources of a poll (replaced in tests). */
  deps?: PollDeps;
}

/** Polls the maintenance state and reacts to it: announce toast, reload after an update. */
export function useMaintenance(options: UseMaintenanceOptions = {}): MaintenanceState {
  const { reload = () => window.location.reload(), deps = DEFAULT_DEPS } = options;
  const { t } = useTranslation("updates");
  const { t: tc } = useTranslation();
  const queryClient = useQueryClient();

  const query = useQuery<MaintenanceSnapshot>({
    queryKey: updatesKeys.maintenance,
    queryFn: () =>
      pollMaintenance(
        deps,
        queryClient.getQueryData<MaintenanceSnapshot>(updatesKeys.maintenance) ?? null,
      ),
    refetchInterval: (current) => pollIntervalMs(current.state.data),
    refetchOnWindowFocus: true,
    // An error while idle is silent; a real gap never throws (see pollMaintenance).
    retry: false,
    staleTime: 0,
  });
  const snapshot = query.data ?? null;

  const baselineVersion = React.useRef<string | null>(null);
  const previousPhase = React.useRef<UpdaterPhase | null>(null);
  const announced = React.useRef(new Set<string>());
  const [activeRunId, setActiveRunId] = React.useState<string | null>(null);
  const [dismissedRunId, setDismissedRunId] = React.useState<string | null>(() =>
    readDismissedRun(),
  );

  const view = snapshot?.view ?? null;
  const sawActiveRun = activeRunId !== null && view?.runId === activeRunId;

  // What this page learns from each answer: the version it started with, the
  // run it watched, and (once per run) the announcement toast.
  React.useEffect(() => {
    if (!snapshot) {
      return;
    }
    const { view: current } = snapshot;
    if (snapshot.apiReachable && current.runningVersion && baselineVersion.current === null) {
      baselineVersion.current = current.runningVersion;
    }
    if (isMaintenanceActive(current.phase) && current.runId) {
      setActiveRunId(current.runId);
    }
    if (
      isAnnouncement(previousPhase.current, current.phase) &&
      current.runId &&
      !announced.current.has(current.runId)
    ) {
      announced.current.add(current.runId);
      const span = spanLabel(
        remainingSeconds(current.startsAt, Date.now(), snapshot.offsetMs) ?? 0,
      );
      toast.info(
        t("maintenance.announce.start", {
          product: tc("app.name"),
          version: current.targetVersion ?? "",
          time: t(span.key, { count: span.count }),
        }),
        { duration: 12_000 },
      );
    }
    previousPhase.current = current.phase;
  }, [snapshot, t, tc]);

  // Reload once the new version answers, so the browser fetches the new web assets.
  const scheduledReload = React.useRef<string | null>(null);
  const reloadTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    if (!snapshot) {
      return;
    }
    const decision = decideReload({
      snapshot,
      baselineVersion: baselineVersion.current,
      sawActiveRun,
    });
    if (decision.action === "none" || scheduledReload.current === decision.token) {
      return;
    }
    const guard = readReloadRecord();
    // Without session storage a reload could not be remembered, and a page must never reload in a loop.
    if (guard === null || reloadIsBlocked(guard.record, decision.token, Date.now())) {
      return;
    }
    scheduledReload.current = decision.token;
    reloadTimer.current = setTimeout(() => {
      const fresh = readReloadRecord();
      if (fresh === null || reloadIsBlocked(fresh.record, decision.token, Date.now())) {
        return;
      }
      if (writeReloadRecord(nextReloadRecord(fresh.record, decision.token, Date.now()))) {
        reload();
      }
    }, decision.delayMs);
  }, [snapshot, sawActiveRun, reload]);

  React.useEffect(
    () => () => {
      if (reloadTimer.current !== null) {
        clearTimeout(reloadTimer.current);
      }
      reloadTimer.current = null;
      scheduledReload.current = null;
    },
    [],
  );

  const dismiss = React.useCallback((runId: string) => {
    rememberDismissedRun(runId);
    setDismissedRunId(runId);
  }, []);

  const phase = snapshot ? effectivePhase(snapshot, Date.now()) : "idle";
  return { snapshot, phase, sawActiveRun, dismissedRunId, dismiss };
}

const MaintenanceContext = React.createContext<MaintenanceState | null>(null);

/** A fixed state, for static renders (tests, previews) of the banner and the modal. */
export function StaticMaintenanceProvider({
  value,
  children,
}: {
  value: MaintenanceState;
  children: React.ReactNode;
}) {
  return <MaintenanceContext.Provider value={value}>{children}</MaintenanceContext.Provider>;
}

/** Mounted once in the app shell; the banner and the modal read from it. */
export function MaintenanceProvider({
  children,
  ...options
}: UseMaintenanceOptions & { children: React.ReactNode }) {
  const state = useMaintenance(options);
  return <MaintenanceContext.Provider value={state}>{children}</MaintenanceContext.Provider>;
}

/** The shared maintenance state (inside {@link MaintenanceProvider}). */
export function useMaintenanceState(): MaintenanceState {
  const context = React.useContext(MaintenanceContext);
  if (context === null) {
    throw new Error("useMaintenanceState must be used within a MaintenanceProvider");
  }
  return context;
}
