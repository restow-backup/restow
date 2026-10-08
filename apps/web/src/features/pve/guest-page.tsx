import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { PageHeader, RefreshButton, RelativeTime } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { formatBytes, formatDateTime } from "@/lib/format";

import {
  type PveGuestDetail,
  type PveRestorePoint,
  fetchGuest,
  pveKeys,
  restoreSnapshot,
  verifySnapshot,
} from "./api.js";
import { PVE_NAMESPACE } from "./i18n.js";
import { pveTo } from "./paths.js";

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
function runTone(run: { kind: string; status: string }):
  | "success"
  | "outline"
  | "destructive"
  | "info" {
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

export function PveGuestPage({ guestId }: { guestId: string }) {
  const { t, i18n } = useTranslation(PVE_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const { tenantId, enabled } = useTenantScope();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: pveKeys.guest(tenantId, guestId),
    queryFn: () => fetchGuest(guestId),
    enabled,
    refetchInterval: 15_000,
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
            ? `${t(`guests.${data.guest.kind}`)} · ${data.cluster?.name ?? ""} · ${data.guest.node ?? ""}`
            : undefined
        }
      >
        <RefreshButton onRefresh={() => void detail.refetch()} fetching={detail.isFetching} />
      </PageHeader>
      {detail.isError ? (
        <p className="text-sm text-destructive-text">{t("page.loadError")}</p>
      ) : null}

      <section className="space-y-2" aria-labelledby="pve-points">
        <h2 id="pve-points" className="text-lg font-semibold">
          {t("guest.restorePoints")}
        </h2>
        {data && data.snapshots.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("guest.noRestorePoints")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("guest.time")}</TableHead>
                <TableHead>{t("guest.size")}</TableHead>
                <TableHead>{t("guest.changed")}</TableHead>
                <TableHead>{t("guest.mode")}</TableHead>
                <TableHead>{t("guest.verify")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.snapshots ?? []).map((p) => (
                <TableRow key={p.id} data-slot="pve-restore-point">
                  <TableCell>
                    <div>{formatDateTime(p.backupAt, language)}</div>
                    <div className="text-xs text-muted-foreground">
                      {t(`guest.origin.${p.origin}`)}
                    </div>
                  </TableCell>
                  <TableCell>{formatBytes(p.byteSize, language)}</TableCell>
                  <TableCell>{p.disks.reduce((s, d) => s + d.changedBlocks, 0)}</TableCell>
                  <TableCell>
                    {p.disks.map((d) => (
                      <div key={d.device} className="text-xs">
                        {d.device}: {t(`guest.bitmap.${d.bitmapMode}`)}
                      </div>
                    ))}
                  </TableCell>
                  <TableCell>
                    <VerifyBadge point={p} />
                  </TableCell>
                  <TableCell className="space-x-1 text-right">
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
                    <Badge variant={runTone(r)}>{t(`guest.${r.status}`)}</Badge>
                  </TableCell>
                  <TableCell className="max-w-md truncate text-xs" title={r.error ?? undefined}>
                    {r.error ?? ""}
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
