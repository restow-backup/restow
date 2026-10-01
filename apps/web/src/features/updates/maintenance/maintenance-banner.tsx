import { Link } from "@tanstack/react-router";
import { Loader2, TriangleAlert, Wrench } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

import "../i18n";
import { formatClock, spanLabel } from "../presenters";
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
    default:
      return null;
  }
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
  const starting = remaining !== null && remaining <= 0;

  return (
    <div data-slot="maintenance-banner" data-variant="scheduled">
      <output aria-live="off" className={cn(BAR_CLASS, "border-warning/40 bg-warning/10")}>
        <Wrench className="mt-0.5 size-4 shrink-0 text-warning-text sm:mt-0" aria-hidden="true" />
        <span className="block min-w-0 flex-1 tabular-nums [overflow-wrap:anywhere]">
          {starting
            ? t("maintenance.banner.starting", { product, version })
            : t("maintenance.banner.scheduled", {
                product,
                version,
                time: formatClock(remaining ?? 0),
              })}
        </span>
      </output>
      <Announcement remaining={remaining} product={product} version={version} />
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
}: {
  remaining: number | null;
  product: string;
  version: string;
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
    text = t("maintenance.announce.start", {
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
          {t("maintenance.banner.running", {
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
