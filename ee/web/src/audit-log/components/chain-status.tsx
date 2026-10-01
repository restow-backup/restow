import type { UseQueryResult } from "@tanstack/react-query";
import { Loader2, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";
import type * as React from "react";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ChainBreak, ChainReport, ChainStatus, ChainVerification } from "../api";
import type { AuditFormat } from "../hooks";
import { breakEntryId, sortChainReports } from "../presenters";

/**
 * The chain's integrity at a glance (header badge), the alert a broken chain
 * raises on the page, and the per-chain verification details.
 */

type BadgeState = ChainStatus | "verifying" | "error";

const BADGE: Record<
  BadgeState,
  { icon: typeof ShieldCheck; variant: "success" | "destructive" | "muted" | "warning" }
> = {
  intact: { icon: ShieldCheck, variant: "success" },
  broken: { icon: ShieldX, variant: "destructive" },
  empty: { icon: ShieldQuestion, variant: "muted" },
  error: { icon: ShieldAlert, variant: "warning" },
  verifying: { icon: Loader2, variant: "muted" },
};

function badgeState(verification: UseQueryResult<ChainVerification>): BadgeState {
  if (verification.isFetching || verification.isPending) {
    return "verifying";
  }
  if (verification.isError) {
    return "error";
  }
  return verification.data.status;
}

/** Name of a chain: the tenant, or the installation chain. */
export function chainName(
  report: Pick<ChainReport, "tenantId" | "tenantName">,
  format: AuditFormat,
) {
  return report.tenantId === null
    ? format.t("chain.installation")
    : (report.tenantName ?? report.tenantId);
}

/** One sentence on what broke and where. */
export function breakMessage(value: ChainBreak, format: AuditFormat): string {
  if (value.reason === "anchor_mismatch") {
    return format.t("chain.break.anchor_mismatch", {
      date: format.anchorDate(value.anchorDate),
      anchored: value.anchoredCount,
      found: value.chainCount,
    });
  }
  return format.t(`chain.break.${value.reason}`, { position: value.position });
}

function StatusIcon({ state }: { state: BadgeState }) {
  const Icon = BADGE[state].icon;
  return <Icon className={cn(state === "verifying" && "animate-spin")} aria-hidden="true" />;
}

/** Header badge; opens the verification details. */
export function ChainStatusButton({
  verification,
  format,
  onOpen,
}: {
  verification: UseQueryResult<ChainVerification>;
  format: AuditFormat;
  onOpen: () => void;
}) {
  const state = badgeState(verification);
  const settled = state !== "verifying";
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!settled}
      aria-haspopup="dialog"
      title={settled ? format.t("chain.openDetails") : undefined}
      className={cn(
        badgeVariants({ variant: BADGE[state].variant }),
        "h-9 gap-1.5 px-3 text-sm [&>svg]:size-4",
        settled && "cursor-pointer hover:opacity-90",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <StatusIcon state={state} />
      <span aria-live="polite">{format.t(`chain.status.${state}`)}</span>
    </button>
  );
}

