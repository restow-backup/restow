import { Link } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState, RelativeTime } from "@/components/kit";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BackupTarget } from "@/features/jobs/api";
import { ReadinessBadge, SnapshotStateBadge } from "@/features/jobs/components/status";
import { jobDetailTo } from "@/features/jobs/paths";
import { objectLabel } from "@/features/jobs/presenters";
import { useJobFormat } from "@/features/jobs/use-format";
import { useSnapshotHistory } from "@/features/jobs/use-jobs";
import { SnapshotVerificationBadge } from "@/features/verify/components/snapshot-verification-badge";

/**
 * The points in time of one object: state, verification, size and the job
 * that wrote each. Every restorable snapshot carries its own verification, so
 * a backup taken after a successful check reads "Not verified yet".
 */
export function SnapshotHistoryDialog({
  target,
  onOpenChange,
}: {
  target: BackupTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("backup");
  const { t: tv } = useTranslation("verify");
  const format = useJobFormat();
  const [includePruned, setIncludePruned] = React.useState(false);
  const history = useSnapshotHistory(target?.id ?? null, includePruned);
  const name = target ? objectLabel(target) : "";

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("snapshots.title")}</DialogTitle>
          <DialogDescription>{t("snapshots.description", { name })}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <ReadinessBadge verify={history.data?.latestVerify ?? target?.latestVerify ?? null} />
          <div className="flex items-center gap-2">
            <Checkbox
              id="snapshots-include-pruned"
              checked={includePruned}
              onCheckedChange={(value) => setIncludePruned(value === true)}
            />
            <Label htmlFor="snapshots-include-pruned" className="text-sm font-normal">
              {t("snapshots.includePruned")}
            </Label>
          </div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {history.isPending ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : history.isError ? (
            <ErrorState
              title={t("snapshots.loadError")}
              error={history.error}
              onRetry={() => void history.refetch()}
              retrying={history.isFetching}
            />
          ) : history.data.snapshots.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("snapshots.empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">{t("snapshots.columns.sequence")}</TableHead>
                  <TableHead>{t("snapshots.columns.state")}</TableHead>
                  <TableHead>{tv("snapshot.column")}</TableHead>
                  <TableHead>{t("snapshots.columns.completed")}</TableHead>
                  <TableHead className="text-right">{t("snapshots.columns.items")}</TableHead>
                  <TableHead className="text-right">{t("snapshots.columns.size")}</TableHead>
                  <TableHead className="text-right">{t("snapshots.columns.job")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.data.snapshots.map((snapshot) => (
                  <TableRow key={snapshot.id}>
                    <TableCell className="tabular-nums">
                      {format.integer(snapshot.sequence)}
                    </TableCell>
                    <TableCell>
                      <SnapshotStateBadge state={snapshot.state} />
                    </TableCell>
                    <TableCell>
                      {snapshot.verification ? (
                        <SnapshotVerificationBadge verification={snapshot.verification} />
                      ) : (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <RelativeTime value={snapshot.completedAt} fallback="–" focusable={false} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {format.integer(snapshot.itemCount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {format.bytes(snapshot.byteSize)}
                    </TableCell>
                    <TableCell className="text-right">
                      {snapshot.jobId ? (
                        <Link
                          to={jobDetailTo(snapshot.jobId)}
                          className="text-sm text-primary underline-offset-4 hover:underline"
                          onClick={() => onOpenChange(false)}
                        >
                          {t("actions.openJob")}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
