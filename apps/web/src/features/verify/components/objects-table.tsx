import { Link } from "@tanstack/react-router";
import { CircleDashed, FileSearch, ShieldCheck, Undo2 } from "lucide-react";
import * as React from "react";

import { ConfirmDialog, DataTableLoadMore, RelativeTime, StatusBadge } from "@/components/kit";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { countsOfSummary, StateChips } from "@/features/verify/components/state-chips";
import { ObjectKindIcon, StateBadge } from "@/features/verify/components/status";
import { verifyReportTo } from "@/features/verify/paths";
import {
  EMPTY_REASON,
  isEmptyUnconfirmed,
  objectAddress,
  objectLabel,
  objectName,
  type ReadinessRow,
  readinessRows,
  reasonMessage,
  rowRating,
  sortRowsByUrgency,
  storageFindingKey,
} from "@/features/verify/presenters";
import type { EmptyFilter, TableFilter } from "@/features/verify/search";
import type { VerifyFormat } from "@/features/verify/use-verify";

/** The reasons that only say how old the latest backup is (core verify/readiness.ts). */
const FRESHNESS_REASONS: ReadonlySet<string> = new Set(["snapshot_outdated", "snapshot_stale"]);

/** How many rows the table shows before "Load more": a large tenant lists thousands of objects. */
export const OBJECTS_PAGE_SIZE = 50;

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

