import {
  Cloud,
  Inbox,
  Loader2,
  Mail,
  Radio,
  RotateCcw,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge, badgeVariants } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  JobQueue,
  JobStatus,
  ObjectKind,
  RecoveryReadiness,
  SnapshotState,
  VerifySummary,
} from "@/features/jobs/api";
import {
  READINESS_VARIANT,
  SNAPSHOT_STATE_VARIANT,
  jobStatusDisplay,
} from "@/features/jobs/presenters";
import type { StreamStatus } from "@/features/jobs/sse";
import { useJobFormat } from "@/features/jobs/use-format";
import { cn } from "@/lib/utils";

/**
 * A job's status. Pass `failedItems` (the job's `progress.failed`) so a run
 * that completed with failed items shows as such instead of a plain
 * "Completed", and `queue` so a restore that completed reads as the success it
 * is; any other completed job is neutral, never green.
 */
export function JobStatusBadge({
  status,
  failedItems = 0,
  queue,
  checkIncomplete = false,
}: {
  status: JobStatus;
  failedItems?: number;
  /** The queue of the job; a completed restore is green, any other completed job neutral. */
  queue?: JobQueue;
  /** A restore check that could not complete: neutral, it is repeated (`Job.checkIncomplete`). */
  checkIncomplete?: boolean;
}) {
  const { t } = useTranslation("backup");
  const display = jobStatusDisplay(status, failedItems, queue, checkIncomplete);
  const incomplete = display.key === "jobStatus.checkIncomplete";
  return (
    <Badge variant={display.variant} data-check={incomplete ? "incomplete" : undefined}>
      {status === "active" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
      {display.variant === "warning" ? <TriangleAlert aria-hidden="true" /> : null}
      {incomplete ? <RotateCcw aria-hidden="true" /> : null}
      {t(display.key, display.values)}
    </Badge>
  );
}

export function SnapshotStateBadge({ state }: { state: SnapshotState }) {
  const { t } = useTranslation("backup");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            badgeVariants({ variant: SNAPSHOT_STATE_VARIANT[state] }),
            "cursor-default outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {t(`snapshots.state.${state}`)}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{t(`snapshots.stateHint.${state}`)}</TooltipContent>
    </Tooltip>
  );
}

/** Recovery readiness from the latest restore check, or an honest "not verified yet". */
export function ReadinessBadge({ verify }: { verify: VerifySummary | null }) {
  const { t, relative } = useJobFormat();
  if (!verify) {
    return <Badge variant="warning">{t("readiness.none")}</Badge>;
  }
  const readiness: RecoveryReadiness = verify.recoveryReadiness;
  const checked = relative(verify.checkedAt);
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Badge variant={READINESS_VARIANT[readiness]}>{t(`readiness.${readiness}`)}</Badge>
      {checked ? (
        <span className="text-xs text-muted-foreground">
          {t("readiness.checked", { time: checked })}
        </span>
      ) : null}
    </span>
  );
}

const KIND_ICON = { mailbox: Mail, onedrive: Cloud, imap: Inbox } as const;

export function ObjectKindIcon({ kind, className }: { kind: ObjectKind; className?: string }) {
  const Icon = KIND_ICON[kind];
  return <Icon className={cn("size-4 shrink-0", className)} aria-hidden="true" />;
}

/** Whether the page is receiving live updates, said plainly. */
export function LiveIndicator({ status }: { status: StreamStatus | null }) {
  const { t } = useTranslation("backup");
  if (status === null) {
    return null;
  }
  const open = status === "open";
  const closed = status === "closed";
  const hint = open ? "live.openHint" : closed ? "live.closedHint" : "live.reconnectingHint";
  return (
    <output aria-live="polite" className="inline-flex">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
              open && "text-info-text",
              closed && "text-warning-foreground dark:text-warning",
              !open && !closed && "text-muted-foreground",
            )}
          >
            {open ? (
              <span className="relative flex size-2" aria-hidden="true">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-info opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-info" />
              </span>
            ) : closed ? (
              <WifiOff className="size-3.5" aria-hidden="true" />
            ) : status === "connecting" ? (
              <Radio className="size-3.5" aria-hidden="true" />
            ) : (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            )}
            {t(`live.${status}`)}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{t(hint)}</TooltipContent>
      </Tooltip>
    </output>
  );
}
