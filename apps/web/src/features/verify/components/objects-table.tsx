import { Link } from "@tanstack/react-router";
import { FileSearch, ShieldCheck } from "lucide-react";
import * as React from "react";

import { RelativeTime, StatusBadge } from "@/components/kit";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EndpointReadinessRowView } from "@/features/endpoints/components/readiness-row";
import type { EndpointReadinessRow, ObjectReadiness, VerifyObject } from "@/features/verify/api";
import { ObjectKindIcon, StateBadge } from "@/features/verify/components/status";
import { verifyReportTo } from "@/features/verify/paths";
import {
  isWaitingForFirstBackup,
  needsAttention,
  objectAddress,
  objectName,
  readinessRows,
  reasonMessage,
  rowRating,
  sortRowsByUrgency,
} from "@/features/verify/presenters";
import type { VerifyFormat } from "@/features/verify/use-verify";

/*
 * This table stays on the plain kit `Table` primitive rather than the kit
 * `DataTable`: the "worst first" order is fixed (never user-sortable), rows
 * are filtered by three fixed tabs rather than a search/facet toolbar, and
 * the row keeps a wired-up "check now" action with its own loading state.
 * None of that benefits from DataTable's sorting/pagination/column-menu
 * machinery, so a hand-written table stays simpler (the sibling directory
 * feature's near-identical object list makes the same call).
 *
 * Column widths: the object column is the only flexible one (it truncates
 * long names instead of pushing the row wider); every other column carries
 * `whitespace-nowrap` so a badge or a time never wraps onto a second line,
 * which keeps its own natural (content-fit) width. The result column caps
 * its width and truncates with a tooltip instead of wrapping or stretching
 * the row.
 */

type Filter = "all" | "attention" | "waiting";

/** The object's primary label: its name, or a translated kind when even that is unknown. */
function objectLabel(object: VerifyObject, t: VerifyFormat["t"]): string {
  const name = objectName(object);
  // The only way `objectName` still returns the raw external id is a
  // mailbox/OneDrive without a linked address: never show that GUID-like
  // value as the label, name it by its kind instead.
  return name === object.externalId && object.kind !== "imap" ? t(`kind.${object.kind}`) : name;
}

function ObjectCell({ object, format }: { object: VerifyObject; format: VerifyFormat }) {
  const { t } = format;
  const label = objectLabel(object, t);
  const address = objectAddress(object);
  return (
    <div className="flex min-w-0 items-start gap-2">
      <ObjectKindIcon kind={object.kind} className="mt-0.5" />
      <div className="min-w-0" title={t("table.technicalId", { id: object.externalId })}>
        <p className="truncate font-medium">{label}</p>
        {address ? <p className="truncate text-xs text-muted-foreground">{address}</p> : null}
        {object.status === "orphaned" ? (
          <StatusBadge tone="muted" className="mt-1 whitespace-nowrap">
            {t("table.orphaned")}
          </StatusBadge>
        ) : null}
      </div>
    </div>
  );
}

function ResultCell({
  item,
  format,
  nextBackupAt,
}: {
  item: ObjectReadiness;
  format: VerifyFormat;
  nextBackupAt: string | null;
}) {
  const { t } = format;
  const report = item.report;
  if (item.state === "unverified" && item.previousCheck) {
    // A newer backup than the last check: say so, and what the check proved before.
    const headline = t("table.result.latestUnverified");
    return (
      <div className="min-w-0 space-y-0.5">
        <p className="truncate" title={headline}>
          {headline}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {t("table.result.previousCheck", {
            state: t(`state.${item.previousCheck.readiness}`),
          })}{" "}
          <RelativeTime value={item.previousCheck.checkedAt} focusable={false} />
        </p>
      </div>
    );
  }
  if (!report) {
    const text =
      item.state !== "no_backup"
        ? t("table.result.unverified")
        : item.overdue
          ? t("table.result.noBackupOverdue")
          : nextBackupAt
            ? t("table.result.noBackupNextRun", { time: format.relative(nextBackupAt) ?? "" })
            : t("table.result.noBackup");
    return (
      <span className="block truncate text-muted-foreground" title={text}>
        {text}
      </span>
    );
  }
  const primary =
    report.origin === "scrub"
      ? t("table.result.storage")
      : report.counts
        ? t("table.result.verified", {
            verified: format.integer(report.counts.verified),
            checked: format.integer(report.counts.checked),
          })
        : null;
  const firstReason = report.reasons[0];
  const reason = firstReason ? reasonMessage(firstReason) : null;
  const reasonText = reason ? t(reason.key, reason.values) : null;
  return (
    <div className="min-w-0 space-y-0.5">
      {primary ? (
        <p className="truncate tabular-nums" title={primary}>
          {primary}
        </p>
      ) : null}
      {reasonText ? (
        <p className="line-clamp-2 text-xs text-muted-foreground" title={reasonText}>
          {reasonText}
        </p>
      ) : null}
    </div>
  );
}

