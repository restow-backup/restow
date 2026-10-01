import { Ban, ChevronDown, DatabaseBackup, Play, RotateCcw } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { BackupSkipReason, BackupTarget, Job, StartBackupResult } from "@/features/jobs/api";
import { isLive, objectLabel } from "@/features/jobs/presenters";
import { useCancelJob, useRetryJob, useStartBackup } from "@/features/jobs/use-jobs";
import { ApiError, errorMessageKey } from "@/lib/api";

const SKIP_REASONS: ReadonlySet<string> = new Set<BackupSkipReason>([
  "excluded",
  "orphaned",
  "source_pending",
  "source_disabled",
  "already_queued",
]);

/** The i18n key (namespace `backup`) for a refused action, or null for a generic error. */
function refusalKey(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) {
    return null;
  }
  const reason = error.problem?.reason;
  if (reason === "already_queued") {
    return "toast.alreadyQueued";
  }
  return typeof reason === "string" && SKIP_REASONS.has(reason) ? `blocked.${reason}` : null;
}

/** Toasts for the outcome of a job action, in operator language. */
function useActionFeedback() {
  const { t } = useTranslation("backup");
  const { t: tc } = useTranslation();

  return React.useMemo(
    () => ({
      queued(result: StartBackupResult, name?: string) {
        const count = result.queued.length;
        if (count === 0) {
          toast.warning(t("toast.nothingQueued"));
          return;
        }
        toast.success(
          name && count === 1 ? t("toast.queuedOne", { name }) : t("toast.queuedMany", { count }),
          {
            description:
              result.skipped.length > 0
                ? t("toast.skipped", { count: result.skipped.length })
                : undefined,
          },
        );
      },
      failed(error: unknown) {
        const key = refusalKey(error);
        toast.error(key ? t(key) : t("toast.failed"), {
          description: key ? undefined : tc(errorMessageKey(error)),
        });
      },
    }),
    [t, tc],
  );
}

/** Why "Back up now" is unavailable for a target, as an i18n key, or null. */
export function backupUnavailableKey(target: BackupTarget): string | null {
  if (target.blocked) {
    return `blocked.${target.blocked}`;
  }
  if (target.lastJob && isLive(target.lastJob.status)) {
    return "blocked.already_queued";
  }
  return null;
}

/**
 * "Back up now" for one object: the main button backs up the changes since
 * the last snapshot, the menu offers a full re-read. When the object cannot
 * run, the button is unavailable and says why.
 */
