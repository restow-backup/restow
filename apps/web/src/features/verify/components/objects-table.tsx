import { Link } from "@tanstack/react-router";
import { FileSearch, ShieldCheck } from "lucide-react";
import * as React from "react";

import { RelativeTime, StatusBadge } from "@/components/kit";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  PIN_FIRST,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EndpointReadinessRowView } from "@/features/endpoints/components/readiness-row";
import { ShareReadinessRowView } from "@/features/file-shares/components/readiness-row";
import { GuestReadinessRowView } from "@/features/pve/readiness-row";
import type {
  EndpointReadinessRow,
  GuestReadinessRow,
  ObjectReadiness,
  ShareReadinessRow,
  VerifyObject,
} from "@/features/verify/api";
import { StateChips, countsOfSummary } from "@/features/verify/components/state-chips";
import { ObjectKindIcon, StateBadge } from "@/features/verify/components/status";
import { verifyReportTo } from "@/features/verify/paths";
import {
  type ReadinessRow,
  objectAddress,
  objectName,
  readinessRows,
  reasonMessage,
  rowRating,
  sortRowsByUrgency,
} from "@/features/verify/presenters";
import type { ReadinessState } from "@/features/verify/search";
import type { VerifyFormat } from "@/features/verify/use-verify";

/*
 * This table stays on the plain kit `Table` primitive rather than the kit
 * `DataTable`: the "worst first" order is fixed (never user-sortable), rows
 * are filtered by the state chips (which set the address) rather than a
 * search/facet toolbar, and
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

/** How many rows are in each state, for the chips. */
export function stateCounts(rows: readonly ReadinessRow[]) {
  const counts = { green: 0, yellow: 0, red: 0, unverified: 0, noBackup: 0 };
  for (const row of rows) {
    const { state } = rowRating(row);
    if (state === "no_backup") {
      counts.noBackup += 1;
    } else {
      counts[state] += 1;
    }
  }
  return countsOfSummary(counts);
}

/**
 * Every protected object with its rating, worst first: mailboxes, OneDrives
 * and IMAP accounts, and the servers and clients backed up by the agent. The
 * tenant summary above counts both, and so do the state chips, which filter the
 * table through the address (`?state=`).
 */
export function ObjectsTable({
  items,
  endpoints = [],
  guests = [],
  shares = [],
  format,
  startingObjectId,
  nextBackupAt,
  onCheck,
  state,
  onStateChange,
}: {
  items: readonly ObjectReadiness[];
  /** Servers and clients; they are rated like the objects and listed with them. */
  endpoints?: readonly EndpointReadinessRow[];
  /** VMs and containers of Proxmox VE; rated and listed like the machines. */
  guests?: readonly GuestReadinessRow[];
  /** File shares; rated and listed like the guests. */
  shares?: readonly ShareReadinessRow[];
  format: VerifyFormat;
  startingObjectId: string | null;
  /** The tenant's next scheduled backup run, shown while an object waits for its first one. */
  nextBackupAt: string | null;
  onCheck: (item: ObjectReadiness) => void;
  /** The state the table is filtered to (the address's `state`); undefined shows every object. */
  state?: ReadinessState;
  onStateChange: (state: ReadinessState | undefined) => void;
}) {
  const { t } = format;
  const rows = React.useMemo(
    () => readinessRows(items, endpoints, guests, shares),
    [items, endpoints, guests, shares],
  );
  const counts = React.useMemo(() => stateCounts(rows), [rows]);
  const visible = React.useMemo(() => {
    const sorted = sortRowsByUrgency(rows);
    return state ? sorted.filter((row) => rowRating(row).state === state) : sorted;
  }, [rows, state]);

  return (
    <Card className="pb-0">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{t("table.title")}</CardTitle>
          <CardDescription>{t("table.description")}</CardDescription>
        </div>
      </CardHeader>
      <div className="px-6 pb-4">
        <StateChips counts={counts} total={rows.length} value={state} onChange={onStateChange} />
      </div>
      <CardContent className="p-0">
        {visible.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">
            {state ? t("table.emptyState", { state: t(`state.${state}`) }) : t("table.empty")}
          </p>
        ) : (
          <Table className="min-w-[52rem]" scrollLabel={t("table.title")}>
            <TableHeader>
              <TableRow>
                <TableHead pin={PIN_FIRST} className="pl-6">
                  {t("table.columns.object")}
                </TableHead>
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
                ) : row.type === "guest" ? (
                  <GuestReadinessRowView key={`guest-${row.id}`} row={row.guest} />
                ) : row.type === "share" ? (
                  <ShareReadinessRowView key={`share-${row.id}`} row={row.share} />
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
      <TableCell pin={PIN_FIRST} className="max-w-md pl-6">
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
