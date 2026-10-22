import { ChevronDown, Inbox, Lock, RefreshCw, ShieldQuestion, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog, RelativeTime, StatusBadge, type StatusTone } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import {
  PIN_FIRST,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CauseLine, useCauseTitle } from "@/features/failures";
import { errorMessageKey } from "@/lib/api";
import { formatInteger } from "@/lib/format";
import { useSession } from "@/lib/session";

import {
  type ArchiveHold,
  type CaptureMailbox,
  type CaptureMailboxQuery,
  type MailboxWay,
  type MailboxWayStatus,
  STREAM_STATUSES,
  type StreamStatus,
} from "./api.js";
import { CaptureWaitingJobs } from "./capture-offer.js";
import { CommandBlock } from "./command-block.js";
import {
  useArchiveHolds,
  useCaptureMailboxes,
  useCaptureResync,
  useCaptureStatus,
  useSetArchiveHold,
} from "./hooks.js";
import { CAPTURE_SECTION_ANCHOR } from "./paths.js";

/**
 * The tone of a capture stream: live and taking over are running work (Lapis), an error is
 * red, waiting and switched off are grey. Never green: a capture is no restore check.
 */
export const STREAM_TONE: Readonly<Record<StreamStatus, StatusTone>> = {
  live: "info",
  backfilling: "info",
  pending: "muted",
  paused: "muted",
  disabled: "muted",
  error: "destructive",
};

const ALL = "all";
const PAGE_SIZE = 50;

/**
 * How mail reaches the archive from the mailboxes (docs/ARCHIVE.md "Erfassungswege"): a card
 * each for Graph and IMAP archiving (edition, how mail is noticed, counts, the one-time
 * takeover), the capture per mailbox with a full catch-up on request, and the hold
 * confirmation of the Microsoft 365 sources with the commands that check it. The SMTP ways
 * (Exchange journaling, forwarded copies) are sections of the Business modules
 * (slot `archive.sections`).
 */
