import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Building,
  DatabaseBackup,
  ListChecks,
  ListPlus,
  Pause,
  Pencil,
  Play,
  Repeat,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageHeader,
  RefreshButton,
  RowActionsMenu,
  StatusBadge,
} from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api";

import type { JobKind, JobMember } from "../api.js";
import { JobsAccessNote, closedProps, useJobsAccess } from "../components/access-note.js";
import { AddMembersSheet } from "../components/add-members-sheet.js";
import { CopyScope } from "../components/copy-scope.js";
import { useJobActions } from "../components/job-actions.js";
import { JobStateBadge, RestoreCheckBadge } from "../components/job-cells.js";
import { KindEditor } from "../components/kind-editor.js";
import { MembersTable } from "../components/members-table.js";
import { OverridesSheet } from "../components/overrides-sheet.js";
import { OverviewTab } from "../components/overview-tab.js";
import { RunsTable } from "../components/runs-table.js";
import { SettingsView } from "../components/settings-view.js";
import {
  useBackupJob,
  useJobMembers,
  useJobRuns,
  useJobsScope,
  useRemoveJobMember,
  useRunBackupJob,
} from "../hooks.js";
import { JOB_TABS, type JobTab, jobsListTo, linkProps } from "../paths.js";
import { describeScope, switchAction } from "../presenters.js";
import { jobErrorKey } from "../problems.js";

export interface JobDetailPageProps {
  jobId: string;
  /** The kind named in the address; null when it came without one. */
  type: JobKind | null;
  tab: JobTab;
  onTabChange: (tab: JobTab) => void;
  /** The job is loaded and its kind is not the address's: the address should say it. */
  onKindKnown: (kind: JobKind) => void;
  /** The job was deleted: leave its page. */
  onDeleted: (kind: JobKind) => void;
}

/**
 * One job: its overview (key facts, restore checks), the objects or machines it
 * covers with what each does differently, everything it says, and its runs, in
 * tabs kept in the address. Run now, Edit and Pause or Resume (mail jobs) are in
 * the header; closed, with the reason at the button, in the public demo and for a
 * role that may only look.
 */
