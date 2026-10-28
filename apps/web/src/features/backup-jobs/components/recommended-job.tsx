import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldPlus } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DisabledReason } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { canAccess, useSession } from "@/lib/session";

import { JOB_ROLES } from "../access.js";
import {
  applyRecommendedJobs,
  backupJobKeys,
  fetchRecommendedPlan,
  type RecommendedJobPlan,
  type RecommendedScope,
} from "../api.js";
import { useJobsScope } from "../hooks.js";
import { describeJobSchedule, repositoryLabel } from "../presenters.js";
import { closedProps, useJobsAccess } from "./access-note.js";

/** How many names of machines or guests the preview lists before "+3 more". */
const NAMES_SHOWN = 5;

function scopeKey(scope: RecommendedScope): string {
  return JSON.stringify([
    scope.mail === true,
    [...(scope.endpointIds ?? [])].sort(),
    [...(scope.guestIds ?? [])].sort(),
    scope.everything === true,
    [...(scope.kinds ?? [])].sort(),
  ]);
}

/** What one recommended job does, in short lines: what it covers, when, how long, where. */
function PlanItem({ item }: { item: RecommendedJobPlan }) {
  const { t, i18n } = useTranslation("backupjobs");
  const { t: tSchedules } = useTranslation("schedules");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const ctx = { t, tSchedules, language };
  const names = item.members.slice(0, NAMES_SHOWN).map((member) => member.name);
  const more = item.memberCount - names.length;
  const nameList =
    more > 0 ? `${names.join(", ")} ${t("recommended.more", { count: more })}` : names.join(", ");
  const archiving = item.archive === true;
  const lines: string[] = [];
  if (item.action === "enable") {
    // Archiving switched on in a job that exists: it keeps what it covers and when it runs.
    lines.push(t("recommended.scope.archive"));
    lines.push(
      item.schedule
        ? t("recommended.archiveSchedule", { schedule: describeJobSchedule(item.schedule, ctx) })
        : t("recommended.archiveManual"),
    );
  } else {
    lines.push(
      item.kind === "mail" || item.kind === "archive"
        ? t("recommended.scope.mail", { count: item.memberCount })
        : t(`recommended.scope.${item.kind}`, { count: item.memberCount, names: nameList }),
    );
    if (item.schedule) {
      lines.push(t("recommended.schedule", { schedule: describeJobSchedule(item.schedule, ctx) }));
    }
  }
  if ((item.kind === "mail" || item.kind === "archive") && item.action === "create") {
    lines.push(
      item.verifySchedule
        ? t("recommended.verify", { schedule: describeJobSchedule(item.verifySchedule, ctx) })
        : t("schedule.noVerify"),
    );
    lines.push(
      item.retentionPolicy
        ? t("recommended.retentionPolicy", { policy: item.retentionPolicy })
        : t("recommended.retentionDefault"),
    );
  }
  if (archiving) {
    lines.push(
      t("recommended.capture", {
        ways: (item.captureKinds ?? [])
          .map((kind) => t(`recommended.captureKind.${kind}`))
          .join(", "),
      }),
    );
    lines.push(t("recommended.archiveRetention"));
  }
  if (item.kind === "pve") {
    lines.push(t("recommended.mode"));
    lines.push(t("recommended.verifyPve"));
  }
  if (item.retention) {
    lines.push(
      t("recommended.retention", {
        daily: item.retention.keepDaily,
        weekly: item.retention.keepWeekly,
        monthly: item.retention.keepMonthly,
      }),
    );
  }
  if (item.kind === "endpoint" && item.paths.length > 0) {
    lines.push(t("recommended.paths", { paths: item.paths.join(", ") }));
  }
  if (item.repository) {
    lines.push(t("recommended.repository", { repository: repositoryLabel(item.repository, t) }));
  }
  return (
    <li
      className="space-y-1.5 rounded-md border p-3"
      data-slot="recommended-item"
      data-key={item.key}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {item.action === "create"
            ? t("recommended.create", { name: item.name })
            : item.action === "enable"
              ? t("recommended.enable", { name: item.name })
              : t("recommended.add", { name: item.name })}
        </span>
        <Badge variant="muted">{t(`recommended.kind.${item.kind}`)}</Badge>
        {archiving && item.kind === "mail" ? (
          <Badge variant="muted">{t("recommended.kind.archive")}</Badge>
        ) : null}
      </div>
      <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
        {lines.map((line) => (
          <li key={line} className="break-words">
            {line}
          </li>
        ))}
      </ul>
    </li>
  );
}