function ActionsCell({
  item,
  format,
  starting,
  onCheck,
}: {
  item: ObjectReadiness;
  format: VerifyFormat;
  starting: boolean;
  onCheck: (item: ObjectReadiness) => void;
}) {
  const { t } = format;
  const name = objectName(item.object);
  const unverified = item.state === "unverified";
  return (
    <div className="flex items-center justify-end gap-2 whitespace-nowrap">
      {item.running ? (
        // The wrapping div already says whitespace-nowrap; the tone/label are the point here.
        <StatusBadge tone="info" live aria-live="polite">
          {t(`table.running.${item.running.status}`)}
        </StatusBadge>
      ) : item.state !== "no_backup" ? (
        <Button
          // The newest backup is not proven: verifying it is the next step, so it leads.
          variant={unverified ? "default" : "outline"}
          size="sm"
          loading={starting}
          onClick={() => onCheck(item)}
          aria-label={unverified ? t("actions.verifyNowFor", { name }) : undefined}
        >
          {starting ? null : <ShieldCheck aria-hidden="true" />}
          {t(unverified ? "actions.verifyNow" : "actions.checkNow")}
        </Button>
      ) : null}
      {item.report ? (
        <Link
          to={verifyReportTo(item.report.id)}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          aria-label={t("actions.viewReportFor", { name })}
        >
          <FileSearch aria-hidden="true" />
          {t("actions.viewReport")}
        </Link>
      ) : item.previousCheck ? (
        <Link
          to={verifyReportTo(item.previousCheck.reportId)}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          aria-label={t("actions.viewPreviousReportFor", { name })}
        >
          <FileSearch aria-hidden="true" />
          {t("actions.viewReport")}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Every protected object with its rating, worst first: mailboxes, OneDrives
 * and IMAP accounts, and the servers and clients backed up by the agent. The
 * tenant summary above counts both, and so do the filter tabs.
 */
export function ObjectsTable({
  items,
  endpoints = [],
  format,
  startingObjectId,
  nextBackupAt,
  onCheck,
}: {
  items: readonly ObjectReadiness[];
  /** Servers and clients; they are rated like the objects and listed with them. */
  endpoints?: readonly EndpointReadinessRow[];
  format: VerifyFormat;
  startingObjectId: string | null;
  /** The tenant's next scheduled backup run, shown while an object waits for its first one. */
  nextBackupAt: string | null;
  onCheck: (item: ObjectReadiness) => void;
}) {
  const { t } = format;
  const rows = React.useMemo(() => readinessRows(items, endpoints), [items, endpoints]);
  const attentionCount = rows.filter((row) => needsAttention(rowRating(row))).length;
  const waitingCount = rows.filter((row) => isWaitingForFirstBackup(rowRating(row))).length;
  const [filter, setFilter] = React.useState<Filter>("all");
  const visible = React.useMemo(() => {
    const sorted = sortRowsByUrgency(rows);
    if (filter === "attention") {
      return sorted.filter((row) => needsAttention(rowRating(row)));
    }
    if (filter === "waiting") {
      return sorted.filter((row) => isWaitingForFirstBackup(rowRating(row)));
    }
    return sorted;
  }, [rows, filter]);

  return (
    <Card className="pb-0">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{t("table.title")}</CardTitle>
          <CardDescription>{t("table.description")}</CardDescription>
        </div>
        <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
          <TabsList>
            <TabsTrigger value="all">{t("table.filter.all", { count: rows.length })}</TabsTrigger>
            <TabsTrigger value="attention">
              {t("table.filter.attention", { count: attentionCount })}
            </TabsTrigger>
            <TabsTrigger value="waiting">
              {t("table.filter.waiting", { count: waitingCount })}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent className="p-0">
        {visible.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">
            {t(
              filter === "attention"
                ? "table.emptyAttention"
                : filter === "waiting"
                  ? "table.emptyWaiting"
                  : "table.empty",
            )}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">{t("table.columns.object")}</TableHead>
                <TableHead className="whitespace-nowrap">{t("table.columns.readiness")}</TableHead>
                <TableHead className="whitespace-nowrap">{t("table.columns.lastCheck")}</TableHead>
                <TableHead>{t("table.columns.result")}</TableHead>
                <TableHead className="whitespace-nowrap">{t("table.columns.backup")}</TableHead>
                <TableHead className="pr-6 text-right">
                  <span className="sr-only">{t("table.columns.actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) =>
                row.type === "endpoint" ? (
                  <EndpointReadinessRowView key={`endpoint-${row.id}`} row={row.endpoint} />
                ) : (
                  <ObjectRow
                    key={`object-${row.id}`}
                    item={row.item}
                    format={format}
                    nextBackupAt={nextBackupAt}
                    starting={startingObjectId === row.item.object.id}
                    onCheck={onCheck}
                  />
                ),
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ObjectRow({
  item,
  format,
  nextBackupAt,
  starting,
  onCheck,
}: {
  item: ObjectReadiness;
  format: VerifyFormat;
  nextBackupAt: string | null;
  starting: boolean;
  onCheck: (item: ObjectReadiness) => void;
}) {
  const { t } = format;
  return (
    <TableRow>
      <TableCell className="max-w-md pl-6">
        <ObjectCell object={item.object} format={format} />
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <div className="flex flex-wrap items-center gap-1.5">
          <StateBadge state={item.state} overdue={item.overdue} />
          {/* A "no_backup" object's own tone already says whether it is overdue;
              a second badge would only repeat that for it. The cell
              itself is whitespace-nowrap, so this one needs no class. */}
          {item.overdue && item.state !== "no_backup" ? (
            <StatusBadge tone="warning">{t("table.overdue")}</StatusBadge>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <RelativeTime value={item.checkedAt} fallback={t("table.never")} focusable={false} />
      </TableCell>
      <TableCell className="max-w-64">
        <ResultCell item={item} format={format} nextBackupAt={nextBackupAt} />
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <RelativeTime
          value={item.latestSnapshotAt}
          fallback={t("table.noBackup")}
          focusable={false}
        />
      </TableCell>
      <TableCell className="pr-6">
        <ActionsCell item={item} format={format} starting={starting} onCheck={onCheck} />
      </TableCell>
    </TableRow>
  );
}