export function CaptureStatusSection() {
  const { t } = useTranslation("archive");
  const status = useCaptureStatus();

  return (
    <section
      id={CAPTURE_SECTION_ANCHOR}
      aria-labelledby="archive-capture-title"
      className="scroll-mt-6 space-y-4 rounded-md border p-4"
      data-slot="archive-capture-status"
    >
      <div className="space-y-1">
        <h3 id="archive-capture-title" className="flex items-center gap-2 font-medium">
          <Inbox aria-hidden="true" className="size-4" />
          {t("capture.title")}
        </h3>
        <p className="text-muted-foreground text-sm">{t("capture.description")}</p>
      </div>

      {status.data ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {(status.data.mailbox ?? []).map((way) => (
            <WayCard key={way.way} status={way} />
          ))}
        </div>
      ) : status.isError ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            {t(`common:${errorMessageKey(status.error)}`)}
            <Button variant="outline" size="sm" onClick={() => void status.refetch()}>
              {t("common:actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2" aria-busy="true">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {status.data?.jobs ? <CaptureWaitingJobs jobs={status.data.jobs} /> : null}
      <CaptureMailboxes />
      <HoldsCard />
    </section>
  );
}

function WayCard({ status }: { status: MailboxWayStatus }) {
  const { t, i18n } = useTranslation("archive");
  const causeTitle = useCauseTitle();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const number = (value: number) => formatInteger(value, language);
  const active = STREAM_STATUSES.filter(
    (state) => state !== "disabled" && status.streams[state] > 0,
  );
  const reasons = Object.entries(status.pollReasons).filter(([, count]) => count > 0);
  const inUse = active.length > 0;

  return (
    <div
      className="min-w-0 space-y-3 rounded-md border p-3"
      data-slot={`capture-way-${status.way}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{t(`capture.way.${status.way}`)}</p>
        <Badge variant="outline">{t("capture.assurance.mailbox")}</Badge>
      </div>

      {!status.available ? (
        <p className="text-muted-foreground flex gap-2 text-sm" data-slot="capture-way-edition">
          <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{t("capture.edition")}</span>
        </p>
      ) : !inUse ? (
        <p className="text-muted-foreground text-sm">{t(`capture.unused.${status.way}`)}</p>
      ) : (
        <div className="flex flex-wrap gap-2" data-slot="capture-way-streams">
          {active.map((state) => (
            <StatusBadge key={state} tone={STREAM_TONE[state]} icon live={state === "live"}>
              {t(`capture.streams.${state}`, { count: status.streams[state] })}
            </StatusBadge>
          ))}
        </div>
      )}

      {inUse && status.modes.notifications + status.modes.poll > 0 ? (
        <p className="text-sm" data-slot="capture-way-mode">
          {status.way === "graph_sync"
            ? t("capture.mode.graph", {
                notifications: number(status.modes.notifications),
                poll: number(status.modes.poll),
              })
            : t("capture.mode.imap", {
                notifications: number(status.modes.notifications),
                poll: number(status.modes.poll),
              })}
        </p>
      ) : null}
      {reasons.length > 0 ? (
        <ul className="text-muted-foreground space-y-0.5 text-xs" data-slot="capture-poll-reasons">
          {reasons.map(([code, count]) => (
            <li key={code}>
              {t("capture.pollReason.line", {
                count,
                reason: i18n.exists(`failures:cause.${code}.title`)
                  ? causeTitle(code)
                  : i18n.exists(`archive:capture.pollReason.codes.${code}`)
                    ? t(`capture.pollReason.codes.${code}`)
                    : code,
              })}
            </li>
          ))}
        </ul>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-muted-foreground text-xs">{t("capture.lastCapture")}</dt>
          <dd>
            {status.lastCapturedAt ? (
              <RelativeTime value={status.lastCapturedAt} />
            ) : (
              t("capture.never")
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">{t("capture.counts.last24Hours")}</dt>
          <dd className="tabular-nums">
            {t("capture.counts.value", {
              items: number(status.items24h),
              captures: number(status.captures24h),
              count: status.captures24h,
            })}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">{t("capture.counts.last7Days")}</dt>
          <dd className="tabular-nums">
            {t("capture.counts.value", {
              items: number(status.items7d),
              captures: number(status.captures7d),
              count: status.captures7d,
            })}
          </dd>
        </div>
      </dl>

      {status.backfill.total > 0 ? (
        <div className="space-y-1" data-slot="capture-backfill">
          <p className="text-xs">
            {t("capture.backfill.progress", {
              completed: number(status.backfill.completed),
              total: number(status.backfill.total),
            })}
          </p>
          <Progress
            className="h-1.5"
            max={status.backfill.total}
            value={status.backfill.completed}
            aria-label={t("capture.backfill.label")}
          />
          {status.capturedLate7d > 0 ? (
            <p className="text-muted-foreground text-xs">
              {t("capture.backfill.late", { count: status.capturedLate7d })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A mailbox as people know it: its name and address, or the address alone. */
function mailboxLabel(row: CaptureMailbox): string {
  return row.displayName && row.displayName !== row.externalId
    ? `${row.displayName} (${row.externalId})`
    : row.externalId;
}

function CaptureMailboxes() {
  const { t } = useTranslation("archive");
  const session = useSession();
  // Read here, not through hasFeature: pages mock the session module with useSession alone.
  const canResync = session.features?.includes("archive.mailboxCapture") ?? false;
  const [way, setWay] = React.useState<MailboxWay | undefined>(undefined);
  const [state, setState] = React.useState<StreamStatus | undefined>(undefined);
  const [cursors, setCursors] = React.useState<string[]>([]);
  const query: CaptureMailboxQuery = {
    ...(way ? { way } : {}),
    ...(state ? { status: state } : {}),
    ...(cursors.length > 0 ? { cursor: cursors[cursors.length - 1] } : {}),
    limit: PAGE_SIZE,
  };
  const page = useCaptureMailboxes(query);
  const resync = useCaptureResync();
  const rows = page.data?.items ?? [];
  const filtered = way !== undefined || state !== undefined;

  // A new filter starts from the first page.
  const filter = (next: { way?: MailboxWay; state?: StreamStatus }) => {
    if ("way" in next) setWay(next.way);
    if ("state" in next) setState(next.state);
    setCursors([]);
  };

  if (page.data && rows.length === 0 && !filtered && cursors.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2" data-slot="capture-mailboxes">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h4 className="text-sm font-medium">{t("capture.mailboxes.title")}</h4>
        <div className="flex flex-wrap gap-2">
          <Select
            value={way ?? ALL}
            onValueChange={(value) =>
              filter({ way: value === ALL ? undefined : (value as MailboxWay) })
            }
          >
            <SelectTrigger size="sm" aria-label={t("capture.mailboxes.filterWay")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("capture.mailboxes.allWays")}</SelectItem>
              <SelectItem value="graph_sync">{t("capture.way.graph_sync")}</SelectItem>
              <SelectItem value="imap_sync">{t("capture.way.imap_sync")}</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={state ?? ALL}
            onValueChange={(value) =>
              filter({ state: value === ALL ? undefined : (value as StreamStatus) })
            }
          >
            <SelectTrigger size="sm" aria-label={t("capture.mailboxes.filterStatus")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("capture.mailboxes.allStates")}</SelectItem>
              {STREAM_STATUSES.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`capture.status.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {page.isError ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>{t(`common:${errorMessageKey(page.error)}`)}</AlertDescription>
        </Alert>
      ) : !page.data ? (
        <Skeleton className="h-24 w-full" aria-busy="true" />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("capture.mailboxes.none")}</p>
      ) : (
        <Table className="min-w-[44rem]" scrollLabel={t("capture.mailboxes.title")}>
          <TableHeader>
            <TableRow>
              <TableHead pin={PIN_FIRST}>{t("capture.mailboxes.mailbox")}</TableHead>
              <TableHead>{t("capture.mailboxes.way")}</TableHead>
              <TableHead>{t("capture.mailboxes.status")}</TableHead>
              <TableHead>{t("capture.mailboxes.lastCapture")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("capture.mailboxes.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.streamId} data-slot="capture-mailbox-row">
                <TableCell pin={PIN_FIRST} className="max-w-72">
                  <span className="block truncate font-medium" title={mailboxLabel(row)}>
                    {mailboxLabel(row)}
                  </span>
                  {row.failure ? <CauseLine failure={row.failure} className="block" /> : null}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  {t(`capture.way.${row.way}`)}
                  {row.mode ? (
                    <span className="text-muted-foreground block">
                      {t(`capture.mailboxes.mode.${row.mode}`)}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <StatusBadge tone={STREAM_TONE[row.status]} icon>
                    {t(`capture.status.${row.status}`)}
                  </StatusBadge>
                  {row.status === "backfilling" || row.backfillCompletedAt === null ? null : (
                    <span className="text-muted-foreground block text-xs">
                      {t("capture.mailboxes.backfillDone")}
                    </span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm">
                  {row.lastCaptureAt ? (
                    <RelativeTime value={row.lastCaptureAt} />
                  ) : (
                    <span className="text-muted-foreground">{t("capture.never")}</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {row.status === "disabled" || row.status === "paused" ? null : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canResync || resync.isPending}
                      title={canResync ? undefined : t("capture.edition")}
                      onClick={() =>
                        resync.mutate(row.protectedObjectId, {
                          onSuccess: () =>
                            toast.success(
                              t("capture.mailboxes.resyncDone", { mailbox: mailboxLabel(row) }),
                            ),
                          onError: (error) => toast.error(t(`common:${errorMessageKey(error)}`)),
                        })
                      }
                      aria-label={t("capture.mailboxes.resyncFor", { mailbox: mailboxLabel(row) })}
                    >
                      <RefreshCw aria-hidden="true" />
                      {t("capture.mailboxes.resync")}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {cursors.length > 0 || page.data?.nextCursor ? (
        <nav
          aria-label={t("capture.mailboxes.pages")}
          className="flex justify-end gap-2"
          data-slot="capture-mailbox-pages"
        >
          <Button
            variant="outline"
            size="sm"
            disabled={cursors.length === 0 || page.isFetching}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            {t("capture.mailboxes.previous")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!page.data?.nextCursor || page.isFetching}
            onClick={() => {
              const next = page.data?.nextCursor;
              if (next) setCursors((current) => [...current, next]);
            }}
          >
            {t("capture.mailboxes.next")}
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

/**
 * Whether deleted mail stays in each Microsoft 365 tenant for Graph to capture: a retention
 * policy or litigation hold, which an administrator confirms after checking it with the
 * commands shown (Restow cannot read it from Graph). Shown for sources Graph captures from.
 */
function HoldsCard() {
  const { t, i18n } = useTranslation("archive");
  const holds = useArchiveHolds();
  const items = (holds.data?.items ?? []).filter(
    (hold) => hold.graphMailboxes > 0 || hold.status === "confirmed",
  );
  const checks = holds.data?.checks ?? [];
  if (items.length === 0) {
    return null;
  }
  const open = items.some((hold) => hold.status !== "confirmed");
  return (
    <div className="space-y-3 rounded-md border p-3" data-slot="capture-holds">
      <div className="space-y-0.5">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <ShieldQuestion aria-hidden="true" className="size-4" />
          {t("capture.hold.title")}
        </h4>
        <p className="text-muted-foreground text-xs">{t("capture.hold.description")}</p>
      </div>
      <ul className="space-y-4">
        {items.map((hold) => (
          <HoldRow key={hold.sourceId} hold={hold} />
        ))}
      </ul>
      {checks.length > 0 ? (
        <Collapsible defaultOpen={open} className="space-y-2" data-slot="capture-hold-checks">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="group -ml-2">
              <ChevronDown
                aria-hidden="true"
                className="transition-transform group-data-[state=closed]:-rotate-90"
              />
              {t("capture.hold.commands")}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3">
            <p className="text-muted-foreground text-xs">{t("capture.hold.commandsIntro")}</p>
            {checks.map((check) => (
              <CommandBlock
                key={check.id}
                id={`hold-check-${check.id}`}
                label={
                  i18n.exists(`archive:capture.holds.checks.${check.id}`)
                    ? t(`capture.holds.checks.${check.id}`)
                    : check.id
                }
                value={check.command}
              />
            ))}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

function HoldRow({ hold }: { hold: ArchiveHold }) {
  const { t } = useTranslation("archive");
  const setHold = useSetArchiveHold();
  const confirmed = hold.status === "confirmed";
  const change = (status: ArchiveHold["status"]) =>
    setHold.mutateAsync({ sourceId: hold.sourceId, status }).then(() => {
      toast.success(
        t(status === "confirmed" ? "capture.hold.confirmed" : "capture.hold.withdrawn"),
      );
    });

  return (
    <li className="min-w-0 space-y-2" data-slot="capture-hold" data-status={hold.status}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{hold.name}</span>
        <StatusBadge tone={confirmed ? "neutral" : "warning"} icon>
          {confirmed ? t("capture.hold.statusConfirmed") : t("capture.hold.statusUnknown")}
        </StatusBadge>
        {confirmed && hold.confirmedAt ? (
          <span className="text-muted-foreground text-xs">
            {t("capture.hold.confirmedBy", { by: hold.confirmedBy ?? "—" })}{" "}
            <RelativeTime value={hold.confirmedAt} />
          </span>
        ) : null}
      </div>
      {confirmed ? null : (
        <p className="text-muted-foreground text-xs">
          {t("capture.hold.why", { count: hold.graphMailboxes })}
        </p>
      )}
      {confirmed ? (
        <ConfirmDialog
          trigger={
            <Button variant="outline" size="sm">
              {t("capture.hold.withdraw")}
            </Button>
          }
          title={t("capture.hold.withdrawTitle", { source: hold.name })}
          description={t("capture.hold.withdrawDescription")}
          confirmLabel={t("capture.hold.withdraw")}
          onConfirm={() => change("unknown")}
        />
      ) : (
        <ConfirmDialog
          trigger={<Button size="sm">{t("capture.hold.confirm")}</Button>}
          title={t("capture.hold.confirmTitle", { source: hold.name })}
          description={t("capture.hold.confirmDescription")}
          confirmLabel={t("capture.hold.confirm")}
          onConfirm={() => change("confirmed")}
        />
      )}
    </li>
  );
}