export interface RecommendedJobButtonProps {
  scope: RecommendedScope;
  /** The button's words; "Create recommended job" by default. */
  label?: string;
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "sm" | "xs";
  className?: string;
}

/**
 * "Create recommended job" next to a "no job" notice (#52): opens a short preview of what the
 * click does (the job it makes or adds to, when it runs, how long it keeps, where it writes) and
 * does it on confirmation. The server makes nothing twice: a second click adds to the same job.
 * Only for the roles that may open jobs; closed (with the reason) for those that may only look.
 */
export function RecommendedJobButton({
  scope,
  label,
  variant = "outline",
  size = "sm",
  className,
}: RecommendedJobButtonProps) {
  const { t } = useTranslation("backupjobs");
  const { role } = useSession();
  const access = useJobsAccess();
  const [open, setOpen] = React.useState(false);
  if (!canAccess(role, JOB_ROLES)) {
    return null;
  }
  const everything = scope.everything === true && (scope.kinds ?? []).length === 0;
  const text = label ?? (everything ? t("recommended.everything") : t("recommended.button"));
  return (
    <>
      <DisabledReason reason={access.closed ? access.reason : null}>
        <Button
          type="button"
          variant={variant}
          size={size}
          className={className}
          disabled={access.closed}
          onClick={() => setOpen(true)}
          data-action="create-recommended"
          {...closedProps(access)}
        >
          <ShieldPlus aria-hidden="true" />
          {text}
        </Button>
      </DisabledReason>
      {open ? (
        <RecommendedDialog scope={scope} title={text} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function RecommendedDialog({
  scope,
  title,
  onClose,
}: {
  scope: RecommendedScope;
  title: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("backupjobs");
  const { tenantId, enabled } = useJobsScope();
  const queryClient = useQueryClient();
  const plan = useQuery({
    queryKey: backupJobKeys.recommended(tenantId, scopeKey(scope)),
    queryFn: () => fetchRecommendedPlan(scope),
    enabled,
    staleTime: 0,
  });
  const apply = useMutation({
    mutationFn: () => applyRecommendedJobs(scope),
    onSuccess: (result) => {
      if (result.items.length === 0) {
        toast.info(t("recommended.doneNothing"));
      } else {
        toast.success(
          t("recommended.done", {
            count: result.items.length,
            names: result.items.map((item) => item.name).join(", "),
          }),
        );
      }
      // Jobs, machines, mail objects, guests and the dashboard all say what is protected now.
      void queryClient.invalidateQueries();
      onClose();
    },
  });
  const items = plan.data?.items ?? [];
  const skipped = plan.data?.skipped ?? [];
  // A job whose capture way was switched off by hand: archiving needs a choice in the job.
  const noWay = skipped.filter((skip) => skip.reason === "no_capture_way");
  // Mail jobs over selected objects keep their archive setting: named, not counted as objects.
  const handPicked = skipped.filter((skip) => skip.kind === "archive" && skip.reason === "in_job");
  const counted = skipped.filter((skip) => skip.kind !== "archive");
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto" data-slot="recommended-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("recommended.description")}</DialogDescription>
        </DialogHeader>
        {plan.isPending ? (
          <p className="text-sm text-muted-foreground">{t("recommended.loading")}</p>
        ) : plan.isError ? (
          <p className="text-sm text-destructive-text" role="alert">
            {t("recommended.loadError")}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-slot="recommended-nothing">
            {t("recommended.nothing")}
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <PlanItem key={item.key} item={item} />
            ))}
          </ul>
        )}
        {noWay.map((skip) => (
          <p
            key={skip.id}
            className="text-xs text-muted-foreground"
            data-slot="recommended-no-capture-way"
          >
            {t("recommended.noCaptureWay", { name: skip.name ?? "" })}
          </p>
        ))}
        {handPicked.length > 0 ? (
          <p className="text-xs text-muted-foreground" data-slot="recommended-hand-picked">
            {t("recommended.handPicked", {
              count: handPicked.length,
              names: handPicked.map((skip) => skip.name ?? "").join(", "),
            })}
          </p>
        ) : null}
        {counted.length > 0 ? (
          <p className="text-xs text-muted-foreground" data-slot="recommended-skipped">
            {t("recommended.skipped", { count: counted.length })}
          </p>
        ) : null}
        {apply.isError ? (
          <p className="text-sm text-destructive-text" role="alert">
            {t("recommended.applyError")}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("recommended.cancel")}
          </Button>
          <Button
            type="button"
            disabled={items.length === 0 || apply.isPending}
            onClick={() => apply.mutate()}
            data-action="confirm-recommended"
          >
            {title}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
