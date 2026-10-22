import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, ShieldCheck, X } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { DetailFact, DetailSection, LogBlock as KitLogBlock, RelativeTime } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { useTenantScope } from "@/features/endpoints/hooks";
import { errorMessageKey } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";

import {
  fetchGuest,
  guestRefreshMs,
  type PveGuest,
  type PveJob,
  type PveNode,
  type PveRestorePoint,
  type PveRun,
  pveKeys,
  verifyGuest,
} from "./api.js";
import { activityHint, BackupProgress } from "./backup-progress.js";
import { GuestActionButton, GuestState, type SelfBackupGuard, shortDate } from "./guest-cells.js";
import { PVE_NAMESPACE } from "./i18n.js";
import { guestTo } from "./paths.js";
import { RestowServerNote } from "./self-backup.js";

/**
 * The detail panel of a guest on VMs & containers (0.4.3): everything the table row leaves
 * out, so the row can stay one line. Opened by clicking the row or its name (`?guest=<id>`, so
 * a link opens it), closed with Esc or the close button; focus goes back to the guest's name in
 * the table. It shows every state, the complete error and warning texts (monospace, scrollable,
 * copyable), the restore check, the backup sizes, the job, the newest runs and the actions.
 */

/** The log block of the panel: the kit's, kept under its old name for this feature's tests. */
export function LogBlock(props: React.ComponentProps<typeof KitLogBlock>) {
  return <KitLogBlock {...props} data-slot={props["data-slot"] ?? "pve-log"} />;
}

const Section = DetailSection;
const Fact = DetailFact;