function ObjectCell({
  object,
  inJob,
  emptyConfirmation,
  format,
}: {
  object: VerifyObject;
  /** False: an active object in no enabled backup job (absent from an older server: in a job). */
  inJob: boolean;
  /** Set while the object counts as confirmed empty. */
  emptyConfirmation?: ObjectReadiness["emptyConfirmation"];
  format: VerifyFormat;
}) {
  const { t } = format;
  const label = objectLabel(object, t);
  const address = objectAddress(object);
  return (
    <div className="flex min-w-0 items-start gap-2">
      <ObjectKindIcon kind={object.kind} className="mt-0.5" />
      <div className="min-w-0" title={t("table.technicalId", { id: object.externalId })}>
        <p className="truncate font-medium">{label}</p>
        {address ? <p className="truncate text-xs text-muted-foreground">{address}</p> : null}
        {inJob ? null : (
          // Nothing backs it up (no enabled backup job covers it): rated by whether its newest
          // backup restores, not by its age, like a guest or share in no job.
          <StatusBadge
            tone="warning"
            className="mt-1 whitespace-nowrap"
            title={t("table.noJobHint")}
          >
            {t("table.noJob")}
          </StatusBadge>
        )}
        {object.status === "orphaned" ? (
          // Amber until someone confirms it is intended, grey after (an older server: grey).
          <StatusBadge
            tone={object.statusConfirmedAt === null ? "warning" : "muted"}
            className="mt-1 whitespace-nowrap"
          >
            {object.statusConfirmedAt === null ? `${t("table.toConfirm")}: ` : null}
            {object.statusReason ? t(`table.inactive.${object.statusReason}`) : t("table.orphaned")}
          </StatusBadge>
        ) : null}
        {emptyConfirmation ? (
          // Grey like an intentionally inactive object: seen, decided, nothing to do.
          <StatusBadge
            tone="muted"
            className="mt-1"
            title={emptyConfirmation.note ?? undefined}
            data-slot="empty-confirmed"
          >
            {t("table.emptyConfirmed", {
              who: emptyConfirmation.confirmedBy,
              date: format.dateTime(emptyConfirmation.confirmedAt) ?? "",
            })}
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
      ? t(storageFindingKey(report.reasons))
      : report.counts
        ? t("table.result.verified", {
            verified: format.integer(report.counts.verified),
            checked: format.integer(report.counts.checked),
          })
        : null;
  // An orphaned object (removed from its source, backups kept) and an active one in no backup
  // job are rated without the age of their last backup (the server's readinessWithoutFreshness):
  // the age is no reason to show under the badge, which would otherwise put "backup too old"
  // next to a green rating.
  const shownReasons =
    item.object.status === "orphaned" || item.inJob === false
      ? report.reasons.filter((entry) => !FRESHNESS_REASONS.has(entry.code))
      : report.reasons;
  const firstReason = shownReasons[0];
  if (firstReason?.code === EMPTY_REASON) {
    // Nothing to restore: no "0 of 0 verified", one quiet line with what the backup holds.
    const stats = item.contentStats;
    const text = t("reason.snapshot_empty", {
      count: stats?.items ?? firstReason.count ?? 0,
    });
    return (
      <p
        className="line-clamp-2 text-xs text-muted-foreground"
        title={text}
        data-slot="empty-result"
      >
        <CircleDashed aria-hidden="true" className="mr-1 inline size-3 align-[-2px]" />
        {text}
      </p>
    );
  }
  const reason = firstReason ? reasonMessage(firstReason, format.bytes) : null;
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
  empty,
}: {
  item: ObjectReadiness;
  format: VerifyFormat;
  starting: boolean;
  onCheck: (item: ObjectReadiness) => void;
  empty?: EmptyActions;
}) {
  const { t } = format;
  const name = objectName(item.object);
  const unverified = item.state === "unverified";
  return (
    <div className="flex items-center justify-end gap-2 whitespace-nowrap">
      {empty && isEmptyUnconfirmed(item) ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => empty.ask([item.object.id])}
          aria-label={t("actions.confirmEmptyFor", { name })}
        >
          <CircleDashed aria-hidden="true" />
          {t("actions.confirmEmpty")}
        </Button>
      ) : null}
      {empty && item.state === "empty" ? (
        <Button
          variant="ghost"
          size="sm"
          loading={empty.revoking === item.object.id}
          onClick={() => empty.revoke(item)}
          aria-label={t("actions.revokeEmptyFor", { name })}
        >
          {empty.revoking === item.object.id ? null : <Undo2 aria-hidden="true" />}
          {t("actions.revokeEmpty")}
        </Button>
      ) : null}
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

/** How many rows are in each state, for the chips (confirmed empty ones count in `emptyCounts`). */
export function stateCounts(rows: readonly ReadinessRow[]) {
  const counts = { green: 0, yellow: 0, red: 0, unverified: 0, noBackup: 0 };
  for (const row of rows) {
    const { state } = rowRating(row);
    if (state === "no_backup") {
      counts.noBackup += 1;
    } else if (state !== "empty") {
      counts[state] += 1;
    }
  }
  return countsOfSummary(counts);
}

/** The objects found empty and not confirmed yet, and the ones confirmed as empty. */
export function emptyCounts(rows: readonly ReadinessRow[]): Record<EmptyFilter, number> {
  const counts = { empty_unconfirmed: 0, empty: 0 };
  for (const row of rows) {
    if (row.type !== "object") {
      continue;
    }
    if (row.item.state === "empty") {
      counts.empty += 1;
    } else if (isEmptyUnconfirmed(row.item)) {
      counts.empty_unconfirmed += 1;
    }
  }
  return counts;
}

/** Whether a row is shown under a filter. */
export function matchesFilter(row: ReadinessRow, filter: TableFilter): boolean {
  if (filter === "empty_unconfirmed") {
    return row.type === "object" && isEmptyUnconfirmed(row.item);
  }
  return rowRating(row).state === filter;
}

/** "Confirm as empty" and its revocation, wired by the page; absent, the table offers neither. */
export interface EmptyActions {
  /** Ask before confirming these objects as empty (one row, or the selection). */
  ask: (objectIds: string[]) => void;
  revoke: (item: ObjectReadiness) => void;
  /** The object whose confirmation is being revoked right now. */
  revoking: string | null;
}

/**
 * The question before "Confirm as empty", for one object or a selection: what it means and that
 * it ends by itself once a later check finds content.
 */
export function ConfirmEmptyDialog({
  objectIds,
  onOpenChange,
  onConfirm,
  format,
}: {
  /** The objects to confirm; null while the dialog is closed. */
  objectIds: readonly string[] | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (objectIds: readonly string[]) => Promise<unknown>;
  format: VerifyFormat;
}) {
  const { t } = format;
  const count = objectIds?.length ?? 0;
  return (
    <ConfirmDialog
      open={objectIds !== null}
      onOpenChange={onOpenChange}
      title={t("confirmEmpty.title", { count })}
      description={t("confirmEmpty.description", { count })}
      confirmLabel={t("confirmEmpty.confirm")}
      onConfirm={() => (objectIds ? onConfirm(objectIds) : undefined)}
    />
  );
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
  empty,
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
  /** The filter of the table (the address's `state`); undefined shows every object. */
  state?: TableFilter;
  onStateChange: (state: TableFilter | undefined) => void;
  /** "Confirm as empty" (rows, selection) and its revocation; absent, neither is offered. */
  empty?: EmptyActions;
}) {
  const { t } = format;
  const rows = React.useMemo(
    () => readinessRows(items, endpoints, guests, shares),
    [items, endpoints, guests, shares],
  );
  const counts = React.useMemo(() => stateCounts(rows), [rows]);
  const empties = React.useMemo(() => emptyCounts(rows), [rows]);
  const visible = React.useMemo(() => {
    const sorted = sortRowsByUrgency(rows);
    return state ? sorted.filter((row) => matchesFilter(row, state)) : sorted;
  }, [rows, state]);

  // Under "Empty (not confirmed)" the rows can be selected and confirmed together.
  const selecting = state === "empty_unconfirmed" && empty !== undefined;
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const selectable = React.useMemo(
    () => (selecting ? visible.flatMap((row) => (row.type === "object" ? [row.id] : [])) : []),
    [selecting, visible],
  );
  const chosen = selectable.filter((id) => selected.has(id));
  const toggle = (id: string, on: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });

  // Rows are shown in pages of OBJECTS_PAGE_SIZE; a new filter starts on the first page again.
  const [paging, setPaging] = React.useState({ state, shown: OBJECTS_PAGE_SIZE });
  const shown = paging.state === state ? paging.shown : OBJECTS_PAGE_SIZE;
  const page = visible.slice(0, shown);

  return (
    <Card className="pb-0">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{t("table.title")}</CardTitle>
          <CardDescription>{t("table.description")}</CardDescription>
        </div>
      </CardHeader>
      <div className="px-6 pb-4">
        <StateChips<TableFilter>
          counts={counts}
          total={rows.length}
          value={state}
          onChange={onStateChange}
          emptyCounts={empties}
        />
      </div>
      {selecting && selectable.length > 0 ? (
        <div
          className="flex flex-wrap items-center gap-3 border-t bg-muted/40 px-6 py-3 text-sm"
          data-slot="empty-selection"
        >
          <span className="flex items-center gap-2">
            <Checkbox
              checked={
                chosen.length === 0
                  ? false
                  : chosen.length === selectable.length
                    ? true
                    : "indeterminate"
              }
              onCheckedChange={(value) =>
                setSelected(value === true ? new Set(selectable) : new Set())
              }
              aria-label={t("selection.all")}
            />
            {t("selection.count", {
              count: chosen.length,
              total: format.integer(selectable.length),
            })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={chosen.length === 0}
            onClick={() => empty?.ask(chosen)}
          >
            <CircleDashed aria-hidden="true" />
            {t("actions.confirmEmptySelected", { count: chosen.length })}
          </Button>
        </div>
      ) : null}
      <CardContent className="p-0">
        {visible.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">
            {state
              ? t("table.emptyState", {
                  state: t(
                    state === "empty_unconfirmed" ? "chips.empty_unconfirmed" : `state.${state}`,
                  ),
                })
              : t("table.empty")}
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
              {page.map((row) =>
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
                    empty={empty}
                    selection={
                      selecting
                        ? {
                            checked: selected.has(row.id),
                            onChange: (on: boolean) => toggle(row.id, on),
                          }
                        : undefined
                    }
                  />
                ),
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
      {visible.length > OBJECTS_PAGE_SIZE ? (
        // The footer carries its own padding: the card has none at the bottom so the table can
        // run to its edge, and the last row (or the button) must not touch it.
        <div className="border-t px-6 py-4">
          <DataTableLoadMore
            count={page.length}
            hasMore={page.length < visible.length}
            onLoadMore={() => setPaging({ state, shown: shown + OBJECTS_PAGE_SIZE })}
          />
        </div>
      ) : null}
    </Card>
  );
}

function ObjectRow({
  item,
  format,
  nextBackupAt,
  starting,
  onCheck,
  empty,
  selection,
}: {
  item: ObjectReadiness;
  format: VerifyFormat;
  nextBackupAt: string | null;
  starting: boolean;
  onCheck: (item: ObjectReadiness) => void;
  empty?: EmptyActions;
  /** Set while the table offers a selection (`empty_unconfirmed`). */
  selection?: { checked: boolean; onChange: (checked: boolean) => void };
}) {
  const { t } = format;
  return (
    <TableRow data-state={selection?.checked ? "selected" : undefined}>
      <TableCell pin={PIN_FIRST} className="max-w-md pl-6">
        <div className="flex min-w-0 items-start gap-3">
          {selection ? (
            <Checkbox
              className="mt-0.5"
              checked={selection.checked}
              onCheckedChange={(value) => selection.onChange(value === true)}
              aria-label={t("selection.one", { name: objectName(item.object) })}
            />
          ) : null}
          <ObjectCell
            object={item.object}
            inJob={item.inJob !== false}
            emptyConfirmation={item.emptyConfirmation}
            format={format}
          />
        </div>
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
        <ActionsCell
          item={item}
          format={format}
          starting={starting}
          onCheck={onCheck}
          empty={empty}
        />
      </TableCell>
    </TableRow>
  );
}
