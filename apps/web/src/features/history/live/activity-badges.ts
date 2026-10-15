import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import {
  type BackupJobList,
  backupJobKeys,
  fetchBackupJobs,
  type JobKind,
} from "@/features/backup-jobs/api";
import { refreshIntervalOf } from "@/features/backup-jobs/hooks";
import { ACTIVE_REFRESH_MS, fetchOverview, type PveOverview, pveKeys } from "@/features/pve/api";
import { guestTo } from "@/features/pve/paths";
import type { NavActivity, NavBadge } from "@/lib/navigation";
import { useSession } from "@/lib/session";

import { historyKeys, type Run } from "../api";
import {
  type ActivityArea,
  activityFromGuests,
  activityFromJobs,
  activityFromLive,
  isBusy,
} from "./activity";
import type { LiveDefinitions } from "./apply";
import { useLiveRuns, useLiveState } from "./provider";

/**
 * The counts on the sidebar's "Jobs" entries and on "VMs & containers": the backups that run now,
 * with a spinner, and those that wait. They come from the live channel, which the shell holds open
 * anyway, so the menu costs no request of its own; while the channel is not connected (it retries,
 * the server refused it, or it was closed for the background) the entries read the list of backup
 * jobs instead, at that list's own pace. Proxmox VE is not on the channel: its entry reads the
 * overview of the VMs and containers page (the same cached query), which polls quickly only while
 * a guest backs up.
 */

const NO_DEFINITIONS: LiveDefinitions = {};

/** The channel states in which the entries read the job list instead. */
const FALLBACK_STATES: ReadonlySet<string> = new Set(["reconnecting", "closed", "paused"]);

function useScope() {
  const session = useSession();
  return {
    tenantId: session.activeTenant?.id ?? null,
    enabled: session.status === "authenticated" && session.activeTenant !== null,
  };
}

function useLiveDefinitions(tenantId: string | null): LiveDefinitions {
  const query = useQuery<LiveDefinitions>({
    queryKey: historyKeys.liveDefinitions(tenantId),
    queryFn: () => NO_DEFINITIONS,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  return query.data ?? NO_DEFINITIONS;
}

/** "2 backups running, 1 waiting": what the entry's tooltip and a screen reader say. */
export function useActivityLabel(): (activity: NavActivity) => string {
  // The menu's words live in the common namespace.
  const { t: tc } = useTranslation();
  return (activity) =>
    [
      activity.running > 0 ? tc("nav.activity.running", { count: activity.running }) : null,
      activity.queued > 0 ? tc("nav.activity.queued", { count: activity.queued }) : null,
    ]
      .filter((part): part is string => part !== null)
      .join(", ");
}

function badgeOf(activity: NavActivity, label: string): NavBadge {
  return { count: activity.running, label, activity };
}

/** The label of a running backup in the list: its job, with the account or machine. */
function runLabel(run: Run): string {
  const parts = [run.job?.name, run.subject?.name].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : run.id;
}

function useJobsActivity(area: ActivityArea): NavBadge | null {
  const { tenantId, enabled } = useScope();
  const state = useLiveState();
  const runs = useLiveRuns();
  const definitions = useLiveDefinitions(tenantId);
  const label = useActivityLabel();
  const fallback = state !== null && FALLBACK_STATES.has(state.status);
  const jobs = useQuery<BackupJobList>({
    queryKey: backupJobKeys.list(tenantId, area as JobKind),
    queryFn: () => fetchBackupJobs(area as JobKind),
    enabled: enabled && fallback,
    refetchInterval: (query) => (fallback ? refreshIntervalOf(query.state.data?.items) : false),
  });
  const activity =
    fallback && jobs.data
      ? activityFromJobs(jobs.data.items, area)
      : activityFromLive(runs, definitions, area, runLabel);
  return isBusy(activity) ? badgeOf(activity, label(activity)) : null;
}

/** "Jobs" under Mail & SaaS. */
export function useMailJobsActivity(): NavBadge | null {
  return useJobsActivity("mail");
}

/** "Jobs" under Servers & clients. */
export function useEndpointJobsActivity(): NavBadge | null {
  return useJobsActivity("endpoint");
}

const guestPath = (id: string) => String(guestTo(id).to);

/** How often the menu asks Proxmox VE while no guest backs up; its own page asks more often. */
export const PVE_IDLE_REFRESH_MS = 60_000;

/**
 * Quickly while a guest backs up or waits, now and then while none does, and not at all without
 * Proxmox VE (no cluster connected, or an installation that answers with an error).
 */
export function pveRefreshMs(
  status: "pending" | "error" | "success",
  data: PveOverview | undefined,
): number | false {
  if (status === "error" || (data && data.clusters.length === 0)) {
    return false;
  }
  return data?.guests.some((guest) => guest.activity) ? ACTIVE_REFRESH_MS : PVE_IDLE_REFRESH_MS;
}

/** "VMs & containers": the guests that back up now or wait for their node. */
export function usePveActivity(): NavBadge | null {
  const { tenantId, enabled } = useScope();
  const label = useActivityLabel();
  const overview = useQuery<PveOverview>({
    queryKey: pveKeys.overview(tenantId),
    queryFn: fetchOverview,
    enabled,
    refetchInterval: (query) => pveRefreshMs(query.state.status, query.state.data),
  });
  const activity = activityFromGuests(overview.data?.guests ?? [], guestPath);
  return isBusy(activity) ? badgeOf(activity, label(activity)) : null;
}
