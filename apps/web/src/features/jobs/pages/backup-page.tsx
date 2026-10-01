import { Link } from "@tanstack/react-router";
import { DatabaseBackup, Layers, Search } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type BackupTarget, OBJECT_KINDS, type ObjectKind } from "@/features/jobs/api";
import { BackupAllButton, BackupNowButton } from "@/features/jobs/components/actions";
import { JobCause } from "@/features/jobs/components/job-cause";
import { ProgressBar, ProgressSummary } from "@/features/jobs/components/job-progress";
import { SnapshotHistoryDialog } from "@/features/jobs/components/snapshot-history-dialog";
import {
  JobStatusBadge,
  LiveIndicator,
  ObjectKindIcon,
  ReadinessBadge,
} from "@/features/jobs/components/status";
import { jobDetailTo } from "@/features/jobs/paths";
import { isLive, matchesTargetSearch, objectLabel } from "@/features/jobs/presenters";
import { type JobFormat, useJobFormat } from "@/features/jobs/use-format";
import { useLiveBackupTargets, useNow } from "@/features/jobs/use-jobs";

const ALL_KINDS = "all";

/** Every protected object with its last backup, live job state and "Back up now". */
export function BackupPage() {
  const { t } = useTranslation("backup");
  const format = useJobFormat();
  const { targets, stream } = useLiveBackupTargets();
  const [search, setSearch] = React.useState("");
  const [kind, setKind] = React.useState<ObjectKind | null>(null);
  const [historyFor, setHistoryFor] = React.useState<BackupTarget | null>(null);

  const all = targets.data ?? [];
  const visible = all.filter(
    (target) => (kind === null || target.kind === kind) && matchesTargetSearch(target, search),
  );
  const now = useNow(
    all.some((target) => target.lastJob !== null && isLive(target.lastJob.status)),
  );

  return (
    <div className="space-y-6">
      <PageHeader title={t("objects.title")} description={t("objects.description")}>
        <LiveIndicator status={stream} />
        {all.length > 0 ? <BackupAllButton /> : null}
      </PageHeader>

      {targets.isPending ? (
        <Card>
          <CardContent className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </CardContent>
        </Card>
      ) : targets.isError ? (
        <ErrorState
          title={t("objects.loadError")}
          error={targets.error}
          onRetry={() => void targets.refetch()}
          retrying={targets.isFetching}
        />
      ) : all.length === 0 ? (
        <Card className="py-0">
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <DatabaseBackup className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="max-w-md text-sm text-muted-foreground">{t("objects.empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="relative w-full max-w-sm">
              <Label htmlFor="backup-search" className="sr-only">
                {t("objects.search")}
              </Label>
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="backup-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("objects.search")}
                className="pl-8"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="backup-kind" className="text-xs text-muted-foreground">
                {t("objects.filterKind")}
              </Label>
              <Select
                value={kind ?? ALL_KINDS}
                onValueChange={(next) => setKind(next === ALL_KINDS ? null : (next as ObjectKind))}
              >
                <SelectTrigger id="backup-kind" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_KINDS}>{t("objects.allKinds")}</SelectItem>
                  {OBJECT_KINDS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {format.kind(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {visible.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("objects.noMatch")}</p>
          ) : (
            <Card className="py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">{t("objects.columns.object")}</TableHead>
                    <TableHead>{t("objects.columns.source")}</TableHead>
                    <TableHead>{t("objects.columns.lastBackup")}</TableHead>
                    <TableHead className="min-w-52">{t("objects.columns.lastJob")}</TableHead>
                    <TableHead>{t("objects.columns.readiness")}</TableHead>
                    <TableHead className="pr-4 text-right">
                      <span className="sr-only">{t("objects.columns.actions")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((target) => (
                    <TargetRow
                      key={target.id}
                      target={target}
                      now={now}
                      format={format}
                      onHistory={() => setHistoryFor(target)}
                    />
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}

      <SnapshotHistoryDialog
        target={historyFor}
        onOpenChange={(open) => {
          if (!open) {
            setHistoryFor(null);
          }
        }}
      />
    </div>
  );
}

function TargetRow({
  target,
  now,
  format,
  onHistory,
}: {
  target: BackupTarget;
  now: number;
  format: JobFormat;
  onHistory: () => void;
}) {
  const { t } = format;
  const job = target.lastJob;
  const snapshot = target.lastSnapshot;
  const excluded = target.blocked === "excluded" || target.blocked === "orphaned";

  return (
    <TableRow className={excluded ? "text-muted-foreground" : undefined}>
      <TableCell className="max-w-72 pl-4 align-top">
        <div className="flex min-w-0 items-start gap-2">
          <ObjectKindIcon kind={target.kind} className="mt-0.5 text-muted-foreground" />
          <div className="min-w-0 space-y-0.5">
            <p className="truncate font-medium">{objectLabel(target)}</p>
            {target.displayName && target.displayName !== target.externalId ? (
              <p className="truncate text-xs text-muted-foreground">{target.externalId}</p>
            ) : null}
            <div className="flex flex-wrap gap-1">
              <Badge variant="outline">{format.kind(target.kind)}</Badge>
              {target.blocked ? (
                <Badge variant={excluded ? "muted" : "warning"}>
                  {t(`blocked.${target.blocked}`)}
                </Badge>
              ) : null}
            </div>
          </div>
        </div>
      </TableCell>
      <TableCell className="align-top text-sm">{target.source.name}</TableCell>
      <TableCell className="align-top text-sm">
        {snapshot?.completedAt ? (
          <div className="space-y-0.5">
            <p title={format.dateTime(snapshot.completedAt) ?? undefined}>
              {format.relative(snapshot.completedAt)}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {t("objects.snapshotSummary", {
                count: snapshot.itemCount,
                size: format.bytes(snapshot.byteSize),
              })}
            </p>
          </div>
        ) : (
          <span className="text-muted-foreground">{t("objects.never")}</span>
        )}
      </TableCell>
      <TableCell className="align-top">
        {job ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <JobStatusBadge
                status={job.status}
                failedItems={job.progress?.failed}
                queue={job.queue}
                checkIncomplete={job.checkIncomplete}
              />
              <Link
                to={jobDetailTo(job.id)}
                className="text-xs text-primary underline-offset-4 hover:underline"
              >
                {t("actions.openJob")}
              </Link>
            </div>
            <JobCause job={job} />
            {isLive(job.status) ? (
              <>
                <ProgressBar job={job} />
                <ProgressSummary job={job} now={now} />
              </>
            ) : (
              <p
                className="text-xs text-muted-foreground"
                title={format.dateTime(job.completedAt) ?? undefined}
              >
                {format.relative(job.completedAt ?? job.createdAt)}
              </p>
            )}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">{t("objects.noJob")}</span>
        )}
      </TableCell>
      <TableCell className="align-top">
        <ReadinessBadge verify={target.latestVerify} />
      </TableCell>
      <TableCell className="pr-4 align-top">
        <div className="flex items-center justify-end gap-2">
          <BackupNowButton target={target} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onHistory}
                aria-label={t("actions.history")}
              >
                <Layers aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("actions.history")}</TooltipContent>
          </Tooltip>
        </div>
      </TableCell>
    </TableRow>
  );
}
