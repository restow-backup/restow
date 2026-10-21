import { Info, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import {
  ACTIVITY_GROUPS,
  JOB_PAUSE_MODES,
  type JobActivityView,
  type JobPauseMode,
  type UpdatesView,
} from "../api";
import { useJobActivity, useScheduleUpdate } from "../hooks";
import {
  countdownLabel,
  formatReleaseDate,
  isUnverifiableRelease,
  leadTimeLabel,
  offeredLeadTimes,
  updatesErrorKey,
} from "../presenters";
import { ChoiceOption } from "./choice-option";

/** Five minutes ahead is the default: long enough to save work, short enough not to forget it. */
export const DEFAULT_LEAD_SECONDS = 300;

/**
 * The date and time a plan starts from: tomorrow at 22:00 in the installation's zone (the
 * evening is when an update hurts least). Read with the browser's Intl; without a zone, empty.
 */
export function defaultPlannedAt(
  timeZone: string | null,
  now: Date = new Date(),
): { date: string; time: string } {
  if (!timeZone) {
    return { date: "", time: "" };
  }
  try {
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    // en-CA formats a date as YYYY-MM-DD, which a date input takes.
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(tomorrow);
    return { date, time: "22:00" };
  } catch {
    return { date: "", time: "22:00" };
  }
}

/**
 * Runs in progress are stopped cleanly by default (#46): quick, and nothing is lost; runs on
 * agents are waited for.
 */
export const DEFAULT_JOB_MODE: JobPauseMode = "drain";

/**
 * The question before an update: which version, when, what happens to the runs
 * in progress (#46), and what will happen. Confirming announces the
 * maintenance (or starts at once with a lead time of zero); the shell then
 * shows the countdown to everyone signed in. With runs in progress the update
 * can wait for them first, or have them stop cleanly; either way no new run
 * starts from the confirmation until the update is over.
 */
export function InstallDialog({
  view,
  open,
  onOpenChange,
}: {
  view: UpdatesView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation("updates");
  const { t: tc } = useTranslation();
  const schedule = useScheduleUpdate();
  const identity = useConfirmIdentity();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const leadTimes = offeredLeadTimes(view);
  const newest = view.releases[0]?.version ?? "";
  const defaultLead = leadTimes.includes(DEFAULT_LEAD_SECONDS)
    ? DEFAULT_LEAD_SECONDS
    : (leadTimes[0] ?? 0);

  const [version, setVersion] = React.useState(newest);
  const [lead, setLead] = React.useState(defaultLead);
  // When (0.4.2): from now with a lead time, or at a chosen date and time in the installation's
  // time zone (the server keeps the plan and confirms it then; older servers: from now only).
  const timeZone = view.timeZone ?? null;
  const [when, setWhen] = React.useState<"now" | "at">("now");
  const [at, setAt] = React.useState(() => defaultPlannedAt(timeZone));
  const [jobMode, setJobMode] = React.useState<JobPauseMode>(DEFAULT_JOB_MODE);
  const activity = useJobActivity(open);
  // Without counts (they could not be read) the choice is offered all the same.
  const runsInProgress = activity.data ? activity.data.running > 0 : activity.isError;
  // The choice about runs in progress is only offered once they were read (or could not
  // be): before that, a quick confirmation would send "wait" for runs nobody saw.
  const runsSettled = !activity.isPending;
  const waits = runsInProgress && jobMode !== "interrupt";

  // Every opening starts from the newest version and the default lead time.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setVersion(newest);
      setLead(defaultLead);
      setJobMode(DEFAULT_JOB_MODE);
      setWhen("now");
      setAt(defaultPlannedAt(timeZone));
    }
  }
  const { reset } = schedule;
  React.useEffect(() => {
    if (open) {
      reset();
    }
  }, [open, reset]);

  const selected = view.releases.find((release) => release.version === version) ?? view.releases[0];
  const selectedVersion = selected?.version ?? "";
  const unverifiable = isUnverifiableRelease(view, selected);

  const planned = when === "at" && timeZone !== null;
  const atComplete = /^\d{4}-\d{2}-\d{2}$/.test(at.date) && /^\d{2}:\d{2}$/.test(at.time);

  const announce = (input: {
    version: string;
    leadSeconds: number;
    jobs: JobPauseMode;
    at?: { date: string; time: string };
  }) => {
    schedule.mutate(input, {
      onSuccess: () => onOpenChange(false),
      onError: (error) => {
        // Announcing needs a recent sign-in (apps/api lib/recent-sign-in.ts); once the
        // person confirmed it is them, the same choice is sent again.
        if (isRecentSignInRequired(error)) {
          identity.ask(() => announce(input));
        }
      },
    });
  };

  const confirm = () => {
    if (schedule.isPending || !runsSettled || selectedVersion === "" || unverifiable) {
      return;
    }
    if (planned) {
      if (!atComplete) {
        return;
      }
      // Planned: what runs then is unknown now, so the chosen handling of runs goes along.
      announce({ version: selectedVersion, leadSeconds: lead, jobs: jobMode, at });
      return;
    }
    // With nothing in progress the update need not wait; new runs still pause until it is over.
    announce({
      version: selectedVersion,
      leadSeconds: lead,
      jobs: runsInProgress ? jobMode : "wait",
    });
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // The question cannot be abandoned while the request runs.
        if (!next && schedule.isPending) {
          return;
        }
        onOpenChange(next);
      }}
    >
      {/* The body scrolls on a short screen; the title and the buttons stay in reach. */}
      <AlertDialogContent
        className="max-h-[92svh] grid-rows-[auto_minmax(0,1fr)_auto]"
        onEscapeKeyDown={(event) => {
          if (schedule.isPending) {
            event.preventDefault();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t("install.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("install.description")}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="-mx-1 min-h-0 space-y-5 overflow-y-auto px-1 pb-1" data-slot="install-body">
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm leading-none font-medium">
              {t("install.version")}
            </legend>
            <div className="grid gap-2">
              {view.releases.map((release) => {
                const date = formatReleaseDate(release.publishedAt, language);
                return (
                  <ChoiceOption
                    key={release.tag}
                    name="update-version"
                    value={release.version}
                    checked={selectedVersion === release.version}
                    onSelect={setVersion}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-medium">{release.version}</span>
                      {release.version === newest ? (
                        <Badge variant="info">{t("releases.newest")}</Badge>
                      ) : null}
                      {release.prerelease ? (
                        <Badge variant="warning">{t("releases.prerelease")}</Badge>
                      ) : null}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {date ? t("releases.released", { date }) : t("releases.noDate")}
                    </span>
                  </ChoiceOption>
                );
              })}
            </div>
          </fieldset>

          {timeZone ? (
            <fieldset className="space-y-2" data-slot="install-when">
              <legend className="mb-2 text-sm leading-none font-medium">
                {t("install.when.title")}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <ChoiceOption
                  name="update-when"
                  value="now"
                  checked={when === "now"}
                  onSelect={() => setWhen("now")}
                >
                  <span className="block font-medium">{t("install.when.now")}</span>
                </ChoiceOption>
                <ChoiceOption
                  name="update-when"
                  value="at"
                  checked={when === "at"}
                  onSelect={() => setWhen("at")}
                >
                  <span className="block font-medium">{t("install.when.at")}</span>
                </ChoiceOption>
              </div>
              {planned ? (
                <div className="flex flex-wrap items-end gap-3" data-slot="install-at">
                  <label className="grid gap-1 text-sm">
                    <span className="font-medium">{t("install.when.date")}</span>
                    <input
                      type="date"
                      required
                      className="h-9 rounded-md border bg-background px-2 text-sm"
                      value={at.date}
                      onChange={(event) =>
                        setAt((current) => ({ ...current, date: event.target.value }))
                      }
                    />
                  </label>
                  <label className="grid gap-1 text-sm">
                    <span className="font-medium">{t("install.when.time")}</span>
                    <input
                      type="time"
                      required
                      className="h-9 rounded-md border bg-background px-2 text-sm"
                      value={at.time}
                      onChange={(event) =>
                        setAt((current) => ({ ...current, time: event.target.value }))
                      }
                    />
                  </label>
                  <p className="pb-2 text-xs text-muted-foreground" data-slot="install-zone">
                    {t("install.when.zone", { zone: timeZone })}
                  </p>
                </div>
              ) : null}
            </fieldset>
          ) : null}

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm leading-none font-medium">
              {planned ? t("install.when.countdown") : t("install.lead")}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {leadTimes.map((seconds) => {
                const label = planned ? countdownLabel(seconds) : leadTimeLabel(seconds);
                return (
                  <ChoiceOption
                    key={seconds}
                    name="update-lead"
                    value={String(seconds)}
                    checked={lead === seconds}
                    onSelect={(value) => setLead(Number(value))}
                  >
                    <span className="block font-medium">{t(label.key, label.params)}</span>
                  </ChoiceOption>
                );
              })}
            </div>
          </fieldset>

          <RunsInProgress
            activity={activity.data}
            loading={activity.isPending}
            failed={activity.isError && !activity.data}
            choose={runsInProgress || planned}
            mode={jobMode}
            onModeChange={setJobMode}
          />

          {unverifiable ? (
            <Alert variant="warning" data-slot="release-unverifiable">
              <TriangleAlert />
              <AlertDescription>{t("install.unverifiable")}</AlertDescription>
            </Alert>
          ) : null}

          {selected?.prerelease ? (
            <Alert variant="warning">
              <TriangleAlert />
              <AlertDescription>{t("install.prerelease")}</AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-2">
            <p className="text-sm font-medium">{t("install.effects.title")}</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t("install.effects.downtime")}</li>
              <li>{t("install.effects.backup")}</li>
              <li>{t("install.effects.rollback")}</li>
              <li>
                {waits ? t("install.effects.countdownAfterRuns") : t("install.effects.countdown")}
              </li>
              <li>
                {view.mode === "image"
                  ? t("install.effects.modeImage")
                  : t("install.effects.modeSource", { tag: selected?.tag ?? "" })}
              </li>
            </ul>
          </div>
          {schedule.isError ? (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>{t(updatesErrorKey(schedule.error))}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={schedule.isPending}>
            {tc("actions.cancel")}
          </AlertDialogCancel>
          <Button
            type="button"
            onClick={confirm}
            loading={schedule.isPending}
            disabled={unverifiable || !runsSettled || (planned && !atComplete)}
          >
            {planned
              ? t("install.confirmPlanned")
              : waits
                ? t("install.confirmAfterRuns")
                : lead === 0
                  ? t("install.confirmNow")
                  : t("install.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
      {identity.dialog}
    </AlertDialog>
  );
}

/**
 * What runs and waits right now, in every tenant, and what happens to it (#46): wait until
 * it is done, stop it cleanly, or do not wait. New runs pause in every case.
 */
function RunsInProgress({
  activity,
  loading,
  failed,
  choose,
  mode,
  onModeChange,
}: {
  activity: JobActivityView | undefined;
  loading: boolean;
  failed: boolean;
  choose: boolean;
  mode: JobPauseMode;
  onModeChange: (mode: JobPauseMode) => void;
}) {
  const { t } = useTranslation("updates");
  const groups = activity
    ? ACTIVITY_GROUPS.filter((group) => activity[group].running + activity[group].queued > 0)
    : [];
  return (
    <fieldset className="space-y-2" data-slot="install-runs" aria-busy={loading}>
      <legend className="mb-2 text-sm leading-none font-medium">{t("install.runs.title")}</legend>
      {loading ? (
        <p className="text-sm text-muted-foreground">{t("install.runs.checking")}</p>
      ) : failed ? (
        <p className="text-sm text-muted-foreground" data-slot="install-runs-failed">
          {t("install.runs.failed")}
        </p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-slot="install-runs-none">
          {t("install.runs.none")}
        </p>
      ) : (
        <ul className="space-y-1 text-sm" data-slot="install-runs-list">
          {groups.map((group) => (
            <li key={group} className="flex flex-wrap justify-between gap-x-3" data-group={group}>
              <span>{t(`install.runs.groups.${group}`)}</span>
              <span className="text-muted-foreground tabular-nums">
                {t("install.runs.count", {
                  running: activity?.[group].running ?? 0,
                  queued: activity?.[group].queued ?? 0,
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {choose ? (
        <div className="grid gap-2 pt-1" data-slot="install-run-modes">
          {JOB_PAUSE_MODES.map((value) => (
            <ChoiceOption
              key={value}
              name="update-runs"
              value={value}
              checked={mode === value}
              onSelect={(next) => onModeChange(next as JobPauseMode)}
            >
              <span className="block font-medium">{t(`install.runs.modes.${value}.title`)}</span>
              <span className="block text-xs text-muted-foreground">
                {t(`install.runs.modes.${value}.description`)}
              </span>
            </ChoiceOption>
          ))}
        </div>
      ) : null}
      <Alert variant="info" data-slot="install-runs-pause">
        <Info />
        <AlertDescription>{t("install.runs.pause")}</AlertDescription>
      </Alert>
    </fieldset>
  );
}