export function BackupNowButton({ target }: { target: BackupTarget }) {
  const { t } = useTranslation("backup");
  const start = useStartBackup();
  const feedback = useActionFeedback();
  const unavailable = backupUnavailableKey(target);
  const name = objectLabel(target);

  const run = (full: boolean) =>
    start.mutate(
      { protectedObjectId: target.id, full },
      {
        onSuccess: (result) => feedback.queued(result, name),
        onError: (error) => feedback.failed(error),
      },
    );

  if (unavailable) {
    // `aria-disabled` keeps the button focusable, so keyboard users reach the reason too.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            aria-disabled="true"
            className="cursor-not-allowed opacity-50"
            onClick={(event) => event.preventDefault()}
          >
            <Play aria-hidden="true" />
            {t("actions.backupNow")}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t(unavailable)}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="inline-flex">
      <Button
        size="sm"
        variant="outline"
        className="rounded-r-none"
        loading={start.isPending}
        onClick={() => run(false)}
      >
        {start.isPending ? null : <Play aria-hidden="true" />}
        {t("actions.backupNow")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="-ml-px rounded-l-none px-2"
            disabled={start.isPending}
            aria-label={t("actions.backupNowFull")}
          >
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem className="flex-col items-start gap-0.5" onSelect={() => run(false)}>
            <span className="font-medium">{t("actions.backupNowIncremental")}</span>
            <span className="text-xs text-muted-foreground">
              {t("actions.backupNowIncrementalHint")}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem className="flex-col items-start gap-0.5" onSelect={() => run(true)}>
            <span className="font-medium">{t("actions.backupNowFull")}</span>
            <span className="text-xs text-muted-foreground">{t("actions.backupNowFullHint")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * "Back up all": queues a backup for every protected object after a
 * confirmation. `label` names the button where the page says it differently
 * ("Back up now" on Setup › Protection); the dialog stays the same.
 */
export function BackupAllButton({ label }: { label?: string } = {}) {
  const { t } = useTranslation("backup");
  const { t: tc } = useTranslation();
  const start = useStartBackup();
  const feedback = useActionFeedback();
  const [open, setOpen] = React.useState(false);
  const [full, setFull] = React.useState(false);

  const confirm = () =>
    start.mutate(
      { full },
      {
        onSuccess: (result) => {
          feedback.queued(result);
          setOpen(false);
        },
        onError: (error) => feedback.failed(error),
      },
    );

  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setFull(false);
          setOpen(true);
        }}
      >
        <DatabaseBackup aria-hidden="true" />
        {label ?? t("actions.backupAll")}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !start.isPending && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("actions.backupAllTitle")}</DialogTitle>
            <DialogDescription>{t("actions.backupAllDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-3 rounded-md border border-border p-3">
            <Checkbox
              id="backup-all-full"
              checked={full}
              onCheckedChange={(value) => setFull(value === true)}
              aria-describedby="backup-all-full-hint"
            />
            <div className="space-y-1">
              <Label htmlFor="backup-all-full">{t("actions.backupNowFull")}</Label>
              <p id="backup-all-full-hint" className="text-xs text-muted-foreground">
                {t("actions.backupNowFullHint")}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={start.isPending}>
              {tc("actions.cancel")}
            </Button>
            <Button onClick={confirm} loading={start.isPending}>
              {t("actions.backupAllConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Cancel (with confirmation) and retry for one job. */
export function JobActions({
  job,
  onRetried,
  size = "sm",
}: {
  job: Job;
  /** Called with the new job after a successful retry. */
  onRetried?: (job: Job) => void;
  size?: "sm" | "default";
}) {
  const { t } = useTranslation("backup");
  const cancel = useCancelJob();
  const retry = useRetryJob();
  const feedback = useActionFeedback();
  const [confirming, setConfirming] = React.useState(false);

  if (!job.cancellable && !job.retryable) {
    return null;
  }
  return (
    <div className="flex items-center justify-end gap-2">
      {job.retryable ? (
        <Button
          size={size}
          variant="outline"
          loading={retry.isPending}
          onClick={() =>
            retry.mutate(job.id, {
              onSuccess: (next) => {
                toast.success(t("toast.retried"));
                onRetried?.(next);
              },
              onError: (error) => feedback.failed(error),
            })
          }
        >
          {retry.isPending ? null : <RotateCcw aria-hidden="true" />}
          {t("actions.retry")}
        </Button>
      ) : null}
      {job.cancellable ? (
        <>
          <Button size={size} variant="outline" onClick={() => setConfirming(true)}>
            <Ban aria-hidden="true" />
            {t("actions.cancel")}
          </Button>
          <Dialog
            open={confirming}
            onOpenChange={(next) => !cancel.isPending && setConfirming(next)}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("actions.cancelTitle")}</DialogTitle>
                <DialogDescription>{t("actions.cancelDescription")}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setConfirming(false)}
                  disabled={cancel.isPending}
                >
                  {t("actions.keepRunning")}
                </Button>
                <Button
                  variant="destructive"
                  loading={cancel.isPending}
                  onClick={() =>
                    cancel.mutate(job.id, {
                      onSuccess: () => {
                        toast.success(t("toast.cancelled"));
                        setConfirming(false);
                      },
                      onError: (error) => feedback.failed(error),
                    })
                  }
                >
                  {t("actions.cancelConfirm")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      ) : null}
    </div>
  );
}