/** The newest runs of the guest from its detail: what ran, how it ended, and its full text. */
function RecentRuns({ runs, shown }: { runs: readonly PveRun[]; shown?: string | null }) {
  const { t, i18n } = useTranslation(PVE_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("guest.noRuns")}</p>;
  }
  return (
    <ol className="space-y-3" data-slot="pve-sheet-runs">
      {runs.map((run) => {
        const warnings = run.warnings ?? [];
        const variant =
          run.status === "failed"
            ? "destructive"
            : run.status === "running"
              ? "info"
              : run.status === "cancelled"
                ? "muted"
                : warnings.length > 0
                  ? "warning"
                  : "outline";
        return (
          <li key={run.id} className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{t(`guest.kind.${run.kind}`)}</span>
              <Badge variant={variant}>
                {run.status === "succeeded" && warnings.length > 0
                  ? t("guests.succeededWithWarnings")
                  : t(`guest.${run.status}`)}
              </Badge>
              <span className="text-muted-foreground tabular-nums">
                {formatDateTime(run.startedAt, language)}
              </span>
            </div>
            {run.error && run.error !== shown ? (
              <LogBlock
                text={run.error}
                tone="destructive"
                label={t("sheet.copyError")}
                name={t("sheet.lastError")}
              />
            ) : null}
            {warnings.length > 0 ? (
              <LogBlock
                text={warnings.join("\n")}
                tone="warning"
                label={t("sheet.copyWarnings")}
                name={t("sheet.warnings")}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** How many restore points the "new data per backup" bars show, newest last. */
export const SHEET_BARS = 30;

/**
 * What each backup added to the repository (#58), as small bars, oldest left: the first
 * backup is the full one, the others what changed. From the guest's restore points, which
 * the panel loads anyway; points that did not record it are left out.
 */
export function AddedBars({ points }: { points: readonly PveRestorePoint[] }) {
  const { t, i18n } = useTranslation(PVE_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const bars = [...points]
    .filter((point) => point.added !== null && point.added !== undefined)
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-SHEET_BARS);
  if (bars.length < 2) {
    return null;
  }
  const max = Math.max(...bars.map((point) => point.added ?? 0), 1);
  return (
    <figure className="space-y-1" data-slot="pve-sheet-added">
      <figcaption className="text-xs text-muted-foreground">{t("sheet.addedChart")}</figcaption>
      <ol className="flex h-16 items-end gap-px rounded-md border bg-muted/30 p-1">
        {bars.map((point) => {
          const date = shortDate(point.backupAt, language);
          const size = formatBytes(point.added ?? 0, language);
          const label =
            point.backupType === "first"
              ? t("sheet.addedFirst", { date, size })
              : t("sheet.addedBar", { date, size });
          return (
            <li key={point.id} title={label} className="flex h-full min-w-0 flex-1 items-end">
              <span
                className="block w-full rounded-t-sm bg-info/70"
                style={{ height: `${Math.max(4, ((point.added ?? 0) / max) * 100)}%` }}
              />
              <span className="sr-only">{label}</span>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}

/** How many of the newest runs the panel lists. */
export const SHEET_RUNS = 5;

export interface GuestSheetProps {
  /** The guest of the open panel; null keeps it closed. */
  guestId: string | null;
  /** The guest as the overview has it (refreshes with it); null while not found. */
  guest: PveGuest | null;
  node: PveNode | null;
  jobs: readonly PveJob[];
  loading?: boolean;
  onClose: () => void;
  guard: SelfBackupGuard;
  onAssign: (guest: PveGuest, jobId: string | null) => void;
  assigning?: boolean;
  /** Where focus goes when the panel closes (the name in the guest's row). */
  returnFocus?: () => HTMLElement | null;
}

export function GuestSheet({
  guestId,
  guest,
  node,
  jobs,
  loading = false,
  onClose,
  guard,
  onAssign,
  assigning = false,
  returnFocus,
}: GuestSheetProps) {
  const { t, i18n } = useTranslation(PVE_NAMESPACE);
  const { t: tc } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const { tenantId } = useTenantScope();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: pveKeys.guest(tenantId, guestId ?? ""),
    queryFn: () => fetchGuest(guestId ?? ""),
    enabled: guestId !== null,
    refetchInterval: (query) => guestRefreshMs(query.state.data),
  });
  const check = useMutation({
    mutationFn: (id: string) => verifyGuest(id),
    onSuccess: () => {
      toast.success(t("readiness.checkQueued"));
      void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) });
    },
    onError: (error) => toast.error(tc(errorMessageKey(error))),
  });
  const name = guest ? (guest.name ?? String(guest.vmid)) : "";
  const verify = guest?.lastVerify ?? null;
  const warnings = guest?.lastRunWarnings ?? [];
  const runs = (detail.data?.runs ?? []).slice(0, SHEET_RUNS);
  const hint = guest ? activityHint(t, language, guest, node) : undefined;
  const last = guest?.backups?.last ?? null;
  const first = guest?.backups?.first ?? null;
  const followUp = guest?.backups?.followUp ?? null;
  const description = guest
    ? [
        `${guest.kind === "vm" ? "VM" : "CT"} ${guest.vmid}`,
        guest.node ?? t("inventory.unknownNode"),
        guest.jobName ?? t("guests.noJob"),
      ].join(" · ")
    : "";

  return (
    <Sheet open={guestId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        hideClose
        data-slot="pve-guest-sheet"
        className="w-full gap-0 p-0 motion-reduce:animate-none motion-reduce:transition-none sm:w-[min(640px,96vw)] sm:max-w-none"
        onCloseAutoFocus={(event) => {
          const target = returnFocus?.();
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <div className="flex items-start gap-3 border-b border-border p-4">
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-[15.5px]">
              {guest ? name : t("sheet.title")}
            </SheetTitle>
            <SheetDescription className="truncate text-xs">
              {description || t("sheet.loading")}
            </SheetDescription>
          </div>
          <SheetClose asChild>
            <Button variant="ghost" size="icon" className="-mt-1 -mr-1 shrink-0">
              <X aria-hidden="true" />
              <span className="sr-only">{t("sheet.close")}</span>
            </Button>
          </SheetClose>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-4">
          {!guest ? (
            loading ? (
              <div className="space-y-4" aria-busy="true">
                <Skeleton className="h-6 w-1/2" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("sheet.notFound")}</p>
            )
          ) : (
            <>
              <Section title={t("sheet.state")} slot="pve-sheet-state">
                <GuestState guest={guest} node={node} />
                {hint ? (
                  <p className="text-sm whitespace-pre-line text-muted-foreground">{hint}</p>
                ) : null}
                {guest.activity === "running" ? (
                  <BackupProgress
                    progress={guest.progress}
                    name={name}
                    node={guest.activityNode}
                    className="max-w-none"
                  />
                ) : null}
                <RestowServerNote guest={guest} />
              </Section>

              <div className="flex flex-wrap gap-2" data-slot="pve-sheet-actions">
                <GuestActionButton guest={guest} guard={guard} className="justify-start" />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  loading={check.isPending}
                  disabled={!last || verify?.requested}
                  onClick={() => check.mutate(guest.id)}
                  data-slot="pve-sheet-check"
                >
                  <ShieldCheck aria-hidden="true" />
                  {verify?.requested ? t("readiness.checkWaiting") : t("readiness.checkNow")}
                </Button>
                <Link
                  {...guestTo(guest.id)}
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                  data-slot="pve-sheet-open"
                >
                  <ExternalLink aria-hidden="true" />
                  {t("sheet.openPage")}
                </Link>
              </div>

              {guest.lastRunStatus === "failed" && guest.lastRunError ? (
                <Section title={t("sheet.lastError")} slot="pve-sheet-error">
                  <LogBlock
                    text={guest.lastRunError}
                    tone="destructive"
                    label={t("sheet.copyError")}
                    name={t("sheet.lastError")}
                    data-slot="pve-guest-error"
                  />
                </Section>
              ) : null}

              {warnings.length > 0 ? (
                <Section title={t("sheet.warnings")} slot="pve-sheet-warnings">
                  <LogBlock
                    text={warnings.join("\n")}
                    tone="warning"
                    label={t("sheet.copyWarnings")}
                    name={t("sheet.warnings")}
                    data-slot="pve-guest-warnings"
                  />
                </Section>
              ) : null}

              <Section title={t("sheet.restoreCheck")} slot="pve-sheet-verify">
                <dl className="space-y-1.5">
                  <Fact label={t("sheet.result")}>
                    {verify?.state === "green"
                      ? t("readiness.result.green")
                      : verify?.state === "red"
                        ? t("readiness.result.red")
                        : verify?.state === "yellow" && verify.notChecked
                          ? t(
                              verify.notChecked.reason === "locked"
                                ? "readiness.result.notCheckedLocked"
                                : "readiness.result.notCheckedInterrupted",
                            )
                          : verify?.state
                            ? t("sheet.verifyPostponed")
                            : last
                              ? t("readiness.result.unverified")
                              : t("readiness.result.noBackup")}
                  </Fact>
                  {verify?.checkedAt ? (
                    <Fact
                      label={verify.state === "yellow" ? t("sheet.gaveUpAt") : t("sheet.checkedAt")}
                    >
                      <RelativeTime value={verify.checkedAt} />
                    </Fact>
                  ) : null}
                  {verify?.notChecked && !verify.notChecked.gaveUp ? (
                    // Tried again shortly; the result above (if any) still stands.
                    <Fact label={t("sheet.next")}>
                      <span data-slot="pve-sheet-verify-postponed">
                        {verify.notChecked.reason === "locked"
                          ? t("guest.verifyPostponedLocked")
                          : t("guest.verifyPostponedInterrupted")}
                      </span>
                    </Fact>
                  ) : verify?.requested ? (
                    <Fact label={t("sheet.next")}>{t("readiness.checkWaiting")}</Fact>
                  ) : null}
                </dl>
                {verify && verify.errors.length > 0 ? (
                  <LogBlock
                    text={verify.errors.join("\n")}
                    tone={verify.state === "red" ? "destructive" : "warning"}
                    label={t("sheet.copyCheck")}
                    name={t("sheet.restoreCheck")}
                    data-slot="pve-guest-verify-error"
                  />
                ) : null}
                {verify?.notChecked?.detail ? (
                  // What restic said, e.g. who holds the repository's lock: amber, no finding.
                  <LogBlock
                    text={verify.notChecked.detail}
                    tone="warning"
                    label={t("sheet.copyNotChecked")}
                    name={t("sheet.notChecked")}
                    data-slot="pve-guest-verify-not-checked"
                  />
                ) : null}
              </Section>

              <Section title={t("sheet.backup")} slot="pve-sheet-backup">
                <dl className="space-y-1.5">
                  <Fact label={t("guests.lastBackup")}>
                    <RelativeTime value={guest.lastBackupAt} fallback={t("guests.never")} />
                  </Fact>
                  <Fact label={t("sheet.contains")}>
                    {last ? formatBytes(last.contains, language) : t("guests.backupNone")}
                  </Fact>
                  {last && last.added !== null ? (
                    <Fact label={t("guest.added")}>+{formatBytes(last.added, language)}</Fact>
                  ) : null}
                  {first ? (
                    <Fact label={t("sheet.first")}>
                      {t("guests.backupFirst", {
                        date: formatDateTime(first.at, language) ?? "",
                        size: formatBytes(first.added ?? first.contains, language),
                      })}
                    </Fact>
                  ) : null}
                  {followUp ? (
                    <Fact label={t("sheet.followUp")}>
                      {t("guests.backupFollowUp", {
                        size: formatBytes(followUp.added, language),
                        count: followUp.points,
                      })}
                    </Fact>
                  ) : null}
                  {(last?.unreadable ?? 0) > 0 ? (
                    <Fact label={t("sheet.gaps")}>
                      {t("guests.incompleteHint", { count: last?.unreadable ?? 0 })}
                    </Fact>
                  ) : null}
                  {guest.diskBytes > 0 ? (
                    <Fact label={t("guests.size")}>
                      {t("guests.diskAllocated", { size: formatBytes(guest.diskBytes, language) })}
                    </Fact>
                  ) : null}
                </dl>
                <AddedBars points={detail.data?.snapshots ?? []} />
              </Section>

              <Section title={t("guests.job")} slot="pve-sheet-job">
                <select
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  aria-label={t("guests.job")}
                  value={guest.jobId ?? ""}
                  disabled={assigning || (guest.kind === "vm" && guest.template)}
                  onChange={(event) => onAssign(guest, event.target.value || null)}
                >
                  <option value="">{t("guests.noJob")}</option>
                  {jobs.map((job) => (
                    <option key={job.id} value={job.id}>
                      {job.name}
                    </option>
                  ))}
                </select>
              </Section>

              <Section title={t("sheet.runs")}>
                {detail.isPending ? (
                  <Skeleton className="h-16 w-full" />
                ) : (
                  <RecentRuns
                    runs={runs}
                    shown={guest.lastRunStatus === "failed" ? guest.lastRunError : null}
                  />
                )}
              </Section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
