import { History } from "lucide-react";
import * as React from "react";

import { EmptyState, ErrorState, StatusBadge } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FailureExplanation } from "@/features/failures";

import type { FileShareDetail, ShareRun } from "../api.js";
import {
  type ShareFormat,
  useCancelRun,
  useShareFormat,
  useShareRun,
  useShareRuns,
} from "../hooks.js";
import {
  isActiveRun,
  itemCodeKey,
  progressRatio,
  runKindKey,
  runStatusView,
} from "../presenters.js";

export interface RunsTabProps {
  share: FileShareDetail;
  onBackupEmptyOnce: () => void;
}

function durationOf(run: Pick<ShareRun, "startedAt" | "finishedAt">): number | null {
  if (!run.startedAt) return null;
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  return Math.max(0, end - Date.parse(run.startedAt));
}

function formatDuration(ms: number | null, language: string): string {
  if (ms === null) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1)
    return new Intl.NumberFormat(language, { style: "unit", unit: "second" }).format(
      Math.round(ms / 1000),
    );
  if (minutes < 120)
    return new Intl.NumberFormat(language, { style: "unit", unit: "minute" }).format(minutes);
  return new Intl.NumberFormat(language, {
    style: "unit",
    unit: "hour",
    maximumFractionDigits: 1,
  }).format(minutes / 60);
}

/**
 * The runs of the share (docs/FILESHARES.md 12.3): backups of it and restores from or into it,
 * with status, duration, files, data added and warnings; a run opens in a sheet with the cause
 * and what to do, the per-file items grouped by cause, and the log tail.
 */
