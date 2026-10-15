import { Link } from "@tanstack/react-router";
import { ArrowLeft, Network, PlayCircle, PlugZap } from "lucide-react";

import { ErrorState, PageHeader, StatusBadge } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api";

import { OverviewTab } from "./components/overview-tab.js";
import { RunsTab } from "./components/runs-tab.js";
import { SettingsTab } from "./components/settings-tab.js";
import { ShareRestorePoints } from "./components/share-restore-points.js";
import { useBackupNow, useShare, useShareFormat, useTestStoredShare } from "./hooks.js";
import { SHARE_TABS, type ShareTab, fileSharesTo, linkTo } from "./paths.js";
import { readinessView, shareErrorKey, standingView } from "./presenters.js";

export interface ShareDetailPageProps {
  shareId: string;
  tab: ShareTab;
  onTabChange: (tab: ShareTab) => void;
}

/**
 * One file share (docs/FILESHARES.md 12.3): overview (how it stands, the run in progress, the
 * repository against its budget, the connection), its restore points with the file browser,
 * search and restore, its runs with the per-file items, and its settings (connection, password,
 * permissions, "Allow restore to this share", private-network approval, job and folders,
 * budget, copy jobs, repository password, retire and delete).
 */
export function ShareDetailPage({ shareId, tab, onTabChange }: ShareDetailPageProps) {
  const format = useShareFormat();
  const { t } = format;
  const query = useShare(shareId);
  const backup = useBackupNow(shareId);
  const test = useTestStoredShare(shareId);

  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <ErrorState
        title={missing ? t("detail.notFound") : t("detail.loadError")}
        error={query.error}
        onRetry={missing ? undefined : () => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  if (!query.data) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-12 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  const share = query.data;
  const standing = standingView(share.standing);
  const readiness = readinessView(share.readiness.state);
  const retired = share.retiredAt !== null;

  const backUp = (allowEmptyOnce = false) =>
    backup.mutate(allowEmptyOnce, {
      onSuccess: (result) =>
        toast.success(
          result.alreadyQueued
            ? t("detail.backupWaiting", { name: share.name })
            : t("detail.backupQueued", { name: share.name }),
        ),
      onError: (error) => toast.error(t(shareErrorKey(error))),
    });

  return (
    <div className="space-y-5" data-slot="file-share-detail" data-share={share.id}>
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link {...linkTo(fileSharesTo())}>
          <ArrowLeft aria-hidden="true" />
          {t("detail.back")}
        </Link>
      </Button>
      <PageHeader
        icon={Network}
        title={share.name}
        description={share.location}
        actions={
          <>
            <Button
              variant="outline"
              onClick={() =>
                test.mutate(undefined, {
                  onSuccess: (result) =>
                    result.ok
                      ? toast.success(t("detail.testOk"))
                      : toast.error(t("detail.testFailed")),
                  onError: (error) => toast.error(t(shareErrorKey(error))),
                })
              }
              loading={test.isPending}
              data-action="test-share"
            >
              <PlugZap aria-hidden="true" />
              {t("detail.test")}
            </Button>
            <Button
              onClick={() => backUp(false)}
              loading={backup.isPending}
              disabled={retired}
              data-action="backup-now"
            >
              <PlayCircle aria-hidden="true" />
              {t("detail.backupNow")}
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={standing.tone} icon>
          {t(standing.key)}
        </StatusBadge>
        <StatusBadge tone={readiness.tone} icon>
          {t(readiness.key)}
        </StatusBadge>
        <StatusBadge tone="neutral">{t(`protocol.${share.protocol}`)}</StatusBadge>
        {share.protocol === "smb" && share.smbVersion === "2.1" ? (
          <StatusBadge tone="warning" icon>
            {t("detail.smb21")}
          </StatusBadge>
        ) : null}
        {share.allowRestore ? (
          <StatusBadge tone="info">{t("detail.restoreAllowed")}</StatusBadge>
        ) : null}
      </div>

      <Tabs value={tab} onValueChange={(next) => onTabChange(next as ShareTab)}>
        <TabsList aria-label={t("detail.tabs.label")}>
          {SHARE_TABS.map((id) => (
            <TabsTrigger key={id} value={id} data-tab={id}>
              {t(`detail.tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview" className="pt-4">
          <OverviewTab
            share={share}
            onBackupEmptyOnce={() => backUp(true)}
            onShowRuns={() => onTabChange("runs")}
          />
        </TabsContent>
        <TabsContent value="restore-points" className="pt-4">
          {tab === "restore-points" ? (
            <ShareRestorePoints share={share} onShowRuns={() => onTabChange("runs")} />
          ) : null}
        </TabsContent>
        <TabsContent value="runs" className="pt-4">
          {tab === "runs" ? <RunsTab share={share} onBackupEmptyOnce={() => backUp(true)} /> : null}
        </TabsContent>
        <TabsContent value="settings" className="pt-4">
          {tab === "settings" ? <SettingsTab share={share} /> : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
