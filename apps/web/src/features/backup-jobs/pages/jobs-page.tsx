import { Link } from "@tanstack/react-router";
import { ListChecks, ListPlus, ShieldOff } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DisabledReason, EmptyState, PageHeader, RefreshButton } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { directoryTo } from "@/features/directory/search";
import { inventoryTo } from "@/features/endpoints/paths";
import { RunDrawerHost } from "@/features/history/components/run-drawer";
import { useRunDrawer } from "@/features/history/hooks";

import type { BackupJob, JobKind } from "../api.js";
import { JobsAccessNote, closedProps, useJobsAccess } from "../components/access-note.js";
import { useJobActions } from "../components/job-actions.js";
import { JobEditor } from "../components/job-editor.js";
import { JobsTable } from "../components/jobs-table.js";
import { useBackupJobs } from "../hooks.js";

/**
 * Where the objects or machines of a notice are listed: the protected objects filtered by how
 * they stand towards the jobs, or the inventory (its "without backup" banner and filter).
 */
function uncoveredLink(kind: JobKind, job: "none" | "unscheduled") {
  return kind === "mail" ? { to: directoryTo(), search: { job } as never } : { to: inventoryTo() };
}

export interface JobsPageProps {
  kind: JobKind;
  /** The editor is open on a new job (`?new=1`). */
  creating: boolean;
  /** Objects or machines the new job starts with (`?select=`). */
  select: readonly string[];
  /** Open the editor on a new job (the address then carries `new=1`). */
  onCreate: () => void;
  /** Close the editor on a new job (the address drops `new` and `select`). */
  onCreateClosed: () => void;
  /** Open one job. */
  onOpenJob: (job: BackupJob) => void;
}

/**
 * The jobs of one kind: a table with what each covers, when it runs, where it
 * writes, the last and next run and the restore checks, "New job" as the one
 * primary button, and a notice for what no job covers. In the public demo and for
 * a role that may only look, the same page shows with its controls closed and one
 * sentence on top. The editor opens from here (also from the address, see paths.ts).
 */
export function JobsPage({
  kind,
  creating,
  select,
  onCreate,
  onCreateClosed,
  onOpenJob,
}: JobsPageProps) {
  const { t } = useTranslation("backupjobs");
  const access = useJobsAccess();
  const query = useBackupJobs(kind);
  const [editing, setEditing] = React.useState<BackupJob | null>(null);
  const actions = useJobActions();
  const drawer = useRunDrawer();
  const items = query.data?.items;
  const uncovered = query.data?.uncovered[kind] ?? 0;
  const unscheduled = query.data?.unscheduled?.[kind] ?? 0;
  const loading = query.isPending && query.fetchStatus !== "idle";
  const empty = query.data !== undefined && query.data.items.length === 0;

  const onSaved = (change: "created" | "updated", job: BackupJob) =>
    toast.success(t(`toasts.${change}`, { name: job.name }));

  return (
    <div className="space-y-6" data-slot="jobs-page" data-kind={kind}>
      <PageHeader
        icon={ListChecks}
        title={t("list.title")}
        description={t(`list.description.${kind}`)}
        actions={
          <>
            <RefreshButton
              label={t("actions.refresh")}
              fetching={query.isFetching}
              onRefresh={() => void query.refetch()}
            />
            <Button disabled={access.closed} onClick={onCreate} {...closedProps(access)}>
              <ListPlus aria-hidden="true" />
              {t("actions.new")}
            </Button>
          </>
        }
      />

      <JobsAccessNote access={access} />

      {uncovered > 0 ? (
        <Alert variant="warning" data-slot="uncovered-notice">
          <ShieldOff aria-hidden="true" />
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{t(`list.uncovered.${kind}`, { count: uncovered })}</span>
            <span className="flex shrink-0 gap-2">
              <Button variant="outline" size="sm" asChild data-action="show-uncovered">
                <Link {...uncoveredLink(kind, "none")}>{t("list.uncovered.show")}</Link>
              </Button>
              <DisabledReason reason={access.closed ? access.reason : null}>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={access.closed}
                  onClick={onCreate}
                  {...closedProps(access)}
                >
                  {t("list.uncovered.action")}
                </Button>
              </DisabledReason>
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      {unscheduled > 0 ? (
        <Alert variant="warning" data-slot="unscheduled-notice">
          <ShieldOff aria-hidden="true" />
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{t(`list.unscheduled.${kind}`, { count: unscheduled })}</span>
            {kind === "mail" ? (
              <Button variant="outline" size="sm" className="shrink-0" asChild>
                <Link {...uncoveredLink(kind, "unscheduled")}>{t("list.uncovered.show")}</Link>
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <JobsTable
        kind={kind}
        items={items}
        loading={loading}
        fetching={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={
          empty ? (
            <EmptyState
              icon={ListChecks}
              title={t(`list.empty.title.${kind}`)}
              description={t(`list.empty.description.${kind}`)}
              variant="plain"
              actions={
                <Button
                  variant="outline"
                  disabled={access.closed}
                  onClick={onCreate}
                  {...closedProps(access)}
                >
                  <ListPlus aria-hidden="true" />
                  {t("actions.new")}
                </Button>
              }
            />
          ) : null
        }
        access={access}
        onOpen={onOpenJob}
        onOpenRun={drawer.open}
        onEdit={setEditing}
        onRun={(job) => actions.runNow(job)}
        running={actions.running}
        onPause={actions.askPause}
        onResume={actions.resume}
        onDelete={actions.askDelete}
      />

      <JobEditor
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (open) return;
          if (editing) {
            setEditing(null);
          } else {
            onCreateClosed();
          }
        }}
        kind={kind}
        job={editing}
        preselect={select}
        access={access}
        onSaved={onSaved}
      />
      {actions.dialogs}
      <RunDrawerHost />
    </div>
  );
}