export function RunsTab({ share, onBackupEmptyOnce }: RunsTabProps) {
  const format = useShareFormat();
  const { t } = format;
  const runs = useShareRuns(share.id);
  const [open, setOpen] = React.useState<string | null>(null);

  if (runs.isError) {
    return (
      <ErrorState
        title={t("runs.loadError")}
        error={runs.error}
        onRetry={() => void runs.refetch()}
        retrying={runs.isFetching}
      />
    );
  }
  if (runs.isPending) {
    return <Skeleton className="h-48 w-full" aria-busy="true" />;
  }
  const items = runs.data.items;
  if (items.length === 0) {
    return (
      <EmptyState
        icon={History}
        title={t("runs.empty.title")}
        description={t("runs.empty.description")}
      />
    );
  }
  return (
    <>
      <Card className="py-0">
        <CardContent className="p-0">
          <Table scrollLabel={t("detail.tabs.runs")}>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">{t("runs.columns.kind")}</TableHead>
                <TableHead>{t("runs.columns.status")}</TableHead>
                <TableHead>{t("runs.columns.started")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("runs.columns.duration")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("runs.columns.files")}</TableHead>
                <TableHead className="hidden lg:table-cell">{t("runs.columns.added")}</TableHead>
                <TableHead className="pr-4">{t("runs.columns.warnings")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((run) => {
                const view = runStatusView(run);
                const ratio = isActiveRun(run.status) ? progressRatio(run.progress) : null;
                return (
                  <TableRow key={run.id} data-run={run.id}>
                    <TableCell className="pl-4">
                      <button
                        type="button"
                        className="font-medium hover:underline"
                        onClick={() => setOpen(run.id)}
                      >
                        {t(runKindKey(run))}
                      </button>
                      {run.trigger === "copy" ? (
                        <Badge variant="outline" className="ml-2">
                          {t("copy.notBackup")}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={view.tone} icon>
                        {t(view.key)}
                      </StatusBadge>
                      {ratio !== null ? (
                        <Progress
                          value={Math.round(ratio * 100)}
                          className="mt-1 h-1.5 w-24"
                          aria-label={t("overview.progress")}
                        />
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {format.dateTime(run.startedAt ?? run.queuedAt)}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {formatDuration(durationOf(run), format.language)}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {typeof run.stats.files === "number" ? format.integer(run.stats.files) : ""}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {typeof run.stats.dataAdded === "number"
                        ? format.bytes(run.stats.dataAdded)
                        : ""}
                    </TableCell>
                    <TableCell className="pr-4">
                      {run.itemCount > 0 ? format.integer(run.itemCount) : ""}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <RunSheet
        share={share}
        runId={open}
        onOpenChange={(value) => !value && setOpen(null)}
        onBackupEmptyOnce={onBackupEmptyOnce}
        format={format}
      />
    </>
  );
}

function RunSheet({
  share,
  runId,
  onOpenChange,
  onBackupEmptyOnce,
  format,
}: {
  share: FileShareDetail;
  runId: string | null;
  onOpenChange: (open: boolean) => void;
  onBackupEmptyOnce: () => void;
  format: ShareFormat;
}) {
  const { t } = format;
  const [code, setCode] = React.useState<string | null>(null);
  const query = useShareRun(share.id, runId, code);
  const cancel = useCancelRun(share.id);
  const run = query.data;
  const view = run ? runStatusView(run) : null;
  const codes = run ? Object.entries(run.itemCounts).sort((a, b) => b[1] - a[1]) : [];

  return (
    <Sheet open={runId !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto sm:max-w-2xl"
        data-slot="share-run-sheet"
      >
        <SheetHeader>
          <SheetTitle>{run ? t(runKindKey(run)) : t("runs.title")}</SheetTitle>
          <SheetDescription>{share.name}</SheetDescription>
        </SheetHeader>
        {!run ? (
          query.isError ? (
            <ErrorState
              title={t("runs.loadError")}
              error={query.error}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          ) : (
            <Skeleton className="m-4 h-40" />
          )
        ) : (
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center gap-2">
              {view ? (
                <StatusBadge tone={view.tone} icon>
                  {t(view.key)}
                </StatusBadge>
              ) : null}
              {run.trigger === "copy" ? (
                <Badge variant="outline">{t("copy.notBackup")}</Badge>
              ) : null}
              {run.stats.upToDate ? <Badge variant="outline">{t("runs.upToDate")}</Badge> : null}
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">{t("runs.columns.started")}</dt>
                <dd>{format.dateTime(run.startedAt ?? run.queuedAt)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("runs.columns.duration")}</dt>
                <dd>{formatDuration(durationOf(run), format.language)}</dd>
              </div>
              {typeof run.stats.files === "number" ? (
                <div>
                  <dt className="text-xs text-muted-foreground">{t("runs.columns.files")}</dt>
                  <dd>{format.integer(run.stats.files)}</dd>
                </div>
              ) : null}
              {typeof run.stats.dataAdded === "number" ? (
                <div>
                  <dt className="text-xs text-muted-foreground">{t("runs.columns.added")}</dt>
                  <dd>{format.bytes(run.stats.dataAdded)}</dd>
                </div>
              ) : null}
              {run.kind === "restore" && run.params.destination ? (
                <div className="col-span-2">
                  <dt className="text-xs text-muted-foreground">{t("runs.destination")}</dt>
                  <dd>
                    {t(`runs.destinations.${run.params.destination}`, {
                      folder: run.params.folder ?? run.params.targetFolder ?? "",
                    })}
                    {run.params.conflict
                      ? ` · ${t(`restore.conflict.${run.params.conflict}`)}`
                      : ""}
                  </dd>
                </div>
              ) : null}
              {run.params.note ? (
                <div className="col-span-2">
                  <dt className="text-xs text-muted-foreground">{t("runs.note")}</dt>
                  <dd>{run.params.note}</dd>
                </div>
              ) : null}
            </dl>
            {run.failure ? (
              <FailureExplanation
                failure={run.failure}
                message={run.errorMessage}
                subject={{ kind: "job", queue: t(runKindKey(run)), object: share.name }}
                fileShareId={share.id}
                tone={run.status === "warning" ? "warning" : undefined}
              />
            ) : null}
            {run.failure?.code === "share.empty_source" ? (
              <Button variant="outline" onClick={onBackupEmptyOnce} data-action="backup-empty-once">
                {t("overview.emptyOnce")}
              </Button>
            ) : null}
            {isActiveRun(run.status) ? (
              <Button
                variant="outline"
                onClick={() => cancel.mutate(run.id)}
                loading={cancel.isPending}
                data-action="cancel-run"
              >
                {t("runs.cancel")}
              </Button>
            ) : null}
            {codes.length > 0 ? (
              <section className="space-y-2" data-slot="run-items">
                <h3 className="text-sm font-medium">
                  {t("items.title", { count: run.itemCount })}
                </h3>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={code === null ? "secondary" : "outline"}
                    onClick={() => setCode(null)}
                  >
                    {t("items.all")}
                  </Button>
                  {codes.map(([item, count]) => (
                    <Button
                      key={item}
                      size="sm"
                      variant={code === item ? "secondary" : "outline"}
                      onClick={() => setCode(item)}
                      data-code={item}
                    >
                      {t(itemCodeKey(item))} ({format.integer(count)})
                    </Button>
                  ))}
                </div>
                <ul className="max-h-80 divide-y overflow-y-auto rounded-md border text-sm">
                  {run.items.map((item) => (
                    <li key={`${item.code}:${item.path}`} className="px-3 py-1.5">
                      <span className="block break-all font-mono text-xs">{item.path}</span>
                      <span className="text-xs text-muted-foreground">
                        {t(itemCodeKey(item.code))}
                        {item.message ? ` · ${item.message}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
                {run.itemCount > run.itemsStored ? (
                  <p className="text-xs text-muted-foreground">
                    {t("items.notStored", { count: run.itemCount - run.itemsStored })}
                  </p>
                ) : null}
              </section>
            ) : null}
            {run.logTail ? (
              <details>
                <summary className="cursor-pointer text-sm">{t("runs.log")}</summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
                  {run.logTail}
                </pre>
              </details>
            ) : null}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
