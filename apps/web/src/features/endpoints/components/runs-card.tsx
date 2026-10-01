import { FileSearch } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState, RelativeTime } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { CauseLine } from "@/features/failures";

import { LIMITS, type RunSummary } from "../api.js";
import { useEndpointFormat, useRuns } from "../hooks.js";
import { formatDuration, runDurationMs, runKindKey } from "../presenters.js";
import { RunProgressView } from "./run-sheet.js";
import { RunStatusBadge } from "./status.js";

/** How many runs the detail carries; asking for more fetches the longer list. */
const DETAIL_RUNS = 20;

/**
 * The newest runs of a machine, each opening a sheet with log and errors.
 * `willRetry` is false on a revoked machine: a restore test that could not
 * complete is not repeated there.
 */
export function RunsCard({
  endpointId,
  runs,
  onOpen,
  willRetry = true,
}: {
  endpointId: string;
  runs: readonly RunSummary[];
  onOpen: (runId: string) => void;
  willRetry?: boolean;
}) {
  const format = useEndpointFormat();
  const { t, language } = format;
  const [older, setOlder] = React.useState(false);
  const more = useRuns(endpointId, LIMITS.runs, older);
  const shown = older && more.data ? more.data : runs;
  const canShowOlder = !older && runs.length >= DETAIL_RUNS;

  return (
    <Card className="pb-0" data-slot="runs-card">
      <CardHeader>
        <CardTitle className="text-base">{t("runs.title")}</CardTitle>
        <CardDescription>{t("runs.description")}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {shown.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">{t("runs.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">{t("runs.columns.kind")}</TableHead>
                <TableHead>{t("runs.columns.status")}</TableHead>
                <TableHead className="hidden whitespace-nowrap sm:table-cell">
                  {t("runs.columns.started")}
                </TableHead>
                <TableHead className="hidden whitespace-nowrap sm:table-cell">
                  {t("runs.columns.duration")}
                </TableHead>
                <TableHead className="hidden pr-6 text-right whitespace-nowrap xl:table-cell">
                  {t("runs.columns.dataAdded")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((run) => {
                const duration = runDurationMs(run);
                return (
                  <TableRow key={run.id} data-run-status={run.status}>
                    <TableCell className="pl-6 whitespace-nowrap">
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0 font-medium"
                        onClick={() => onOpen(run.id)}
                        aria-label={t("runs.openFor", {
                          kind: t(runKindKey(run.kind)),
                          time: format.dateTime(run.startedAt) ?? "",
                        })}
                      >
                        <FileSearch aria-hidden="true" />
                        {t(runKindKey(run.kind))}
                      </Button>
                      {/* The Started column is hidden on a phone: the time sits under the run instead. */}
                      <span className="block pt-0.5 text-xs text-muted-foreground sm:hidden">
                        <RelativeTime value={run.startedAt} focusable={false} />
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <RunStatusBadge
                          status={run.status}
                          kind={run.kind}
                          interrupted={run.interruptedOnly}
                          checkIncomplete={run.checkIncomplete}
                          willRetry={willRetry}
                        />
                        {run.status === "running" ? (
                          <div className="w-40 max-w-full">
                            <RunProgressView progress={run.progress} format={format} compact />
                          </div>
                        ) : null}
                        {run.failure ? (
                          <CauseLine failure={run.failure} className="max-w-56" />
                        ) : null}
                        {run.errorCount > 0 ? (
                          <span className="text-xs text-muted-foreground">
                            {t("runs.errorCount", { count: run.errorCount })}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap sm:table-cell">
                      <RelativeTime value={run.startedAt} focusable={false} />
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap tabular-nums sm:table-cell">
                      {duration === null ? "" : formatDuration(duration, language)}
                    </TableCell>
                    <TableCell className="hidden pr-6 text-right whitespace-nowrap tabular-nums xl:table-cell">
                      {run.dataAdded === null ? "" : format.bytes(run.dataAdded)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {older && more.isError ? (
          <div className="px-6 pb-6">
            <ErrorState
              title={t("runs.olderError")}
              error={more.error}
              onRetry={() => void more.refetch()}
              retrying={more.isFetching}
            />
          </div>
        ) : null}
        {canShowOlder ? (
          <div className="border-t px-6 py-3">
            <Button variant="outline" size="sm" onClick={() => setOlder(true)}>
              {t("runs.showOlder")}
            </Button>
          </div>
        ) : older && more.isFetching && !more.data ? (
          <p className="border-t px-6 py-3 text-sm text-muted-foreground">
            {t("runs.loadingOlder")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
