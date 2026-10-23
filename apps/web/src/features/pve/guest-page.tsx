import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, History, Play, RotateCcw } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { DetailHover, PageHeader, RefreshButton, RelativeTime } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTenantScope } from "@/features/endpoints/hooks";
import { fileRestoreContainerTo } from "@/features/endpoints/paths";
import { BackupDestinationNote, ServerDiskWarning, useStorageScope } from "@/features/storage";
import {
  judgementsById,
  LastCleanHint,
  ObjectSuspicionBadge,
  RetentionHoldNotice,
  SuspicionBadge,
  useObjectSuspicions,
} from "@/features/suspicion";
import { formatBytes, formatDateTime } from "@/lib/format";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import {
  backupNow,
  fetchGuest,
  guestRefreshMs,
  type PveFollowUpAverage,
  type PveGuest,
  type PveGuestDetail,
  type PveRepositoryChain,
  type PveRestorePoint,
  type PveRun,
  pveKeys,
  requestBootTest,
  resetRepository,
  restoreSnapshot,
  setRestowServer,
  verifySnapshot,
} from "./api.js";
import { BackupProgress } from "./backup-progress.js";
import { BootTestBadge, BootTestFacts, bootTestVariant } from "./boot-test.js";
import { CancelBackupButton, CancelledBadge, CancellingBadge } from "./cancel-controls.js";
import { PVE_NAMESPACE } from "./i18n.js";
import { pveTo } from "./paths.js";
import { RestowServerNote, useSelfBackupGuard } from "./self-backup.js";

/** File restore with this container chosen, as `<Link>` takes it. */
function fileRestoreLink(guestId: string) {
  const target = fileRestoreContainerTo(guestId);
  return { to: target.to, search: target.search as never };
}

