import { Link } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/kit";
import { RateSparkline } from "@/features/dashboard/components/rate-sparkline";
import { itemFromPve, type RatePoint } from "@/features/dashboard/running-model";
import { useRunningSeries } from "@/features/dashboard/use-running";
import type { PveRunning } from "@/features/history/api";
import { useLivePveRuns, useLiveState } from "@/features/history/live/provider";
import type { PveGuest, PveJob } from "@/features/pve/api";
import { BackupProgress } from "@/features/pve/backup-progress";
import { guestTo } from "@/features/pve/paths";
import { useSession } from "@/lib/session";

import { runsOfPveJob } from "../pve-live.js";
import { guestName } from "./pve-rows.js";

/**
 * The live view of a Proxmox VE job in its detail panel while its round goes: each guest being
 * backed up with its progress bar, the figures its node reported (how much is read, the speed)
 * and a small line of that speed over the last minutes, as a mail job's panel shows its running
 * backup. The runs are the live channel's (the ones the start page's "Running now" shows); a
 * guest's node reports a speed now and then and no series of measurements, so the panel samples
 * it with the same buffer as that widget ({@link useRunningSeries}) while it is open.
 */

/** Running guests from the live channel, with their speed buffered while they are shown. */
interface LiveGuests {
  /** The runs that go on now; empty before the channel's snapshot. */
  runs: PveRunning[];
  points: (key: string) => readonly RatePoint[];
  now: number;
}

/**
 * The live channel's Proxmox VE runs that `select` picks, and the speed history of each: the
 * same items and buffer as the start page's widget, started over for another `scope`.
 */
function useLiveGuests(
  select: (runs: Readonly<Record<string, PveRunning>> | null) => PveRunning[],
  scope: string,
): LiveGuests {
  const { activeTenant } = useSession();
  const livePve = useLivePveRuns();
  const status = useLiveState()?.status ?? null;
  const runs = React.useMemo(() => select(livePve), [select, livePve]);
  const items = React.useMemo(() => runs.map((run) => itemFromPve(run)), [runs]);
  // Points only from a current state: a stale one would draw a line that never was.
  const fresh = livePve !== null && status === "open";
  const series = useRunningSeries(items, `${activeTenant?.id ?? ""}:${scope}`, fresh);
  return { runs, points: series.points, now: series.now };
}

/**
 * What of the job runs, in the panel's State: how its round stands ("3 of 19 guests done ·
 * 3 running · 16 waiting") and, under it, the guests it backs up or boot tests now. Nothing while
 * neither.
 */
export function PveJobActivity({ job }: { job: Pick<PveJob, "id" | "name" | "round"> }) {
  const { t } = useTranslation("backupjobs");
  const { id, name } = job;
  const roundRunning = job.round?.running ?? 0;
  const select = React.useCallback(
    (runs: Readonly<Record<string, PveRunning>> | null) =>
      runsOfPveJob(runs, { id, name, round: { running: roundRunning } }),
    [id, name, roundRunning],
  );
  const live = useLiveGuests(select, `pve-job:${id}`);
  const round = job.round;
  if (!round && live.runs.length === 0) {
    return null;
  }
  return (
    <div className="space-y-3" data-slot="job-sheet-activity">
      {round ? (
        <p className="text-sm">
          {[
            t("list.pve.round", { done: round.done, total: round.total }),
            round.running > 0 ? t("lastRun.running", { count: round.running }) : null,
            round.queued > 0 ? t("lastRun.queued", { count: round.queued }) : null,
            round.failed > 0 ? t("lastRun.failed", { count: round.failed }) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      <PveRunningGuests runs={live.runs} points={live.points} now={live.now} />
    </div>
  );
}

/**
 * A backup asked for by hand, in its panel: the guest's run from the live channel with its speed,
 * or, without the channel, the progress the overview last read.
 */
export function PveGuestActivity({ guest }: { guest: PveGuest }) {
  const guestId = guest.id;
  const select = React.useCallback(
    (runs: Readonly<Record<string, PveRunning>> | null) =>
      Object.values(runs ?? {}).filter((run) => run.guest.id === guestId && run.kind === "backup"),
    [guestId],
  );
  const live = useLiveGuests(select, `pve-guest:${guestId}`);
  if (live.runs.length > 0) {
    return (
      <div data-slot="job-sheet-activity">
        <PveRunningGuests runs={live.runs} points={live.points} now={live.now} />
      </div>
    );
  }
  if (guest.activity !== "running") {
    return null;
  }
  return (
    <div data-slot="job-sheet-activity">
      <BackupProgress
        progress={guest.progress}
        name={guestName(guest)}
        node={guest.activityNode}
        className="max-w-none"
      />
    </div>
  );
}

/** The running guests, one row each (a boot test marked as one); nothing while none runs. */
export function PveRunningGuests({
  runs,
  points,
  now,
}: {
  runs: readonly PveRunning[];
  points: (key: string) => readonly RatePoint[];
  now: number;
}) {
  const { t } = useTranslation("backupjobs");
  if (runs.length === 0) {
    return null;
  }
  return (
    <ul className="space-y-3" aria-label={t("sheet.pveRunning")} data-slot="pve-job-live">
      {runs.map((run) => (
        <PveRunningGuest key={run.id} run={run} points={points(itemFromPve(run).key)} now={now} />
      ))}
    </ul>
  );
}

function PveRunningGuest({
  run,
  points,
  now,
}: {
  run: PveRunning;
  points: readonly RatePoint[];
  now: number;
}) {
  const { t } = useTranslation("backupjobs");
  const guest = run.guest;
  const kind = guest.kind === "vm" ? "VM" : "CT";
  const name = guestName(guest);
  const bootTest = run.kind === "boot_test";
  return (
    <li className="flex items-center gap-3" data-slot="pve-job-live-guest">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
          <Link
            {...guestTo(guest.id)}
            className="min-w-0 truncate rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {name}
          </Link>
          <span className="text-xs text-muted-foreground">
            {kind} {guest.vmid}
          </span>
          {bootTest ? <StatusBadge tone="info">{t("sheet.pveBootTest")}</StatusBadge> : null}
          {run.cancelling ? <StatusBadge tone="warning">{t("stop.stopping")}</StatusBadge> : null}
        </div>
        {/* A boot test reports no figures: it restores, starts and waits, so it has no bar. */}
        {bootTest ? (
          <p className="text-xs text-muted-foreground">{t("sheet.pveBootTestHint")}</p>
        ) : (
          <BackupProgress progress={run.progress} name={name} className="max-w-none" />
        )}
      </div>
      {/* Decoration: the speed under the bar says the same in words. */}
      {bootTest ? null : <RateSparkline points={points} now={now} />}
    </li>
  );
}
