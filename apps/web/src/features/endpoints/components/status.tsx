import {
  Apple,
  CircleSlash,
  Cpu,
  Info,
  Laptop,
  Monitor,
  RotateCcw,
  Server,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { HintTooltip, StatusBadge } from "@/components/kit";
import { StateBadge } from "@/features/verify/components/status";
import { cn } from "@/lib/utils";

import type {
  Attention,
  EndpointOs,
  EndpointProfile,
  EndpointSummary,
  EndpointTask,
  RunKind,
  RunStatus,
} from "../api.js";
import {
  activityKey,
  attentionTone,
  isKnownAttention,
  runBadgeView,
  sortAttention,
  statusView,
  taskOutcomeOf,
  taskStatusView,
} from "../presenters.js";

const OS_ICON: Record<EndpointOs, typeof Terminal> = {
  linux: Terminal,
  darwin: Apple,
  windows: Monitor,
};

/** Operating system and CPU architecture, e.g. "Linux · amd64". */
export function OsLabel({
  os,
  arch,
  className,
}: { os: EndpointOs; arch?: string; className?: string }) {
  const { t } = useTranslation("endpoints");
  const Icon = OS_ICON[os] ?? Cpu;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">
        {t(`os.${os}`)}
        {arch ? <span className="text-muted-foreground"> · {arch}</span> : null}
      </span>
    </span>
  );
}

export function ProfileIcon({
  profile,
  className,
}: { profile: EndpointProfile; className?: string }) {
  const { t } = useTranslation("endpoints");
  const Icon = profile === "server" ? Server : Laptop;
  return (
    <Icon
      role="img"
      aria-label={t(`profile.${profile}`)}
      className={cn("size-4 shrink-0 text-muted-foreground", className)}
    />
  );
}

export function ProfileBadge({ profile }: { profile: EndpointProfile }) {
  const { t } = useTranslation("endpoints");
  return (
    <StatusBadge
      tone="muted"
      icon={profile === "server" ? Server : Laptop}
      className="whitespace-nowrap"
    >
      {t(`profile.${profile}`)}
    </StatusBadge>
  );
}

/** Connected, offline, never connected or revoked. */
export function ConnectionBadge({
  endpoint,
  className,
}: {
  endpoint: Pick<EndpointSummary, "status" | "connection" | "profile">;
  className?: string;
}) {
  const { t } = useTranslation("endpoints");
  const view = statusView(endpoint);
  return (
    <StatusBadge
      tone={view.tone}
      icon={endpoint.status === "revoked" ? CircleSlash : true}
      className={cn("whitespace-nowrap", className)}
    >
      {t(view.key)}
    </StatusBadge>
  );
}

/** A live badge while the agent is working, e.g. "Backup running". */
export function ActivityBadge({
  endpoint,
  className,
}: {
  endpoint: Pick<EndpointSummary, "status" | "agentState" | "latestRun">;
  className?: string;
}) {
  const { t } = useTranslation("endpoints");
  const key = activityKey(endpoint);
  if (!key) {
    return null;
  }
  return (
    <StatusBadge tone="info" live aria-live="polite" className={cn("whitespace-nowrap", className)}>
      {t(key)}
    </StatusBadge>
  );
}

/**
 * The rating of the newest backup, in the same badge every readiness view
 * uses, plus a hint when the last restore test is overdue.
 */
export function ReadinessBadge({
  readiness,
  className,
}: {
  readiness: EndpointSummary["readiness"];
  className?: string;
}) {
  const { t } = useTranslation("endpoints");
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <StateBadge state={readiness.state} overdue={readiness.overdue} />
      {readiness.overdue && readiness.state !== "no_backup" ? (
        <HintTooltip content={t("readiness.overdueHint")}>
          <StatusBadge tone="warning" tabIndex={0} className="whitespace-nowrap">
            {t("readiness.overdue")}
          </StatusBadge>
        </HintTooltip>
      ) : null}
    </div>
  );
}

const RUN_MARK_ICON = { incomplete: RotateCcw, interrupted: Info } as const;

export function RunStatusBadge({
  status,
  kind,
  interrupted = false,
  checkIncomplete = false,
  willRetry = true,
  className,
}: {
  status: RunStatus;
  /** What the run did: a backup that succeeded is neutral, a restore or restore test green. */
  kind?: RunKind;
  /** Every error of the run is an interruption: neutral, not a failure. */
  interrupted?: boolean;
  /** A restore test that could not complete: neutral, it proves nothing about the backup. */
  checkIncomplete?: boolean;
  /** Whether such a test is repeated (not on a revoked machine). */
  willRetry?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("endpoints");
  const view = runBadgeView({ status, kind, interrupted, checkIncomplete }, { willRetry });
  return (
    <StatusBadge
      tone={view.tone}
      icon={view.mark ? RUN_MARK_ICON[view.mark] : view.live ? undefined : true}
      live={view.live}
      className={cn("whitespace-nowrap", className)}
      data-run-mark={view.mark ?? undefined}
    >
      {t(view.key)}
    </StatusBadge>
  );
}

/** How a finished request ended: done, a restore test that could not complete, or failed. */
export function TaskStatusBadge({
  task,
  willRetry = true,
  className,
}: {
  task: Pick<EndpointTask, "kind" | "status" | "errorMessage" | "checkIncomplete">;
  willRetry?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("endpoints");
  const view = taskStatusView(task, taskOutcomeOf(task), { willRetry });
  return (
    <StatusBadge
      tone={view.tone}
      icon={view.mark ? RUN_MARK_ICON[view.mark] : true}
      className={className}
      data-task-mark={view.mark ?? undefined}
    >
      {t(view.key)}
    </StatusBadge>
  );
}

/** What needs an admin's eye, heaviest first; a short label each. */
export function AttentionBadges({
  attention,
  max = 3,
  className,
}: { attention: readonly Attention[]; max?: number; className?: string }) {
  const { t } = useTranslation("endpoints");
  const known = sortAttention(attention.filter(isKnownAttention));
  if (known.length === 0) {
    return <span className="text-muted-foreground">{t("attention.none")}</span>;
  }
  const shown = known.slice(0, max);
  const hidden = known.slice(max);
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {shown.map((item) => (
        <HintTooltip key={item} content={t(`attention.${item}.hint`)}>
          <StatusBadge
            tone={attentionTone(item)}
            icon={TriangleAlert}
            tabIndex={0}
            className="max-w-full shrink text-left"
            data-attention={item}
          >
            {t(`attention.${item}.label`)}
          </StatusBadge>
        </HintTooltip>
      ))}
      {hidden.length > 0 ? (
        <HintTooltip content={hidden.map((item) => t(`attention.${item}.label`)).join(", ")}>
          <StatusBadge tone="muted" tabIndex={0} className="whitespace-nowrap">
            {t("attention.more", { count: hidden.length })}
          </StatusBadge>
        </HintTooltip>
      ) : null}
    </div>
  );
}