function RestoreDialog({
  point,
  detail,
  onClose,
}: {
  point: PveRestorePoint;
  detail: PveGuestDetail;
  onClose: () => void;
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const [storage, setStorage] = React.useState("local-lvm");
  const [node, setNode] = React.useState(detail.guest.node ?? "");
  const [vmid, setVmid] = React.useState("");
  const [start, setStart] = React.useState(false);
  const mutation = useMutation({
    mutationFn: () =>
      restoreSnapshot(point.id, {
        targetStorage: storage,
        targetNode: node || undefined,
        targetVmid: vmid ? Number(vmid) : undefined,
        start,
      }),
    onSuccess: () => {
      toast.success(t("restore.queued"));
      onClose();
    },
  });
  const blocked = detail.guest.kind === "ct" && detail.guest.privileged;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("restore.title")}</DialogTitle>
            <DialogDescription>{t("restore.description")}</DialogDescription>
          </DialogHeader>
          {blocked ? (
            <p className="text-sm text-destructive-text">{t("restore.privileged")}</p>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="pve-restore-storage">{t("restore.targetStorage")}</Label>
            <Input
              id="pve-restore-storage"
              value={storage}
              onChange={(e) => setStorage(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pve-restore-node">{t("restore.targetNode")}</Label>
            <Input id="pve-restore-node" value={node} onChange={(e) => setNode(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pve-restore-vmid">{t("restore.vmid")}</Label>
            <Input
              id="pve-restore-vmid"
              type="number"
              min={100}
              value={vmid}
              onChange={(e) => setVmid(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} />
            {t("restore.start")}
          </label>
          {mutation.isError ? (
            <p className="text-sm text-destructive-text">{(mutation.error as Error).message}</p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={blocked || mutation.isPending || storage.trim() === ""}>
              {t("restore.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Green only for proof: a restore or a restore check that completed. A
 * backup that completed is neutral, running work is informational. A boot
 * test is green only when the restored guest answered (its outcome decides).
 */
function runTone(
  run: Pick<PveRun, "kind" | "status" | "stats">,
): "success" | "outline" | "destructive" | "info" | "warning" | "muted" {
  if (run.status === "running") {
    return "info";
  }
  if (run.kind === "boot_test" && run.stats?.bootTest) {
    return bootTestVariant(run.stats.bootTest.outcome);
  }
  if (run.status === "failed") {
    return "destructive";
  }
  if (run.status === "cancelled") {
    return "muted";
  }
  return run.kind === "backup" ? "outline" : "success";
}

/** The label of a run's status; a finished boot test says how it ended. */
function runStatusKey(run: Pick<PveRun, "kind" | "status" | "stats">): string {
  if (run.status !== "running" && run.kind === "boot_test" && run.stats?.bootTest) {
    return `guest.bootTestOutcome.${run.stats.bootTest.outcome}`;
  }
  return `guest.${run.status}`;
}

export function VerifyBadge({ point }: { point: PveRestorePoint }) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const result = <VerifyResult point={point} />;
  // Checked before and asked again: the new check is queued; the earlier result stands under it.
  if (point.verifyRequested && typeof point.verify?.checkedAt === "string") {
    return (
      <div className="space-y-1" data-slot="pve-point-verify-requeued">
        <Badge variant="info">{t("guest.verifyQueuedBadge")}</Badge>
        {result}
      </div>
    );
  }
  return result;
}

function VerifyResult({ point }: { point: PveRestorePoint }) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const notChecked = point.verify?.notChecked;
  if (notChecked?.gaveUpAt) {
    // The check never ran: attention, neither failed nor passed; restic's words underneath.
    return (
      <div className="max-w-80 space-y-1" data-slot="pve-point-verify-not-checked">
        <Badge variant="warning">
          {notChecked.reason === "locked"
            ? t("guest.verifyNotCheckedLocked")
            : t("guest.verifyNotCheckedInterrupted")}
        </Badge>
        {notChecked.detail ? (
          <DetailHover text={notChecked.detail} tone="warning">
            <span className="line-clamp-2 text-xs break-words text-muted-foreground">
              {notChecked.detail}
            </span>
          </DetailHover>
        ) : null}
      </div>
    );
  }
  // Still tried again: the earlier result (if any) stands, with a note why the new check waits.
  const postponedBadge = notChecked ? (
    <Badge variant="muted" data-slot="pve-point-verify-postponed">
      {notChecked.reason === "locked"
        ? t("guest.verifyPostponedLocked")
        : t("guest.verifyPostponedInterrupted")}
    </Badge>
  ) : null;
  const postponed =
    postponedBadge && notChecked?.detail ? (
      <DetailHover text={notChecked.detail}>{postponedBadge}</DetailHover>
    ) : (
      postponedBadge
    );
  if (!point.verify || typeof point.verify.checkedAt !== "string") {
    return (
      postponed ?? (
        <Badge variant="muted">
          {point.verifyRequested ? t("guest.verifyQueuedBadge") : t("guest.verifyPending")}
        </Badge>
      )
    );
  }
  if (point.verify.errors.length > 0 || point.verify.mismatched > 0) {
    // The real error under the badge (cut to two lines; all of it, copyable, on hover).
    const errors = point.verify.errors.join("\n");
    return (
      <div className="max-w-80 space-y-1" data-slot="pve-point-verify-failed">
        <Badge variant="destructive">{t("guest.verifyFailed")}</Badge>
        {point.verify.errors[0] ? (
          <DetailHover text={errors} tone="destructive">
            <span className="line-clamp-2 text-xs break-words text-destructive-text">
              {point.verify.errors[0]}
            </span>
          </DetailHover>
        ) : null}
      </div>
    );
  }
  const passed = (
    <Badge variant="success">{t("guest.verifyOk", { blocks: point.verify.blocks })}</Badge>
  );
  return postponed ? (
    <div className="flex flex-wrap gap-1">
      {passed}
      {postponed}
    </div>
  ) : (
    passed
  );
}

/**
 * How a restore point came about (first backup, incremental, VM disks read in
 * full), what the VM read per disk, and what a container backup could not read.
 */
function PointType({ point }: { point: PveRestorePoint }) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const type =
    point.backupType ??
    (point.kind === "vm" && point.disks.some((d) => d.bitmapMode !== "reuse")
      ? "full_read"
      : "incremental");
  const disks =
    point.kind === "vm"
      ? point.disks.map((d) => `${d.device}: ${t(`guest.bitmap.${d.bitmapMode}`)}`).join("\n")
      : undefined;
  const unreadable = point.unreadable ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-1" data-slot="pve-point-type">
      <Badge variant={type === "incremental" ? "outline" : "info"} title={disks}>
        {t(`guest.backupType.${type}`)}
      </Badge>
      {unreadable > 0 ? (
        <Badge
          variant="warning"
          title={point.stats?.unreadablePaths?.join("\n") || point.consistency || undefined}
        >
          {t("guest.unreadable", { count: unreadable })}
        </Badge>
      ) : null}
    </div>
  );
}

/** How many unreadable items a run names in its row before "and N more". */
const SHOWN_UNREADABLE = 3;

/**
 * The status of a run. A backup that succeeded although restic could not read
 * some items is amber with how many; a running backup shows its progress.
 */
function RunStatus({ run, name }: { run: PveRun; name: string }) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const unreadable = run.stats?.resticUnreadable ?? 0;
  const warnings = run.warnings ?? [];
  if (run.status === "succeeded" && run.kind === "backup" && warnings.length > 0) {
    // Committed, and vzdump warned about something beside it: neither failed nor proof.
    return (
      <Badge variant="warning" title={warnings.join("\n")} data-slot="pve-run-warnings">
        {t("guests.succeededWithWarnings")}
      </Badge>
    );
  }
  if (run.status === "succeeded" && unreadable > 0) {
    return (
      <Badge variant="warning" data-slot="pve-run-gaps">
        {t("guest.succeededWithGaps", { count: unreadable })}
      </Badge>
    );
  }
  if (run.status === "cancelled") {
    return <CancelledBadge by={run.cancelledBy} />;
  }
  return (
    <div className="space-y-1.5">
      {run.status === "running" && run.cancelRequestedAt ? (
        <CancellingBadge by={run.cancelledBy} />
      ) : (
        <Badge variant={runTone(run)}>{t(runStatusKey(run))}</Badge>
      )}
      {run.status === "running" && run.kind === "backup" ? (
        <BackupProgress progress={run.progress} name={name} node={run.node} />
      ) : null}
    </div>
  );
}

/**
 * What went wrong, or what a backup with gaps misses: its first unreadable
 * items when the node named them, else restic's one-line remark.
 */
function RunNote({ run }: { run: PveRun }) {
  const { t } = useTranslation(PVE_NAMESPACE);
  if (run.error) {
    return <span title={run.error}>{run.error}</span>;
  }
  if (run.warnings && run.warnings.length > 0) {
    return <span title={run.warnings.join("\n")}>{run.warnings[0]}</span>;
  }
  const paths = run.stats?.unreadablePaths ?? [];
  if (paths.length > 0) {
    const more =
      (run.stats?.resticUnreadable ?? paths.length) - Math.min(paths.length, SHOWN_UNREADABLE);
    return (
      <span title={paths.join("\n")} data-slot="pve-run-unreadable">
        {t("guest.unreadablePaths", { paths: paths.slice(0, SHOWN_UNREADABLE).join(", ") })}
        {more > 0 ? ` ${t("guest.unreadableMore", { count: more })}` : null}
      </span>
    );
  }
  const remark = run.stats?.consistency ?? "";
  return remark ? <span title={remark}>{remark}</span> : null;
}

/** What a follow-up backup of this guest adds on average, over its newest restore points (#58). */
export function FollowUpNote({ followUp }: { followUp: PveFollowUpAverage }) {
  const { t, i18n } = useTranslation(PVE_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  return (
    <p className="text-sm text-muted-foreground tabular-nums" data-slot="pve-follow-up">
      {t("guest.followUp", { size: formatBytes(followUp.added, language), count: followUp.points })}
    </p>
  );
}

/** Where the repository of a chain was looked for, in a sentence. */
function chainTarget(
  chain: PveRepositoryChain,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!chain.target) {
    return t("guest.chain.unknownTarget");
  }
  if (chain.target.installationDefault) {
    return t("guest.chain.installationDefault");
  }
  return chain.target.location
    ? `${chain.target.name} (${chain.target.location})`
    : chain.target.name;
}

/**
 * The newest new backup chain of a container (docs/PVE.md, "New backup chain"): the repository
 * was missing on the primary when a backup began, or an administrator reset it.
 */
export function RepositoryChainNotice({ chain }: { chain: PveRepositoryChain }) {
  const { t, i18n } = useTranslation(PVE_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const date = formatDateTime(chain.at, language);
  const target = chainTarget(chain, t);
  return (
    <Alert
      variant={chain.reason === "missing" ? "warning" : "info"}
      data-slot="pve-repository-chain"
    >
      <History />
      <AlertTitle>
        {t(chain.reason === "missing" ? "guest.chain.missingTitle" : "guest.chain.resetTitle", {
          date,
        })}
      </AlertTitle>
      <AlertDescription>
        {chain.reason === "missing"
          ? t("guest.chain.missing", { target, count: chain.unavailablePoints })
          : t("guest.chain.reset", {
              target,
              count: chain.unavailablePoints,
              actor: chain.actor ?? t("guest.chain.someone"),
            })}
      </AlertDescription>
    </Alert>
  );
}

/** "Back up now" with where the backup lands (and a warning when that is the server's disk). */
function BackupNowDialog({
  guest,
  name,
  onClose,
}: {
  guest: PveGuest;
  name: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  // The Restow server's own VM asks first (self-backup.tsx); the request then carries the confirmation.
  const selfBackup = useSelfBackupGuard();
  const mutation = useMutation({
    mutationFn: (confirmSelfBackup: boolean) => backupNow(guest.id, false, { confirmSelfBackup }),
    onSuccess: (result) => {
      toast.success(t(result.alreadyQueued ? "guests.backupAlreadyQueued" : "guests.backupQueued"));
      void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent data-slot="pve-backup-now-dialog">
        <DialogHeader>
          <DialogTitle>{t("guest.backupConfirm.title", { name })}</DialogTitle>
          <DialogDescription>{t("guest.backupConfirm.description")}</DialogDescription>
        </DialogHeader>
        <BackupDestinationNote />
        <ServerDiskWarning />
        <RestowServerNote guest={guest} compact />
        {mutation.isError ? (
          <p className="text-sm text-destructive-text">{(mutation.error as Error).message}</p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            onClick={() =>
              selfBackup.guard([guest], (confirmSelfBackup) => mutation.mutate(confirmSelfBackup))
            }
            disabled={mutation.isPending}
          >
            {t("guest.backupConfirm.submit")}
          </Button>
        </DialogFooter>
        {selfBackup.dialog}
      </DialogContent>
    </Dialog>
  );
}

/** Reset a container's repository: the guest's name typed, a recent sign-in (step-up). */
function ResetRepositoryDialog({
  guestId,
  name,
  points,
  onClose,
}: {
  guestId: string;
  name: string;
  points: number;
  onClose: () => void;
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  const identity = useConfirmIdentity();
  const [typed, setTyped] = React.useState("");
  const mutation = useMutation({
    mutationFn: () => resetRepository(guestId, typed),
    onSuccess: () => {
      toast.success(t("guest.danger.done"));
      void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) });
      onClose();
    },
  });
  const submit = () =>
    mutation.mutate(undefined, {
      onError: (error) => {
        if (isRecentSignInRequired(error)) {
          identity.ask(submit);
        }
      },
    });
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent data-slot="pve-reset-repository-dialog">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("guest.danger.dialogTitle", { name })}</DialogTitle>
            <DialogDescription>
              {t("guest.danger.dialogDescription", { count: points })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="pve-reset-confirm">{t("guest.danger.typeName", { name })}</Label>
            <Input
              id="pve-reset-confirm"
              value={typed}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          {mutation.isError && !isRecentSignInRequired(mutation.error) ? (
            <p className="text-sm text-destructive-text">
              {(mutation.error as Error).message || t("guest.danger.failed")}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("guest.danger.cancel")}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={typed.trim() !== name || mutation.isPending}
              data-action="confirm-reset"
            >
              {t("guest.danger.confirm")}
            </Button>
          </DialogFooter>
        </form>
        {identity.dialog}
      </DialogContent>
    </Dialog>
  );
}

/** A row of the guest's history: a run, or the beginning of a new backup chain. */
type HistoryRow =
  | { type: "run"; at: string; run: PveRun }
  | { type: "chain"; at: string; chain: PveRepositoryChain };

export function historyRows(
  runs: readonly PveRun[],
  chains: readonly PveRepositoryChain[],
): HistoryRow[] {
  return [
    ...runs.map((run): HistoryRow => ({ type: "run", at: run.startedAt, run })),
    ...chains.map((chain): HistoryRow => ({ type: "chain", at: chain.at, chain })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * The Restow server's own VM (docs/PVE.md): the warning when Restow found it or an admin marked
 * it, and the mark itself, for what the SMBIOS UUID cannot find (Restow in a container).
 */
function RestowServerSection({ guest }: { guest: PveGuest }) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  const flag = useMutation({
    mutationFn: (flagged: boolean) => setRestowServer(guest.id, flagged),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) }),
    onError: (error) => toast.error((error as Error).message),
  });
  return (
    <div className="space-y-2" data-slot="pve-guest-restow-server">
      <RestowServerNote guest={guest} />
      {guest.restowServer === "detected" ? null : (
        <label className="flex max-w-prose items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={guest.restowServerFlagged ?? false}
            disabled={flag.isPending}
            onChange={(e) => flag.mutate(e.target.checked)}
          />
          <span>
            {t("selfBackup.flag")}
            <span className="block text-xs text-muted-foreground">{t("selfBackup.flagHint")}</span>
          </span>
        </label>
      )}
    </div>
  );
}

export function PveGuestPage({ guestId }: { guestId: string }) {
  const { t, i18n } = useTranslation(PVE_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const { tenantId, enabled } = useTenantScope();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: pveKeys.guest(tenantId, guestId),
    queryFn: () => fetchGuest(guestId),
    enabled,
    refetchInterval: (query) => guestRefreshMs(query.state.data),
  });
  const [restoring, setRestoring] = React.useState<PveRestorePoint | null>(null);
  const [backingUp, setBackingUp] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  // Backing up and resetting are for administrators (the API refuses everyone else).
  const { canManage } = useStorageScope();
  const verify = useMutation({
    mutationFn: (id: string) => verifySnapshot(id),
    onSuccess: () => {
      toast.success(t("guest.verifyQueued"));
      void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) });
    },
  });
  const bootTest = useMutation({
    mutationFn: (id: string) => requestBootTest(id),
    onSuccess: (result) => {
      toast.success(t(result.alreadyQueued ? "guest.bootTestAlready" : "guest.bootTestQueued"));
      void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) });
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const data = detail.data;
  const title = data ? `${data.guest.name ?? data.guest.vmid} (${data.guest.vmid})` : "";
  // What can be stopped (0.4.2): the running backup, else a backup that waits for the node.
  const runningBackup = data?.runs.find((r) => r.kind === "backup" && r.status === "running");
  const queuedBackups = (data?.tasks ?? []).filter((task) => task.kind === "backup");
  const stoppable = runningBackup
    ? {
        activity: "running" as const,
        cancelling: Boolean(runningBackup.cancelRequestedAt),
        by: runningBackup.cancelledBy ?? null,
      }
    : queuedBackups.length > 0
      ? {
          activity: "queued" as const,
          cancelling: queuedBackups.every((task) => task.cancelRequestedAt),
          by: queuedBackups[0]?.cancelledBy ?? null,
        }
      : null;
  // Signs of ransomware in the guest's restore points (docs/RANSOMWARE.md).
  const suspicionTarget = React.useMemo(
    () => ({ kind: "pve_guest" as const, objectId: guestId }),
    [guestId],
  );
  const suspicions = useObjectSuspicions(suspicionTarget);
  const judgements = React.useMemo(
    () => judgementsById(suspicions.data?.restorePoints),
    [suspicions.data],
  );
  const timeline = React.useMemo(
    () =>
      (data?.snapshots ?? [])
        .filter((point) => point.available !== false)
        .map((point) => ({ ...point, time: point.backupAt })),
    [data],
  );
  const chains = data?.repository?.chains ?? [];
  const history = React.useMemo(
    () => historyRows(data?.runs ?? [], data?.repository?.chains ?? []),
    [data],
  );
  const guestName = data ? (data.guest.name ?? String(data.guest.vmid)) : "";
  const availablePoints = (data?.snapshots ?? []).filter((p) => p.available !== false).length;
  return (
    <div className="space-y-6">
      <Link
        {...pveTo()}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t("guest.back")}
      </Link>
      <PageHeader
        title={title}
        description={
          data
            ? [
                t(`guests.${data.guest.kind}`),
                data.cluster?.name ?? "",
                data.guest.node ?? "",
                data.guest.diskBytes > 0
                  ? t("guest.diskAllocated", { size: formatBytes(data.guest.diskBytes, language) })
                  : "",
              ]
                .filter(Boolean)
                .join(" · ")
            : undefined
        }
      >
        <RefreshButton onRefresh={() => void detail.refetch()} fetching={detail.isFetching} />
        {data && stoppable ? (
          // A backup runs or waits: it can be stopped (a second one would only queue).
          <CancelBackupButton
            guestId={data.guest.id}
            name={title}
            activity={stoppable.activity}
            cancelling={stoppable.cancelling}
            cancelledBy={stoppable.by}
          />
        ) : data && canManage && !(data.guest.kind === "vm" && data.guest.template) ? (
          <Button type="button" onClick={() => setBackingUp(true)} data-action="backup-now">
            <Play aria-hidden="true" />
            {t("guest.backupNow")}
          </Button>
        ) : null}
      </PageHeader>
      {data && canManage ? <BackupDestinationNote /> : null}
      {chains[0] ? <RepositoryChainNotice chain={chains[0]} /> : null}
      {data ? <RestowServerSection guest={data.guest} /> : null}
      <ObjectSuspicionBadge target={suspicionTarget} />
      <RetentionHoldNotice target={suspicionTarget} objectName={title} />
      <LastCleanHint
        points={timeline}
        judgements={judgements}
        onPick={(point) => setRestoring(point)}
      />
      {detail.isError ? (
        <p className="text-sm text-destructive-text">{t("page.loadError")}</p>
      ) : null}

      <section className="space-y-2" aria-labelledby="pve-points">
        <h2 id="pve-points" className="text-lg font-semibold">
          {t("guest.restorePoints")}
        </h2>
        {data?.followUp ? <FollowUpNote followUp={data.followUp} /> : null}
        {data?.bootTest ? <BootTestFacts facts={data.bootTest} /> : null}
        {data && data.snapshots.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("guest.noRestorePoints")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("guest.time")}</TableHead>
                <TableHead>{t("guest.type")}</TableHead>
                <TableHead title={t("guest.sizeHint")}>{t("guest.size")}</TableHead>
                <TableHead title={t("guest.addedHint")}>{t("guest.added")}</TableHead>
                <TableHead>{t("guest.verify")}</TableHead>
                {data?.bootTest ? <TableHead>{t("guest.bootTest")}</TableHead> : null}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.snapshots ?? []).map((p) => (
                <TableRow key={p.id} data-slot="pve-restore-point">
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      {formatDateTime(p.backupAt, language)}
                      <SuspicionBadge judgement={judgements.get(p.id)} objectName={title} />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t(`guest.origin.${p.origin}`)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <PointType point={p} />
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {formatBytes(p.byteSize, language)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {p.added === null || p.added === undefined
                      ? "–"
                      : formatBytes(p.added, language)}
                  </TableCell>
                  <TableCell>
                    {p.available === false ? (
                      <Badge
                        variant="muted"
                        title={t("guest.unavailableHint")}
                        data-slot="pve-point-unavailable"
                      >
                        {t("guest.unavailable")}
                      </Badge>
                    ) : (
                      <VerifyBadge point={p} />
                    )}
                  </TableCell>
                  {data?.bootTest ? (
                    <TableCell>
                      <BootTestBadge test={p.bootTest} kind={p.kind} />
                    </TableCell>
                  ) : null}
                  <TableCell className="space-x-1 text-right">
                    {p.available === false ? null : (
                      <>
                        {data && (p.browsable ?? p.kind === "ct") ? (
                          // A container's files, one by one (#62): File restore with it chosen.
                          <Link
                            {...fileRestoreLink(data.guest.id)}
                            className={buttonVariants({ size: "sm", variant: "ghost" })}
                          >
                            {t("guest.browseFiles")}
                          </Link>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => verify.mutate(p.id)}
                        >
                          {t("guest.verifyNow")}
                        </Button>
                        {data?.bootTest && data.bootTest.blocker === null ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={bootTest.isPending}
                            onClick={() => bootTest.mutate(p.id)}
                          >
                            {t("guest.bootTestNow")}
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setRestoring(p)}
                        >
                          {t("guest.restore")}
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="pve-runs">
        <h2 id="pve-runs" className="text-lg font-semibold">
          {t("guest.runs")}
        </h2>
        {data && history.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("guest.noRuns")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("guest.started")}</TableHead>
                <TableHead>{t("guest.kindLabel")}</TableHead>
                <TableHead>{t("guest.status")}</TableHead>
                <TableHead>{t("guest.error")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((row) =>
                row.type === "chain" ? (
                  <TableRow key={`chain-${row.at}`} data-slot="pve-history-chain">
                    <TableCell>
                      <RelativeTime value={row.at} />
                    </TableCell>
                    <TableCell>{t("guest.chain.history")}</TableCell>
                    <TableCell>
                      <Badge variant={row.chain.reason === "missing" ? "warning" : "info"}>
                        {t(
                          row.chain.reason === "missing"
                            ? "guest.chain.historyMissing"
                            : "guest.chain.historyReset",
                          {
                            target: chainTarget(row.chain, t),
                            actor: row.chain.actor ?? t("guest.chain.someone"),
                          },
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-md text-xs">
                      {row.chain.unavailablePoints > 0
                        ? `${row.chain.unavailablePoints} × ${t("guest.unavailable")}`
                        : null}
                    </TableCell>
                  </TableRow>
                ) : (
                  <TableRow key={row.run.id}>
                    <TableCell>
                      <RelativeTime value={row.run.startedAt} />
                    </TableCell>
                    <TableCell>{t(`guest.kind.${row.run.kind}`)}</TableCell>
                    <TableCell>
                      <RunStatus run={row.run} name={title} />
                    </TableCell>
                    <TableCell className="max-w-md truncate text-xs">
                      <RunNote run={row.run} />
                    </TableCell>
                  </TableRow>
                ),
              )}
            </TableBody>
          </Table>
        )}
      </section>
      {data && canManage && data.guest.kind === "ct" ? (
        <Card className="border-destructive/30" data-slot="danger-zone">
          <CardHeader>
            <CardTitle className="text-base text-destructive-text">
              {t("guest.danger.title")}
            </CardTitle>
            <CardDescription>{t("guest.danger.resetTitle")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-xl text-sm text-muted-foreground">
              {t("guest.danger.resetDescription")}
            </p>
            <Button
              type="button"
              variant="destructive"
              className="shrink-0"
              onClick={() => setResetting(true)}
              data-action="reset-repository"
            >
              <RotateCcw aria-hidden="true" />
              {t("guest.danger.reset")}
            </Button>
          </CardContent>
        </Card>
      ) : null}
      {restoring && data ? (
        <RestoreDialog point={restoring} detail={data} onClose={() => setRestoring(null)} />
      ) : null}
      {backingUp && data ? (
        <BackupNowDialog guest={data.guest} name={guestName} onClose={() => setBackingUp(false)} />
      ) : null}
      {resetting && data ? (
        <ResetRepositoryDialog
          guestId={data.guest.id}
          name={guestName}
          points={availablePoints}
          onClose={() => setResetting(false)}
        />
      ) : null}
    </div>
  );
}