/** Page alert while any verified chain is broken. */
export function ChainBrokenAlert({
  verification,
  format,
  onShowEntry,
  onOpenDetails,
}: {
  verification: ChainVerification;
  format: AuditFormat;
  onShowEntry: (entryId: string) => void;
  onOpenDetails: () => void;
}) {
  const broken = verification.chains.filter((chain) => chain.firstBreak !== null);
  const [only] = broken;
  if (!only?.firstBreak) {
    return null;
  }
  const single = broken.length === 1;
  const entryId = single ? breakEntryId(only.firstBreak) : null;
  return (
    <Alert variant="destructive">
      <ShieldX />
      <AlertTitle>{format.t("chain.alert.title")}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          {single
            ? format.t("chain.alert.single", {
                chain: chainName(only, format),
                problem: breakMessage(only.firstBreak, format),
              })
            : format.t("chain.alert.multiple", { count: broken.length })}
        </p>
        <p className="text-muted-foreground">{format.t("chain.alert.hint")}</p>
        <div className="flex flex-wrap gap-2">
          {entryId ? (
            <Button size="sm" variant="outline" onClick={() => onShowEntry(entryId)}>
              {format.t("chain.showEntry")}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={onOpenDetails}>
            {format.t("chain.openDetails")}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function ChainStatusBadge({ status, format }: { status: ChainStatus; format: AuditFormat }) {
  return (
    <Badge variant={BADGE[status].variant}>
      <StatusIcon state={status} />
      {format.t(`chain.status.${status}`)}
    </Badge>
  );
}

function ChainReportItem({
  report,
  format,
  onShowEntry,
}: {
  report: ChainReport;
  format: AuditFormat;
  onShowEntry: (entryId: string) => void;
}) {
  const { t } = format;
  const entryId = report.firstBreak ? breakEntryId(report.firstBreak) : null;
  const latest = report.anchors.latest;
  return (
    <li className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 truncate font-medium">{chainName(report, format)}</p>
        <ChainStatusBadge status={report.status} format={format} />
      </div>
      <div className="space-y-1 text-sm text-muted-foreground">
        {report.status === "empty" && report.anchors.total === 0 ? (
          <p>{t("chain.emptyChain")}</p>
        ) : (
          <p>
            {t("chain.verifiedEntries", { count: report.verifiedEntries })}
            {report.head ? (
              <span className="block text-xs">
                {t("chain.newest", { when: format.dateTime(report.head.createdAt) })}
              </span>
            ) : null}
          </p>
        )}
        {report.anchors.total === 0 ? (
          report.status === "empty" ? null : (
            <p>{t("chain.noAnchor")}</p>
          )
        ) : (
          <p>
            {t("chain.anchors", { verified: report.anchors.verified, total: report.anchors.total })}
            {latest ? (
              <span className="block text-xs">
                {t("chain.latestAnchor", {
                  date: format.anchorDate(latest.date),
                  count: latest.count,
                })}
              </span>
            ) : null}
          </p>
        )}
      </div>
      {report.firstBreak ? (
        <div className="space-y-2 rounded-md bg-destructive/10 p-2.5 text-sm">
          <p>{breakMessage(report.firstBreak, format)}</p>
          {entryId ? (
            <Button size="sm" variant="outline" onClick={() => onShowEntry(entryId)}>
              {t("chain.showEntry")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Per-chain verification results. */
export function ChainDialog({
  open,
  onOpenChange,
  verification,
  format,
  onShowEntry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  verification: UseQueryResult<ChainVerification>;
  format: AuditFormat;
  onShowEntry: (entryId: string) => void;
}) {
  const { t } = format;
  const data = verification.data;
  let body: React.ReactNode;
  if (verification.isError) {
    body = (
      <ErrorState
        title={t("chain.error")}
        error={verification.error}
        onRetry={() => void verification.refetch()}
        retrying={verification.isFetching}
      />
    );
  } else if (!data) {
    body = null;
  } else if (data.chains.length === 0) {
    body = <p className="text-sm text-muted-foreground">{t("chain.dialog.noChains")}</p>;
  } else {
    body = (
      // The viewport carries the height cap: a max-height on the root leaves the
      // viewport as tall as its content, so nothing would scroll.
      <ScrollArea className="pr-3 [&>[data-slot=scroll-area-viewport]]:max-h-[60vh]">
        <ul className="space-y-3">
          {sortChainReports(data.chains).map((report) => (
            <ChainReportItem
              key={report.tenantId ?? "installation"}
              report={report}
              format={format}
              onShowEntry={onShowEntry}
            />
          ))}
        </ul>
      </ScrollArea>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("chain.dialog.title")}</DialogTitle>
          <DialogDescription>{t("chain.dialog.description")}</DialogDescription>
        </DialogHeader>
        {data && !verification.isError ? (
          <p className="text-xs text-muted-foreground">
            {t("chain.dialog.checked", {
              when: format.relative(data.verifiedAt),
              duration: format.duration(data.durationMs),
            })}
          </p>
        ) : null}
        {body}
        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={() => void verification.refetch()}
            loading={verification.isFetching}
          >
            {t("chain.verifyNow")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
