import { Link } from "@tanstack/react-router";
import { Building2, FolderPlus, ListChecks, Network, Repeat } from "lucide-react";
import * as React from "react";

import { EmptyState, ErrorState, PageHeader, RefreshButton, StatusBadge } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSession } from "@/lib/session";

import type { FileShareSummary } from "./api.js";
import { AddShareDialog } from "./components/add-share-dialog.js";
import { MounterNotice } from "./components/mounter-notice.js";
import { type ShareFormat, useShareFormat, useShareSettings, useShares } from "./hooks.js";
import { fileShareTo, linkTo } from "./paths.js";
import { progressRatio, readinessView, standingView } from "./presenters.js";

/** The jobs of file shares and their copies, on the backup jobs page (12.1). */
function jobsLink(kind: "share" | "copy") {
  return { to: "/jobs" as never, search: { type: kind } as never };
}

export interface SharesPageProps {
  /** The add dialog is open (`?add=1`). */
  adding: boolean;
  onAddChange: (open: boolean) => void;
}

/**
 * The file shares of the tenant (docs/FILESHARES.md 12): each with how it stands, its restore
 * check, the last backup, its job and a running run's progress; "Add file share" opens the add
 * dialog. Retired shares (backups kept) are behind a switch.
 */
export function SharesPage({ adding, onAddChange }: SharesPageProps) {
  const format = useShareFormat();
  const { t } = format;
  const { activeTenant } = useSession();
  const shares = useShares();
  const settings = useShareSettings();
  const [showRetired, setShowRetired] = React.useState(false);

  const header = (
    <PageHeader
      icon={Network}
      title={t("list.title")}
      description={t("list.description")}
      actions={
        activeTenant ? (
          <>
            <RefreshButton
              label={t("list.refresh")}
              fetching={shares.isFetching}
              onRefresh={() => void shares.refetch()}
            />
            <Button variant="outline" asChild>
              <Link {...jobsLink("share")}>
                <ListChecks aria-hidden="true" />
                {t("list.jobs")}
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link {...jobsLink("copy")}>
                <Repeat aria-hidden="true" />
                {t("list.copyJobs")}
              </Link>
            </Button>
            <Button onClick={() => onAddChange(true)} data-action="add-share">
              <FolderPlus aria-hidden="true" />
              {t("list.add")}
            </Button>
          </>
        ) : null
      }
    />
  );

  if (activeTenant === null) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          icon={Building2}
          title={t("list.noTenant.title")}
          description={t("list.noTenant.description")}
        />
      </div>
    );
  }

  const all = shares.data?.items ?? [];
  const retired = all.filter((share) => share.retiredAt !== null);
  const shown = showRetired ? all : all.filter((share) => share.retiredAt === null);

  return (
    <div className="space-y-6" data-slot="file-shares-page">
      {header}
      {settings.data ? <MounterNotice settings={settings.data} /> : null}
      {shares.isError ? (
        <ErrorState
          title={t("list.loadError")}
          error={shares.error}
          onRetry={() => void shares.refetch()}
          retrying={shares.isFetching}
        />
      ) : shares.isPending ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : all.length === 0 ? (
        <EmptyState
          icon={Network}
          title={t("list.empty.title")}
          description={t("list.empty.description")}
          actions={
            <Button onClick={() => onAddChange(true)}>
              <FolderPlus aria-hidden="true" />
              {t("list.add")}
            </Button>
          }
        />
      ) : (
        <>
          <Counts format={format} counts={shares.data.counts} />
          <Card className="py-0">
            <CardContent className="p-0">
              <SharesTable shares={shown} format={format} />
            </CardContent>
          </Card>
          {retired.length > 0 ? (
            <div className="flex items-center gap-2">
              <Switch
                id="show-retired"
                checked={showRetired}
                onCheckedChange={(checked) => setShowRetired(checked === true)}
              />
              <Label htmlFor="show-retired">
                {t("list.showRetired", { count: retired.length })}
              </Label>
            </div>
          ) : null}
        </>
      )}
      <AddShareDialog open={adding} onOpenChange={onAddChange} />
    </div>
  );
}

function Counts({
  format,
  counts,
}: {
  format: ShareFormat;
  counts: { total: number; protected: number; withoutJob: number; failed: number };
}) {
  const { t } = format;
  return (
    <p className="text-sm text-muted-foreground" data-slot="share-counts">
      {t("list.counts", {
        total: counts.total,
        protected: counts.protected,
        withoutJob: counts.withoutJob,
        failed: counts.failed,
      })}
    </p>
  );
}

function SharesTable({
  shares,
  format,
}: { shares: readonly FileShareSummary[]; format: ShareFormat }) {
  const { t } = format;
  return (
    <Table scrollLabel={t("list.title")}>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">{t("list.columns.name")}</TableHead>
          <TableHead>{t("list.columns.state")}</TableHead>
          <TableHead>{t("list.columns.readiness")}</TableHead>
          <TableHead className="hidden md:table-cell">{t("list.columns.lastBackup")}</TableHead>
          <TableHead className="hidden lg:table-cell pr-4">{t("list.columns.job")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {shares.map((share) => {
          const standing = standingView(share.standing);
          const readiness = readinessView(share.readiness.state);
          const ratio = share.activeRun ? progressRatio(share.activeRun.progress) : null;
          return (
            <TableRow key={share.id} data-share={share.id}>
              <TableCell className="max-w-0 min-w-48 pl-4">
                <Link {...linkTo(fileShareTo(share.id))} className="font-medium hover:underline">
                  {share.name}
                </Link>
                <span
                  className="block truncate font-mono text-xs text-muted-foreground"
                  title={share.location}
                >
                  {share.location}
                </span>
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  <StatusBadge tone={standing.tone} icon>
                    {t(standing.key)}
                  </StatusBadge>
                  {share.activeRun ? (
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      {t(`runs.kind.${share.activeRun.kind}`)}
                      {ratio !== null ? (
                        <Progress
                          value={Math.round(ratio * 100)}
                          className="h-1.5 w-20"
                          aria-label={t("overview.progress")}
                        />
                      ) : null}
                    </span>
                  ) : null}
                  {share.credentialFailedAt ? (
                    <span className="text-xs text-destructive-text">
                      {t("list.passwordRefused")}
                    </span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>
                <StatusBadge tone={readiness.tone} icon>
                  {t(readiness.key)}
                </StatusBadge>
              </TableCell>
              <TableCell className="hidden whitespace-nowrap md:table-cell">
                {share.lastSuccessAt ? format.dateTime(share.lastSuccessAt) : t("list.never")}
              </TableCell>
              <TableCell className="hidden pr-4 lg:table-cell">
                {share.job ? (
                  share.job.name
                ) : (
                  <span className="text-muted-foreground">{t("list.noJob")}</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
