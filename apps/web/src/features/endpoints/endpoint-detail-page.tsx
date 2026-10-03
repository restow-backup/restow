import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Camera,
  LayoutDashboard,
  Play,
  Settings,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState, PageHeader, RefreshButton } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api";

import type { EndpointDetail } from "./api.js";
import { AttentionArea } from "./components/attention-area.js";
import { OverviewTab } from "./components/overview-tab.js";
import { RunSheet } from "./components/run-sheet.js";
import { SettingsTab } from "./components/settings-tab.js";
import { SnapshotsTab } from "./components/snapshots-tab.js";
import {
  ActivityBadge,
  AttentionBadges,
  ConnectionBadge,
  OsLabel,
  ProfileBadge,
  ReadinessBadge,
} from "./components/status.js";
import { useCreateTask, useEndpoint, useRestoreTest } from "./hooks.js";
import { ENDPOINT_TABS, type EndpointTab, inventoryTo } from "./paths.js";
import { endpointErrorKey, endpointHostLine, endpointName, isWithoutBackup } from "./presenters.js";

const TAB_ICON: Record<EndpointTab, typeof Camera> = {
  overview: LayoutDashboard,
  snapshots: Camera,
  settings: Settings,
};

/** Back up now and the restore test: the two things an admin starts from here. */
function ActionButtons({ detail }: { detail: EndpointDetail }) {
  const { t } = useTranslation("endpoints");
  const backup = useCreateTask(detail.id);
  const test = useRestoreTest(detail.id);
  const revoked = detail.status === "revoked";
  const noBackup = detail.readiness.latestSnapshotId === null;
  // Backups run only in a backup job (release 0.2.1); the server refuses the request otherwise.
  const noJob = isWithoutBackup(detail);

  const runBackup = () =>
    backup.mutate(
      { kind: "backup_now" },
      {
        onSuccess: (result) => {
          if (result.alreadyQueued) {
            toast.info(t("actions.backup.already"));
          } else {
            toast.success(t("actions.backup.queued"), {
              description: t("actions.backup.queuedNote"),
            });
          }
        },
        onError: (error) =>
          toast.error(t("actions.backup.failed"), { description: t(endpointErrorKey(error)) }),
      },
    );

  const runTest = () =>
    test.mutate(undefined, {
      onSuccess: (result) => {
        if (result.queued) {
          toast.success(t("actions.test.queued"), {
            description: t("actions.test.queuedNote"),
          });
        } else {
          toast.info(t("actions.test.already"));
        }
      },
      onError: (error) =>
        toast.error(t("actions.test.failed"), { description: t(endpointErrorKey(error)) }),
    });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={runTest}
        loading={test.isPending}
        disabled={revoked || noBackup}
        title={noBackup && !revoked ? t("actions.test.needsBackup") : undefined}
      >
        {test.isPending ? null : <ShieldCheck aria-hidden="true" />}
        {t("actions.test.label")}
      </Button>
      <Button
        size="sm"
        onClick={runBackup}
        loading={backup.isPending}
        disabled={revoked || noJob}
        title={noJob ? t("actions.backup.needsJob") : undefined}
      >
        {backup.isPending ? null : <Play aria-hidden="true" />}
        {t("actions.backup.label")}
      </Button>
    </>
  );
}

/**
 * One machine: status, runs and reports on the overview, the restore points
 * with a file browser, and the settings. The tab is kept in the URL.
 */
export function EndpointDetailPage({
  endpointId,
  tab,
  onTabChange,
}: {
  endpointId: string;
  tab: EndpointTab;
  onTabChange: (tab: EndpointTab) => void;
}) {
  const { t } = useTranslation("endpoints");
  const query = useEndpoint(endpointId);
  const [openRun, setOpenRun] = React.useState<string | null>(null);

  const back = (
    <Link to={inventoryTo()} className={buttonVariants({ variant: "outline", size: "sm" })}>
      <ArrowLeft aria-hidden="true" />
      {t("detail.back")}
    </Link>
  );

  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="space-y-6">
        <PageHeader title={t("detail.title")} actions={back} />
        <ErrorState
          title={missing ? t("detail.notFound") : t("detail.loadError")}
          description={missing ? t("detail.notFoundDescription") : undefined}
          error={query.error}
          onRetry={missing ? undefined : () => void query.refetch()}
          retrying={query.isFetching}
        />
      </div>
    );
  }
  if (!query.data) {
    return (
      <div className="space-y-6" aria-busy="true">
        <PageHeader title={t("detail.title")} actions={back} />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-10 w-72" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-64 lg:col-span-2" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  const detail = query.data;
  const hostLine = endpointHostLine(detail);
  return (
    <div className="space-y-5">
      <PageHeader
        title={endpointName(detail)}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {hostLine ? <span className="font-mono text-xs">{hostLine}</span> : null}
            <OsLabel os={detail.os} arch={detail.arch} className="text-sm" />
          </span>
        }
        actions={back}
      >
        <RefreshButton
          onRefresh={() => void query.refetch()}
          fetching={query.isFetching}
          label={t("detail.refresh")}
        />
        <ActionButtons detail={detail} />
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2" data-slot="endpoint-badges">
        <ProfileBadge profile={detail.profile} />
        <ConnectionBadge endpoint={detail} />
        <ActivityBadge endpoint={detail} />
        {detail.status === "active" ? <ReadinessBadge readiness={detail.readiness} /> : null}
        {detail.status === "active" && detail.attention.length > 0 ? (
          <AttentionBadges attention={detail.attention} max={2} />
        ) : null}
      </div>

      {detail.status === "revoked" ? (
        <Alert variant="warning" data-slot="revoked-banner">
          <TriangleAlert />
          <AlertDescription>
            <p>{t("detail.revokedBanner")}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      <AttentionArea detail={detail} />

      <Tabs value={tab} onValueChange={(value) => onTabChange(value as EndpointTab)}>
        <TabsList>
          {ENDPOINT_TABS.map((item) => {
            const Icon = TAB_ICON[item];
            return (
              <TabsTrigger key={item} value={item}>
                <Icon aria-hidden="true" />
                {t(`detail.tabs.${item}`)}
              </TabsTrigger>
            );
          })}
        </TabsList>
        <TabsContent value="overview" className="pt-2">
          <OverviewTab detail={detail} onOpenRun={setOpenRun} />
        </TabsContent>
        <TabsContent value="snapshots" className="pt-2">
          <SnapshotsTab detail={detail} onShowOverview={() => onTabChange("overview")} />
        </TabsContent>
        <TabsContent value="settings" className="pt-2">
          <SettingsTab detail={detail} />
        </TabsContent>
      </Tabs>

      <RunSheet
        endpointId={detail.id}
        endpointName={endpointName(detail)}
        runId={openRun}
        onClose={() => setOpenRun(null)}
        willRetry={detail.status === "active"}
      />
    </div>
  );
}
