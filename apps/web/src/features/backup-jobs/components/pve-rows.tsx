import { Link } from "@tanstack/react-router";
import { CalendarClock, Clock, Hand, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { RelativeTime, StatusBadge } from "@/components/kit";
import type { PveGuest, PveJob, PveOverview } from "@/features/pve/api";
import { BackupProgress } from "@/features/pve/backup-progress";
import { guestTo, pveTo } from "@/features/pve/paths";

import type { BackupJob, JobState } from "../api.js";
import { JobStateBadge } from "./job-cells.js";

/**
 * Proxmox VE in the job list of Servers & clients (#53). Machine jobs and Proxmox VE jobs are
 * two models (backup_jobs and pve_jobs); the list shows both, with the type as a column. A
 * Proxmox VE job's row carries its scheduled round while it goes ("2 of 5 guests done"); a
 * backup asked for by hand ("Back up now", or one started in PVE) shows as a row of its own,
 * "Manual backup · web01", until it ends, and leads to the guest's page.
 */

export type PveListRow =
  | { rowType: "pve"; id: string; name: string; job: PveJob }
  | { rowType: "manual"; id: string; name: string; guest: PveGuest };

/** A row of the job list: a machine job, or one of Proxmox VE. */
export type JobsListRow = BackupJob | PveListRow;

export function isPveRow(row: JobsListRow): row is PveListRow {
  return "rowType" in row;
}

export function guestName(guest: Pick<PveGuest, "name" | "kind" | "vmid">): string {
  return guest.name?.trim() || `${guest.kind === "vm" ? "VM" : "CT"} ${guest.vmid}`;
}

/**
 * The rows of Proxmox VE: every job, and every guest whose backup waits or runs outside a
 * job's scheduled round. `manualName` makes the row's name ("Manual backup · web01").
 */
export function pveListRows(
  overview: PveOverview | undefined,
  manualName: (guest: string) => string,
): PveListRow[] {
  if (!overview) {
    return [];
  }
  const jobs = new Set(overview.jobs.map((job) => job.id));
  const rows: PveListRow[] = overview.jobs.map((job) => ({
    rowType: "pve",
    id: `pve:${job.id}`,
    name: job.name,
    job,
  }));
  for (const guest of overview.guests) {
    if (!guest.activity) continue;
    // A server before 0.4.0 does not say whose backup it is: then it is not listed here.
    if (guest.activityJobId === undefined) continue;
    if (guest.activityJobId !== null && jobs.has(guest.activityJobId)) continue;
    rows.push({
      rowType: "manual",
      id: `pve-guest:${guest.id}`,
      name: manualName(guestName(guest)),
      guest,
    });
  }
  return rows;
}

/** How a Proxmox VE job stands, in the words of the machine jobs' states. */
export function pveJobState(job: PveJob): JobState {
  if (!job.enabled) return "paused";
  if ((job.round?.running ?? 0) > 0) return "running";
  if ((job.round?.queued ?? 0) > 0) return "queued";
  if (!job.scopeAll && (job.guestCount ?? 0) === 0) return "empty";
  if (!job.schedule) return "manual";
  return "ok";
}

export function PveNameCell({ row }: { row: PveListRow }) {
  const { t } = useTranslation("backupjobs");
  const target = row.rowType === "pve" ? pveTo() : guestTo(row.guest.id);
  return (
    <div className="min-w-0 space-y-1">
      <Link
        {...target}
        className="block truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
        title={row.name}
        onClick={(event) => event.stopPropagation()}
      >
        {row.name}
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        {row.rowType === "pve" ? (
          <>
            <JobStateBadge state={pveJobState(row.job)} />
            {row.job.recommended ? (
              <StatusBadge tone="muted" className="whitespace-nowrap">
                {t("list.pve.recommended")}
              </StatusBadge>
            ) : null}
          </>
        ) : (
          <JobStateBadge state={row.guest.activity === "running" ? "running" : "queued"} />
        )}
      </div>
    </div>
  );
}

export function PveTypeCell({ row }: { row: JobsListRow }) {
  const { t } = useTranslation("backupjobs");
  return (
    <span className="whitespace-nowrap text-muted-foreground">
      {isPveRow(row) ? t("list.type.pve") : t("list.type.endpoint")}
    </span>
  );
}

export function PveScopeCell({ row }: { row: PveListRow }) {
  const { t } = useTranslation("backupjobs");
  if (row.rowType === "manual") {
    const guest = row.guest;
    return (
      <span>
        {guest.kind === "vm" ? "VM" : "CT"} {guest.vmid}
        {guest.node ? ` · ${guest.node}` : ""}
      </span>
    );
  }
  const count = row.job.guestCount ?? 0;
  return (
    <div className="min-w-0">
      <div>{t("list.pve.guests", { count })}</div>
      {row.job.scopeAll ? (
        <div className="text-xs text-muted-foreground">{t("list.pve.scopeAll")}</div>
      ) : null}
    </div>
  );
}

export function PveScheduleCell({ row }: { row: PveListRow }) {
  const { t } = useTranslation("backupjobs");
  if (row.rowType === "manual") {
    return (
      <span className="flex items-start gap-1.5 text-muted-foreground">
        <Hand aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {t("list.pve.manualSchedule")}
      </span>
    );
  }
  const schedule = row.job.schedule;
  const text = !schedule
    ? t("list.pve.noSchedule")
    : schedule.kind === "daily"
      ? t("auto.schedule.daily", { time: schedule.timeOfDay ?? "" })
      : t("auto.schedule.intervalHours", {
          hours: Math.round((schedule.intervalMinutes ?? 0) / 60),
        });
  return (
    <div className="min-w-0">
      <div className="flex items-start gap-1.5">
        <CalendarClock
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <span>{text}</span>
      </div>
      {schedule ? <div className="text-xs text-muted-foreground">{schedule.timeZone}</div> : null}
    </div>
  );
}

/**
 * The last run of a Proxmox VE row: while a round goes, how many of its guests are done, run and
 * wait; for a manual backup its progress (#51) or that it waits for the node.
 */
export function PveLastRunCell({ row }: { row: PveListRow }) {
  const { t } = useTranslation("backupjobs");
  if (row.rowType === "manual") {
    const guest = row.guest;
    return guest.activity === "running" ? (
      <BackupProgress
        progress={guest.progress}
        name={guestName(guest)}
        node={guest.activityNode}
        to={guestTo(guest.id)}
      />
    ) : (
      <StatusBadge tone="muted" icon={Clock} className="whitespace-nowrap">
        {t("list.pve.waiting")}
      </StatusBadge>
    );
  }
  const round = row.job.round;
  return (
    <div className="flex flex-col items-start gap-1">
      {round ? (
        <>
          <StatusBadge
            tone="info"
            icon={LoaderCircle}
            className="whitespace-nowrap [&>svg]:motion-safe:animate-spin"
            data-slot="pve-round"
          >
            {t("list.pve.round", { done: round.done, total: round.total })}
          </StatusBadge>
          <span className="text-xs text-muted-foreground">
            {[
              round.running > 0 ? t("lastRun.running", { count: round.running }) : null,
              round.queued > 0 ? t("lastRun.queued", { count: round.queued }) : null,
              round.failed > 0 ? t("lastRun.failed", { count: round.failed }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </>
      ) : null}
      {row.job.lastRunAt ? (
        <RelativeTime value={row.job.lastRunAt} focusable={false} />
      ) : round ? null : (
        <span className="text-muted-foreground">{t("lastRun.never")}</span>
      )}
    </div>
  );
}

export function PveNextRunCell({ row }: { row: PveListRow }) {
  const { t } = useTranslation("backupjobs");
  if (row.rowType === "pve" && row.job.nextRunAt) {
    return <RelativeTime value={row.job.nextRunAt} focusable={false} />;
  }
  return (
    <span className="text-muted-foreground">
      {row.rowType === "pve" && !row.job.enabled ? t("nextRun.paused") : "–"}
    </span>
  );
}
