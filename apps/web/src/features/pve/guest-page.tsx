import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { PageHeader, RefreshButton, RelativeTime } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
import {
  judgementsById,
  LastCleanHint,
  ObjectSuspicionBadge,
  SuspicionBadge,
  useObjectSuspicions,
} from "@/features/suspicion";
import { formatBytes, formatDateTime } from "@/lib/format";

import {
  fetchGuest,
  guestRefreshMs,
  type PveFollowUpAverage,
  type PveGuestDetail,
  type PveRestorePoint,
  type PveRun,
  pveKeys,
  restoreSnapshot,
  verifySnapshot,
} from "./api.js";
import { BackupProgress } from "./backup-progress.js";
import { PVE_NAMESPACE } from "./i18n.js";
import { pveTo } from "./paths.js";

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
 * backup that completed is neutral, running work is informational.
 */
function runTone(run: {
  kind: string;
  status: string;
}): "success" | "outline" | "destructive" | "info" {
  if (run.status === "failed") {
    return "destructive";
  }
  if (run.status === "running") {
    return "info";
  }
  return run.kind === "backup" ? "outline" : "success";
}

function VerifyBadge({ point }: { point: PveRestorePoint }) {
  const { t } = useTranslation(PVE_NAMESPACE);
  if (!point.verify) {
    return <Badge variant="muted">{t("guest.verifyPending")}</Badge>;
  }
  if (point.verify.errors.length > 0 || point.verify.mismatched > 0) {
    return (
      <Badge variant="destructive" title={point.verify.errors.join("\n")}>
        {t("guest.verifyFailed")}
      </Badge>
    );
  }
  return <Badge variant="success">{t("guest.verifyOk", { blocks: point.verify.blocks })}</Badge>;
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
  if (run.status === "succeeded" && unreadable > 0) {
    return (
      <Badge variant="warning" data-slot="pve-run-gaps">
        {t("guest.succeededWithGaps", { count: unreadable })}
      </Badge>
    );
  }
  return (
    <div className="space-y-1.5">
      <Badge variant={runTone(run)}>{t(`guest.${run.status}`)}</Badge>
      {run.status === "running" && run.kind === "backup" ? (
        <BackupProgress progress={run.progress} name={name} />
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
  const verify = useMutation({
    mutationFn: (id: string) => verifySnapshot(id),
    onSuccess: () => {
      toast.success(t("guest.verifyQueued"));
      void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) });
    },
  });
  const data = detail.data;
  const title = data ? `${data.guest.name ?? data.guest.vmid} (${data.guest.vmid})` : "";
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
    () => (data?.snapshots ?? []).map((point) => ({ ...point, time: point.backupAt })),
    [data],
  );
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
      </PageHeader>
      <ObjectSuspicionBadge target={suspicionTarget} />
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
                    <VerifyBadge point={p} />
                  </TableCell>
                  <TableCell className="space-x-1 text-right">
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
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setRestoring(p)}
                    >
                      {t("guest.restore")}
                    </Button>
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
        {data && data.runs.length === 0 ? (
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
              {(data?.runs ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <RelativeTime value={r.startedAt} />
                  </TableCell>
                  <TableCell>{t(`guest.kind.${r.kind}`)}</TableCell>
                  <TableCell>
                    <RunStatus run={r} name={title} />
                  </TableCell>
                  <TableCell className="max-w-md truncate text-xs">
                    <RunNote run={r} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      {restoring && data ? (
        <RestoreDialog point={restoring} detail={data} onClose={() => setRestoring(null)} />
      ) : null}
    </div>
  );
}
