import { Link } from "@tanstack/react-router";
import {
  ArrowUpCircle,
  CalendarClock,
  Hourglass,
  Loader2,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { formatDateTime } from "@/lib/format";
import { providerMay } from "@/lib/provider-role";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

import type { BuildSwitchTarget } from "../api";
import { availableUpdateOf, dismissUpdateBanner, isUpdateBannerDismissed } from "../available";
import "../i18n";
import { formatClock, spanLabel, switchKey } from "../presenters";
import { updatesTabLink } from "../settings-link";
import { bannerStateOf } from "./maintenance-state";
import { type AnnouncementStage, nextStage, stageFor, useCountdown } from "./use-countdown";
import { useMaintenanceState } from "./use-maintenance";

/**
 * The bar above the top bar while an update is announced or running, for
 * every signed-in person. It cannot be dismissed while the countdown runs.
 * The visible countdown ticks every second and is silent for assistive
 * technology (`aria-live="off"`); a separate polite region speaks only at the
 * start, at one minute and at ten seconds.
 */
export function MaintenanceBanner() {
  const { snapshot } = useMaintenanceState();
  const { isProviderAdmin } = useSession();
  const state = bannerStateOf({ snapshot, nowMs: Date.now(), isProviderAdmin });

  switch (state.kind) {
    case "scheduled":
      return <ScheduledBanner />;
    case "running":
      return <RunningBanner />;
    case "attention":
      return <AttentionBanner />;
    default: {
      // An update waits for the runs in progress before it is announced (#46).
      const phase = snapshot?.view.jobPause?.phase;
      if (phase === "draining") {
        return <WaitingBanner isProviderAdmin={isProviderAdmin} />;
      }
      // The server is updated; its nodes and agents follow before runs start again (0.4.2).
      if (phase === "fleet") {
        return <FleetBanner isProviderAdmin={isProviderAdmin} />;
      }
      const planned = snapshot?.view.planned;
      if (planned && plannedSoon(planned.startsAt, Date.now())) {
        return <PlannedBanner version={planned.version} startsAt={planned.startsAt} />;
      }
      // Nothing is going on: a newer release is the news (after the first answer, so that an
      // announced update never flashes this bar first).
      return snapshot ? <UpdateAvailableBanner /> : null;
    }
  }
}

/**
 * "Restow 0.4.9 is available" (0.5.0): a slim info bar for the people who may install the update,
 * in the slot of the maintenance bar and below it in priority (an announced, running or planned
 * update, a pause for one and a failed one all come first). It can be closed; this browser
 * remembers that for this version only, so a newer release shows it again. Never shown to tenant
 * users, who are not the ones to install it.
 */
function UpdateAvailableBanner() {
  const { t } = useTranslation("updates");
  const { t: tc } = useTranslation();
  const session = useSession();
  // The closing of this page load, for a browser that cannot remember it.
  const [closed, setClosed] = React.useState<string | null>(null);
  const update = availableUpdateOf(session);
  if (!update || !providerMay(session, "owner")) {
    return null;
  }
  if (closed === update.latest || isUpdateBannerDismissed(update.latest)) {
    return null;
  }
  const link = updatesTabLink();
  const linkClass = "font-medium underline underline-offset-2";
  return (
    <div data-slot="maintenance-banner" data-variant="update-available">
      <div className={cn(BAR_CLASS, "flex-wrap border-info/30 bg-info/10 py-1.5")}>
        <ArrowUpCircle
          className="mt-0.5 size-4 shrink-0 text-info-text sm:mt-0"
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {t("maintenance.availableBanner.text", {
            product: tc("app.name"),
            version: update.latest,
          })}
        </p>
        {update.releaseUrl ? (
          <a
            href={update.releaseUrl}
            target="_blank"
            rel="noreferrer noopener"
            className={linkClass}
          >
            {t("maintenance.availableBanner.notes")}
          </a>
        ) : null}
        <Link to={link.to} search={link.search} className={linkClass}>
          {t("maintenance.availableBanner.open")}
        </Link>
        <button
          type="button"
          aria-label={t("maintenance.availableBanner.dismiss", { version: update.latest })}
          onClick={() => {
            dismissUpdateBanner(update.latest);
            setClosed(update.latest);
          }}
          className="-my-1 -mr-2 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/70 outline-hidden hover:bg-info/20 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** A planned update is announced to everyone from a day before its time. */
export const PLANNED_NOTICE_MS = 24 * 60 * 60 * 1000;

export function plannedSoon(startsAt: string, nowMs: number): boolean {
  const at = Date.parse(startsAt);
  return Number.isFinite(at) && at > nowMs && at - nowMs <= PLANNED_NOTICE_MS;
}

/** An update planned for a chosen time within the next day (0.4.2): when, for everyone. */
function PlannedBanner({ version, startsAt }: { version: string; startsAt: string }) {
  const { t, i18n } = useTranslation("updates");
  const { t: tc } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  return (
    <div data-slot="maintenance-banner" data-variant="planned">
      <div className={cn(BAR_CLASS, "flex-wrap border-info/30 bg-info/10")}>
        <CalendarClock
          className="mt-0.5 size-4 shrink-0 text-info-text sm:mt-0"
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {t("maintenance.banner.planned", {
            product: tc("app.name"),
            version,
            time: formatDateTime(startsAt, language) ?? "",
          })}
        </p>
      </div>
    </div>
  );
}

/**
 * Right after an update, while the Proxmox VE nodes and endpoint agents update themselves
 * (0.4.2): new runs start again once they are done, at the latest at the deadline.
 */
function FleetBanner({ isProviderAdmin }: { isProviderAdmin: boolean }) {
  const { t, i18n } = useTranslation("updates");
  const { t: tc } = useTranslation();
  const { snapshot } = useMaintenanceState();
  const pause = snapshot?.view.jobPause;
  const link = updatesTabLink();
  if (!pause) {
    return null;
  }
  const language = i18n.resolvedLanguage ?? i18n.language;
  return (
    <div data-slot="maintenance-banner" data-variant="fleet">
      <div className={cn(BAR_CLASS, "flex-wrap border-info/30 bg-info/10")}>
        <Hourglass className="mt-0.5 size-4 shrink-0 text-info-text sm:mt-0" aria-hidden="true" />
        <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {t("maintenance.banner.fleet", {
            product: tc("app.name"),
            version: pause.version,
            time: formatDateTime(pause.deadlineAt, language) ?? "",
          })}
        </p>
        {isProviderAdmin ? (
          <Link
            to={link.to}
            search={link.search}
            className="font-medium underline underline-offset-2"
          >
            {t("maintenance.openSettings")}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/**
 * New runs do not start while an update waits for the runs in progress (#46): everyone
 * learns why, and until when at the latest. It goes once the update is announced (the
 * countdown takes over) or cancelled.
 */
function WaitingBanner({ isProviderAdmin }: { isProviderAdmin: boolean }) {
  const { t, i18n } = useTranslation("updates");
  const { snapshot } = useMaintenanceState();
  const pause = snapshot?.view.jobPause;
  const link = updatesTabLink();
  if (!pause) {
    return null;
  }
  const language = i18n.resolvedLanguage ?? i18n.language;
  return (
    <div data-slot="maintenance-banner" data-variant="waiting">
      <div className={cn(BAR_CLASS, "flex-wrap border-info/30 bg-info/10")}>
        <Hourglass className="mt-0.5 size-4 shrink-0 text-info-text sm:mt-0" aria-hidden="true" />
        <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {t("maintenance.banner.waiting", {
            version: pause.version,
            time: formatDateTime(pause.deadlineAt, language) ?? "",
          })}
        </p>
        {isProviderAdmin ? (
          <Link
            to={link.to}
            search={link.search}
            className="font-medium underline underline-offset-2"
          >
            {t("maintenance.openSettings")}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

const BAR_CLASS =
  "flex items-start gap-3 border-b px-4 py-2 text-sm text-foreground sm:items-center";

function ScheduledBanner() {
  const { t } = useTranslation("updates");
  const { t: tc } = useTranslation();
  const { snapshot } = useMaintenanceState();
  const view = snapshot?.view;
  const remaining = useCountdown(view?.startsAt, snapshot?.offsetMs ?? 0);
  const product = tc("app.name");
  const version = view?.targetVersion ?? "";
  const switchTo = view?.switchTo ?? null;
  const starting = remaining !== null && remaining <= 0;

  return (
    <div data-slot="maintenance-banner" data-variant="scheduled">
      <output aria-live="off" className={cn(BAR_CLASS, "border-warning/40 bg-warning/10")}>
        <Wrench className="mt-0.5 size-4 shrink-0 text-warning-text sm:mt-0" aria-hidden="true" />
        <span className="block min-w-0 flex-1 tabular-nums [overflow-wrap:anywhere]">
          {starting
            ? t(switchKey("maintenance.banner.starting", switchTo), { product, version })
            : t(switchKey("maintenance.banner.scheduled", switchTo), {
                product,
                version,
                time: formatClock(remaining ?? 0),
              })}
        </span>
      </output>
      <Announcement remaining={remaining} product={product} version={version} switchTo={switchTo} />
    </div>
  );
}

/**
 * The polite live region of a countdown: its text changes only at the start,
 * at one minute, at ten seconds and at zero, never once a second.
 */
export function Announcement({
  remaining,
  product,
  version,
  switchTo = null,
}: {
  remaining: number | null;
  product: string;
  version: string;
  switchTo?: BuildSwitchTarget | null;
}) {
  const { t } = useTranslation("updates");
  const [stage, setStage] = React.useState<AnnouncementStage>(() => stageFor(remaining));
  // The time named at the start is the time left when the banner appeared.
  const [initialRemaining] = React.useState(remaining);

  React.useEffect(() => {
    setStage((current) => nextStage(current, remaining));
  }, [remaining]);

  let text: string;
  if (stage === "start") {
    const span = spanLabel(initialRemaining ?? 0);
    text = t(switchKey("maintenance.announce.start", switchTo), {
      product,
      version,
      time: t(span.key, { count: span.count }),
    });
  } else {
    text = t(`maintenance.announce.${stage}`);
  }
  return (
    <output className="sr-only" aria-live="polite" aria-atomic="true">
      {text}
    </output>
  );
}

function RunningBanner() {
  const { t } = useTranslation("updates");
  const { t: tc } = useTranslation();
  const { snapshot } = useMaintenanceState();
  return (
    <div data-slot="maintenance-banner" data-variant="running">
      <output aria-live="polite" className={cn(BAR_CLASS, "border-info/30 bg-info/10")}>
        <Loader2
          className="mt-0.5 size-4 shrink-0 text-info-text motion-safe:animate-spin sm:mt-0"
          aria-hidden="true"
        />
        <span className="block min-w-0 flex-1 [overflow-wrap:anywhere]">
          {t(switchKey("maintenance.banner.running", snapshot?.view.switchTo), {
            product: tc("app.name"),
            version: snapshot?.view.targetVersion ?? "",
          })}
        </span>
      </output>
    </div>
  );
}

/** The update failed after the database was migrated: the provider admin keeps being told. */
function AttentionBanner() {
  const { t } = useTranslation("updates");
  const link = updatesTabLink();
  return (
    <div data-slot="maintenance-banner" data-variant="attention">
      <div
        role="alert"
        className={cn(BAR_CLASS, "flex-wrap border-destructive/30 bg-destructive/10")}
      >
        <TriangleAlert
          className="mt-0.5 size-4 shrink-0 text-destructive-text sm:mt-0"
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {t("maintenance.banner.attention")}
        </p>
        <Link
          to={link.to}
          search={link.search}
          className="font-medium underline underline-offset-2"
        >
          {t("maintenance.openSettings")}
        </Link>
      </div>
    </div>
  );
}
