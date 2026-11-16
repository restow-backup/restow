import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Wrench } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { RelativeTime } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { isRecentSignInRequired } from "@/lib/recent-sign-in";
import {
  fetchRepositoryRepairs,
  requestRepositoryRepair,
  requestRepositoryScan,
  storageKeys,
} from "../api";
import { storageErrorKey } from "../presenters";
import type {
  RepositoryClass,
  RepositoryHolding,
  RepositoryRepairEntry,
  RepositoryScanEntry,
} from "../types";
import { useStorageScope } from "../use-storage";

/** What the administrator types to repair (the API checks the same word). */
export const REPAIR_CONFIRMATION = "REPAIR";

/** Badge tones: "complete" is no proof of restorability (green is for proof only). */
const CLASS_TONE: Record<RepositoryClass, "outline" | "warning" | "destructive" | "muted"> = {
  ok: "outline",
  elsewhere: "warning",
  split: "warning",
  data_only: "destructive",
  password_only: "muted",
  missing: "destructive",
  conflict: "destructive",
};

/** Where the parts of a repository lie, in one line per target. */
export function holdingSummary(
  holding: RepositoryHolding,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const name =
    holding.target === "installation_default"
      ? t("repair.installationDefault")
      : holding.targetName;
  return t("repair.holding", {
    name,
    config: holding.config ? t("repair.yes") : t("repair.no"),
    keys: holding.keys,
    files: holding.files,
    snapshots: holding.snapshots,
  });
}