export function JobDetailPage({
  jobId,
  type,
  tab,
  onTabChange,
  onKindKnown,
  onDeleted,
}: JobDetailPageProps) {
  const { t } = useTranslation("backupjobs");
  const access = useJobsAccess();
  const scope = useJobsScope();
  const query = useBackupJob(jobId);
  const job = query.data;
  const members = useJobMembers(jobId, job !== undefined);
  const runs = useJobRuns(jobId, 30, job !== undefined && tab === "runs");
  const [editing, setEditing] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [overrides, setOverrides] = React.useState<JobMember | null>(null);
  const [removing, setRemoving] = React.useState<JobMember | null>(null);
  const [forcing, setForcing] = React.useState(false);
  const actions = useJobActions({ onDeleted: (deleted) => onDeleted(deleted.kind) });
  const runMember = useRunBackupJob();
  const remove = useRemoveJobMember(jobId);

  // The address names the kind so the right menu entry stays active; a job opened by a bare id says it once it is known.
  const kind = job?.kind;
  React.useEffect(() => {
    if (kind && kind !== type) {
      onKindKnown(kind);
    }
  }, [kind, type, onKindKnown]);

  const backKind: JobKind = kind ?? type ?? "mail";
  const back = (
    <Link
      {...linkProps(jobsListTo(backKind))}
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      <ArrowLeft aria-hidden="true" />
      {t("detail.back")}
    </Link>
  );

  if (!scope.enabled && !query.data) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("detail.title")} icon={ListChecks} actions={back} />
        <Alert variant="info">
          <Building aria-hidden="true" />
          <AlertTitle>{t("detail.noTenant.title")}</AlertTitle>
          <AlertDescription>{t("detail.noTenant.description")}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="space-y-6">
        <PageHeader title={t("detail.title")} icon={ListChecks} actions={back} />
        <ErrorState
          title={missing ? t("detail.notFound.title") : t("detail.loadError")}
          description={missing ? t("detail.notFound.description") : undefined}
          error={query.error}
          onRetry={missing ? undefined : () => void query.refetch()}
          retrying={query.isFetching}
        />
      </div>
    );
  }
  if (!job) {
    return (
      <div className="space-y-6" aria-busy="true">
        <PageHeader title={t("detail.title")} icon={ListChecks} actions={back} />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-10 w-72" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  const change = switchAction(job);
  const allMode = job.scopeMode === "all";
  // A file share job's folders and shares are chosen in its editor, with a live browser of each share.
  const sharesInEditor = job.kind === "share";

  const runOne = (member: JobMember) =>
    runMember.mutate(
      { jobId: job.id, targetIds: [member.targetId] },
      {
        onSuccess: (result) =>
          result.queued > 0
            ? toast.success(
                t(`toasts.runQueued.${job.kind}`, { count: result.queued, name: member.name }),
              )
            : toast.info(t("toasts.runNothing", { name: member.name }), {
                description: result.skipped[0]
                  ? t(`run.skipped.${result.skipped[0].reason}`, { count: 1 })
                  : undefined,
              }),
        onError: (error) => toast.error(t("toasts.failed"), { description: t(jobErrorKey(error)) }),
      },
    );

  return (
    <div className="space-y-5" data-slot="job-detail" data-kind={job.kind}>
      <PageHeader
        icon={ListChecks}
        title={job.name}
        description={describeScope(job.scope, job.kind, t, job.copy)}
        actions={back}
      >
        <RefreshButton
          label={t("detail.refresh")}
          fetching={query.isFetching}
          onRefresh={() => {
            void query.refetch();
            void members.refetch();
          }}
        />
        {change === "pause" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={access.closed}
            onClick={() => actions.askPause(job)}
            {...closedProps(access)}
          >
            <Pause aria-hidden="true" />
            {t("actions.pause")}
          </Button>
        ) : change === "resume" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={access.closed}
            onClick={() => actions.resume(job)}
            {...closedProps(access)}
          >
            <Play aria-hidden="true" />
            {t("actions.resume")}
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          disabled={access.closed}
          onClick={() => setEditing(true)}
          {...closedProps(access)}
        >
          <Pencil aria-hidden="true" />
          {t("actions.edit")}
        </Button>
        <RowActionsMenu
          name={job.name}
          describedBy={access.closed ? access.noteId : undefined}
          actions={[
            ...(job.kind === "copy"
              ? [
                  {
                    id: "copy-anyway",
                    label: t("copyEditor.anyway.action"),
                    icon: Repeat,
                    disabled: access.closed,
                    describedBy: access.closed ? access.noteId : undefined,
                    onSelect: () => setForcing(true),
                  },
                ]
              : []),
            {
              id: "delete",
              label: t("actions.delete"),
              icon: Trash2,
              destructive: true,
              disabled: access.closed,
              describedBy: access.closed ? access.noteId : undefined,
              onSelect: () => actions.askDelete(job),
            },
          ]}
        />
        <Button
          size="sm"
          disabled={access.closed || job.scope.count === 0}
          loading={actions.running}
          onClick={() => actions.runNow(job)}
          {...closedProps(access)}
        >
          <DatabaseBackup aria-hidden="true" />
          {t("actions.runNow")}
        </Button>
      </PageHeader>

      <JobsAccessNote access={access} />

      <div className="flex flex-wrap items-center gap-2" data-slot="job-badges">
        <JobStateBadge state={job.state} />
        <RestoreCheckBadge check={job.restoreCheck} />
        {allMode ? <StatusBadge tone="muted">{t("detail.allBadge")}</StatusBadge> : null}
      </div>

      <Tabs value={tab} onValueChange={(value) => onTabChange(value as JobTab)}>
        <TabsList>
          {JOB_TABS.map((item) => (
            <TabsTrigger key={item} value={item}>
              {t(`detail.tabs.${item}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="pt-2">
          <OverviewTab job={job} onShowScope={() => onTabChange("scope")} />
        </TabsContent>

        <TabsContent value="scope" className="space-y-4 pt-2">
          {job.kind === "copy" ? <CopyScope job={job} /> : null}
          {job.kind !== "copy" && allMode ? (
            <Alert variant="info" data-slot="all-note">
              <ListChecks aria-hidden="true" />
              <AlertDescription>{t("scope.allBody")}</AlertDescription>
            </Alert>
          ) : null}
          {job.kind === "copy" ? null : (
            <MembersTable
              job={job}
              items={members.data?.items}
              loading={members.isPending && members.fetchStatus !== "idle"}
              fetching={members.isFetching}
              error={members.error}
              onRetry={() => void members.refetch()}
              access={access}
              canChangeScope={!allMode}
              onAdd={() => (sharesInEditor ? setEditing(true) : setAdding(true))}
              onEditOverrides={(member) =>
                sharesInEditor ? setEditing(true) : setOverrides(member)
              }
              onRun={runOne}
              onRemove={setRemoving}
              empty={
                <EmptyState
                  icon={ListChecks}
                  title={t(`scope.empty.title.${job.kind}`)}
                  description={t(`scope.empty.description.${job.kind}`)}
                  variant="plain"
                  actions={
                    allMode ? null : (
                      <Button
                        variant="outline"
                        disabled={access.closed}
                        onClick={() => (sharesInEditor ? setEditing(true) : setAdding(true))}
                        {...closedProps(access)}
                      >
                        <ListPlus aria-hidden="true" />
                        {t("scope.actions.add")}
                      </Button>
                    )
                  }
                />
              }
            />
          )}
        </TabsContent>

        <TabsContent value="settings" className="pt-2">
          <SettingsView job={job} access={access} onEdit={() => setEditing(true)} />
        </TabsContent>

        <TabsContent value="runs" className="pt-2">
          <RunsTable
            job={job}
            items={runs.data?.items}
            loading={runs.isPending && runs.fetchStatus !== "idle"}
            fetching={runs.isFetching}
            error={runs.error}
            onRetry={() => void runs.refetch()}
          />
        </TabsContent>
      </Tabs>

      <KindEditor
        open={editing}
        onOpenChange={setEditing}
        kind={job.kind}
        job={job}
        access={access}
        onSaved={(_, saved) => toast.success(t("toasts.updated", { name: saved.name }))}
      />
      <OverridesSheet
        open={overrides !== null}
        onOpenChange={(open) => {
          if (!open) setOverrides(null);
        }}
        job={job}
        member={overrides}
        access={access}
        onSaved={(member) => toast.success(t("toasts.overridesSaved", { name: member.name }))}
      />
      <AddMembersSheet
        open={adding}
        onOpenChange={setAdding}
        job={job}
        access={access}
        onAdded={(count) => toast.success(t(`toasts.added.${job.kind}`, { count, name: job.name }))}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t("scope.remove.title", { name: removing?.name ?? "" })}
        description={<p>{t(`scope.remove.description.${job.kind}`, { job: job.name })}</p>}
        confirmLabel={t("scope.remove.confirm")}
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await remove.mutateAsync(removing.targetId);
          toast.success(t("toasts.removed", { name: removing.name }));
          setRemoving(null);
        }}
      />
      <ConfirmDialog
        open={forcing}
        onOpenChange={setForcing}
        title={t("copyEditor.anyway.title", { name: job.name })}
        description={<p>{t("copyEditor.anyway.description")}</p>}
        confirmLabel={t("copyEditor.anyway.confirm")}
        destructive
        onConfirm={() => {
          actions.runNow(job, undefined, { force: true });
          setForcing(false);
        }}
      />
      {actions.dialogs}
    </div>
  );
}
