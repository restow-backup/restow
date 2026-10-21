import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowUpCircle,
  Ban,
  Camera,
  LayoutDashboard,
  Play,
  Settings,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  ConfirmDialog,
  DisabledReason,
  ErrorState,
  PageHeader,
  RefreshButton,
} from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BackupDestinationNote } from "@/features/storage";
import { ObjectSuspicionBadge, RetentionHoldNotice } from "@/features/suspicion";
import { ApiError, errorMessageKey } from "@/lib/api";

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
import {
  useCancelEndpointBackup,
  useCreateTask,
  useEndpoint,
  useRequestEndpointUpdate,
  useRestoreTest,
} from "./hooks.js";
import { ENDPOINT_TABS, type EndpointTab, inventoryTo } from "./paths.js";
import { endpointErrorKey, endpointHostLine, endpointName, isWithoutBackup } from "./presenters.js";

const TAB_ICON: Record<EndpointTab, typeof Camera> = {
  overview: LayoutDashboard,
  snapshots: Camera,
  settings: Settings,
};

/**
 * What can be stopped (0.4.2): the running backup, else a "back up now" that waits for the
 * machine. `cancelling` while the agent has not stopped it yet.
 */
export function stoppableBackup(
  detail: Pick<EndpointDetail, "runs" | "tasks">,
): { activity: "running" | "queued"; cancelling: boolean; by: string | null } | null {
  const run = detail.runs.find((r) => r.kind === "backup" && r.status === "running");
  if (run) {
    return {
      activity: "running",
      cancelling: Boolean(run.cancelRequestedAt),
      by: run.cancelledBy ?? null,
    };
  }
  const queued = detail.tasks.filter(
    (task) =>
      task.kind === "backup_now" && (task.status === "pending" || task.status === "delivered"),
  );
  if (queued.length === 0) {
    return null;
  }
  return {
    activity: "queued",
    cancelling: queued.every((task) => Boolean(task.cancelRequestedAt)),
    by: queued[0]?.cancelledBy ?? null,
  };
}

/** Stop the machine's running backup, or withdraw its queued one, after a question. */
function StopBackupButton({ detail }: { detail: EndpointDetail }) {
  const { t } = useTranslation("endpoints");
  const { t: tc } = useTranslation();
  const cancel = useCancelEndpointBackup(detail.id);
  const [open, setOpen] = React.useState(false);
  const stoppable = stoppableBackup(detail);
  if (!stoppable) {
    return null;
  }
  if (stoppable.cancelling) {
    return (
      <Badge
        variant="warning"
        data-slot="endpoint-cancelling"
        title={stoppable.by ? t("cancel.requestedBy", { name: stoppable.by }) : undefined}
      >
        {t("cancel.cancelling")}
      </Badge>
    );
  }
  const running = stoppable.activity === "running";
  const name = endpointName(detail);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-slot="endpoint-cancel-backup"
      >
        <Ban aria-hidden="true" />
        {running ? t("cancel.stop") : t("cancel.withdraw")}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={running ? t("cancel.stopTitle", { name }) : t("cancel.withdrawTitle", { name })}
        description={running ? t("cancel.stopBody") : t("cancel.withdrawBody")}
        confirmLabel={running ? t("cancel.stopConfirm") : t("cancel.withdrawConfirm")}
        cancelLabel={t("cancel.keep")}
        destructive
        pending={cancel.isPending}
        error={cancel.error ? tc(errorMessageKey(cancel.error)) : undefined}
        onConfirm={() =>
          cancel.mutateAsync().then((result) => {
            setOpen(false);
            if (result.stopping > 0) {
              toast.success(t("cancel.stopping"), { description: t("cancel.stoppingNote") });
            } else {
              toast.success(t("cancel.withdrawn"));
            }
          })
        }
      />
    </>
  );
}

/** "Update to X": the agent installs the release with its next heartbeat once it is idle. */
function UpdateNowButton({ detail }: { detail: EndpointDetail }) {
  const { t } = useTranslation("endpoints");
  const { t: tc } = useTranslation();
  const update = useRequestEndpointUpdate(detail.id);
  if (!detail.updateVersion || detail.status === "revoked") {
    return null;
  }
  if (detail.updateRequestedAt) {
    return (
      <Badge variant="info" data-slot="endpoint-updating" title={t("agentUpdate.requestedNote")}>
        {t("agentUpdate.pending", { version: detail.updateVersion })}
      </Badge>
    );
  }
  return (
    <DisabledReason reason={detail.autoUpdatePaused ? t("agentUpdate.paused") : null}>
      <Button
        variant="outline"
        size="sm"
        loading={update.isPending}
        disabled={detail.autoUpdatePaused}
        onClick={() =>
          update.mutate(undefined, {
            onSuccess: () =>
              toast.success(t("agentUpdate.requested"), {
                description: t("agentUpdate.requestedNote"),
              }),
            onError: (error) => toast.error(tc(errorMessageKey(error))),
          })
        }
        data-slot="endpoint-update-now"
      >
        {update.isPending ? null : <ArrowUpCircle aria-hidden="true" />}
        {t("agentUpdate.now", { version: detail.updateVersion })}
      </Button>
    </DisabledReason>
  );
}

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
      <UpdateNowButton detail={detail} />
      <StopBackupButton detail={detail} />
      <DisabledReason
        reason={revoked ? t("actions.revoked") : noBackup ? t("actions.test.needsBackup") : null}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={runTest}
          loading={test.isPending}
          disabled={revoked || noBackup}
        >
          {test.isPending ? null : <ShieldCheck aria-hidden="true" />}
          {t("actions.test.label")}
        </Button>
      </DisabledReason>
      <DisabledReason
        reason={revoked ? t("actions.revoked") : noJob ? t("actions.backup.needsJob") : null}
      >
        <Button
          size="sm"
          onClick={runBackup}
          loading={backup.isPending}
          disabled={revoked || noJob}
        >
          {backup.isPending ? null : <Play aria-hidden="true" />}
          {t("actions.backup.label")}
        </Button>
      </DisabledReason>
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
        <ObjectSuspicionBadge target={{ kind: "endpoint", objectId: detail.id }} />
        {detail.status === "active" ? (
          <ReadinessBadge readiness={detail.readiness} withoutBackup={isWithoutBackup(detail)} />
        ) : null}
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

      <RetentionHoldNotice
        target={{ kind: "endpoint", objectId: detail.id }}
        objectName={endpointName(detail)}
      />

      <AttentionArea detail={detail} />
      {/* The repository this machine's backups land in. */}
      <BackupDestinationNote />

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