function ScanTable({ entries }: { entries: readonly RepositoryScanEntry[] }) {
  const { t } = useTranslation("storage");
  const shown = entries.filter((entry) => entry.class !== "ok");
  if (shown.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("repair.allOk", { count: entries.length })}
      </p>
    );
  }
  return (
    <Table data-slot="storage-repair-scan">
      <TableHeader>
        <TableRow>
          <TableHead>{t("repair.columns.repository")}</TableHead>
          <TableHead>{t("repair.columns.state")}</TableHead>
          <TableHead>{t("repair.columns.where")}</TableHead>
          <TableHead>{t("repair.columns.points")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {shown.map((entry) => (
          <TableRow key={entry.prefix} data-class={entry.class}>
            <TableCell>
              <span className="block font-medium">{entry.name ?? entry.ownerId}</span>
              <span className="block text-xs text-muted-foreground">
                {t(`repair.kind.${entry.kind}`)} · <code>{entry.prefix}</code>
              </span>
            </TableCell>
            <TableCell>
              <Badge variant={CLASS_TONE[entry.class]}>{t(`repair.class.${entry.class}`)}</Badge>
              <span className="mt-1 block max-w-xs text-xs text-muted-foreground">
                {t(`repair.classHint.${entry.class}`, { count: entry.filesToCopy })}
              </span>
            </TableCell>
            <TableCell className="text-xs">
              {entry.holdings.length === 0
                ? t("repair.nowhere")
                : entry.holdings.map((holding) => (
                    <span key={holding.target} className="block">
                      {holdingSummary(holding, t)}
                    </span>
                  ))}
            </TableCell>
            <TableCell>{entry.activePoints}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RepairTable({ entries }: { entries: readonly RepositoryRepairEntry[] }) {
  const { t } = useTranslation("storage");
  const shown = entries.filter((entry) => entry.outcome !== "unchanged" || entry.detail);
  if (shown.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("repair.nothingChanged")}</p>;
  }
  return (
    <Table data-slot="storage-repair-result">
      <TableHeader>
        <TableRow>
          <TableHead>{t("repair.columns.repository")}</TableHead>
          <TableHead>{t("repair.columns.outcome")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {shown.map((entry) => (
          <TableRow key={entry.prefix} data-outcome={entry.outcome}>
            <TableCell>
              <span className="block font-medium">{entry.name ?? entry.ownerId}</span>
              <span className="block text-xs text-muted-foreground">
                {t(`repair.kind.${entry.kind}`)}
              </span>
            </TableCell>
            <TableCell className="text-sm">
              {t(`repair.outcome.${entry.outcome}`, {
                copied: entry.copied,
                count: entry.lostPoints,
                movedTo: entry.movedTo ?? "",
              })}
              {entry.detail ? (
                <span className="block text-xs text-muted-foreground">{entry.detail}</span>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RepairDialog({ scanId, onClose }: { scanId: string; onClose: () => void }) {
  const { t } = useTranslation("storage");
  const queryClient = useQueryClient();
  const scope = useStorageScope();
  const identity = useConfirmIdentity();
  const [typed, setTyped] = React.useState("");
  const mutation = useMutation({
    mutationFn: () => requestRepositoryRepair(scanId, typed.trim()),
    onSuccess: () => {
      toast.success(t("repair.queued"));
      void queryClient.invalidateQueries({ queryKey: storageKeys.repairs(scope.tenantId) });
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
      <DialogContent data-slot="storage-repair-dialog">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("repair.dialogTitle")}</DialogTitle>
            <DialogDescription>{t("repair.dialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="storage-repair-confirm">
              {t("repair.typeWord", { word: REPAIR_CONFIRMATION })}
            </Label>
            <Input
              id="storage-repair-confirm"
              value={typed}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          {mutation.isError && !isRecentSignInRequired(mutation.error) ? (
            <p className="text-sm text-destructive-text">
              {storageErrorKey(mutation.error).startsWith("storage:")
                ? t(storageErrorKey(mutation.error))
                : (mutation.error as Error).message || t("repair.failed")}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("repair.cancel")}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={typed.trim() !== REPAIR_CONFIRMATION || mutation.isPending}
              data-action="confirm-repair"
            >
              {t("repair.confirm")}
            </Button>
          </DialogFooter>
        </form>
        {identity.dialog}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The repository repair (docs/STORAGE.md, "Repository repair"): a scan lists every restic
 * repository of the tenant on every storage target and says where its parts lie; the repair
 * rebuilds on the primary what the parts allow and marks what is lost.
 */
export function RepositoryRepairCard() {
  const { t } = useTranslation("storage");
  const scope = useStorageScope();
  const queryClient = useQueryClient();
  const [repairing, setRepairing] = React.useState(false);
  const query = useQuery({
    queryKey: storageKeys.repairs(scope.tenantId),
    queryFn: fetchRepositoryRepairs,
    enabled: scope.enabled,
    refetchInterval: (q) => {
      const data = q.state.data;
      const busy = [data?.scan?.status, data?.repair?.status].some(
        (status) => status === "queued" || status === "running",
      );
      return busy ? 3_000 : false;
    },
  });
  const scan = useMutation({
    mutationFn: requestRepositoryScan,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: storageKeys.repairs(scope.tenantId) });
    },
  });
  const data = query.data;
  const busy = [data?.scan?.status, data?.repair?.status].some(
    (status) => status === "queued" || status === "running",
  );
  const entries = data?.scan?.result?.repositories ?? [];
  const unreachable = data?.scan?.result?.unreachable ?? [];
  const actionable =
    unreachable.length === 0 &&
    entries.some((entry) => entry.class !== "ok" && entry.class !== "missing");
  return (
    <Card data-slot="storage-repository-repair">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wrench aria-hidden="true" className="size-4" />
          {t("repair.title")}
        </CardTitle>
        <CardDescription>{t("repair.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy || scan.isPending}
            onClick={() => scan.mutate()}
            data-action="scan-repositories"
          >
            {t("repair.scan")}
          </Button>
          {data?.scan?.status === "completed" && actionable ? (
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => setRepairing(true)}
              data-action="repair-repositories"
            >
              {t("repair.repair")}
            </Button>
          ) : null}
          {data?.scan ? (
            <span className="text-xs text-muted-foreground">
              {t(`repair.status.${data.scan.status}`)} ·{" "}
              <RelativeTime value={data.scan.finishedAt ?? data.scan.requestedAt} />
            </span>
          ) : null}
        </div>
        {data?.scan?.status === "failed" ? (
          <p className="text-sm text-destructive-text">{data.scan.errorMessage}</p>
        ) : null}
        {data?.scan?.status === "completed" && unreachable.length > 0 ? (
          <p className="text-sm text-destructive-text" data-slot="storage-repair-unreachable">
            {t("repair.unreachable", {
              names: unreachable
                .map((source) =>
                  source.id === "installation_default"
                    ? t("repair.installationDefault")
                    : source.name,
                )
                .join(", "),
            })}
          </p>
        ) : null}
        {data?.scan?.status === "completed" ? <ScanTable entries={entries} /> : null}
        {data?.repair ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">
              {t("repair.lastRepair")} · {t(`repair.status.${data.repair.status}`)}
            </p>
            {data.repair.status === "failed" ? (
              <p className="text-sm text-destructive-text">{data.repair.errorMessage}</p>
            ) : null}
            {data.repair.status === "completed" ? (
              <RepairTable entries={data.repair.result?.repositories ?? []} />
            ) : null}
          </div>
        ) : null}
      </CardContent>
      {repairing && data?.scan ? (
        <RepairDialog scanId={data.scan.id} onClose={() => setRepairing(false)} />
      ) : null}
    </Card>
  );
}
