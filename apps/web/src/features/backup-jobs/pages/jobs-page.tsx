import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDown, Container, ListChecks, ListPlus, Server, ShieldOff } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  ConfirmDialog,
  DisabledReason,
  EmptyState,
  PageHeader,
  RefreshButton,
} from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { directoryTo } from "@/features/directory/search";
import { useTenantScope } from "@/features/endpoints/hooks";
import { inventoryTo } from "@/features/endpoints/paths";
import { fileSharesTo } from "@/features/file-shares/paths";
import { RunDrawerHost } from "@/features/history/components/run-drawer";
import { useRunDrawer } from "@/features/history/hooks";
import { deleteJob as deletePveJob, type PveJob, pveKeys } from "@/features/pve/api";
import { guestTo, pveTo } from "@/features/pve/paths";
import { JobDialog as PveJobDialog } from "@/features/pve/pve-page";
import { pveConnected, usePveOverview } from "@/features/pve/use-overview";

import type { BackupJob, JobKind } from "../api.js";
import { closedProps, JobsAccessNote, useJobsAccess } from "../components/access-note.js";
import { useJobActions } from "../components/job-actions.js";
import { JobsTable } from "../components/jobs-table.js";
import { KindEditor } from "../components/kind-editor.js";
import { type PveListRow, pveListRows } from "../components/pve-rows.js";
import { useBackupJobs } from "../hooks.js";

/**
 * Where the objects or machines of a notice are listed: the protected objects filtered by how
 * they stand towards the jobs, or the inventory (its "without backup" banner and filter).
 */
function uncoveredLink(kind: JobKind, job: "none" | "unscheduled") {
  if (kind === "share" || kind === "copy") {
    return fileSharesTo();
  }
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
  /** Source, target and folder a new copy job starts with (`?source=&target=&folder=`). */
  copy?: { source: string | null; target: string | null; folder: string | null };
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
  copy,
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  // Servers & clients list the Proxmox VE jobs too, once Proxmox VE is connected (#53).
  const pveView = usePveOverview();
  const pveData = pveView.query.data;
  const withPve =
    kind === "endpoint" &&
    pveView.allowed &&
    (pveConnected(pveData) || (pveData?.jobs.length ?? 0) > 0);
  const pveRows = React.useMemo(
    () => (withPve ? pveListRows(pveData, (guest) => t("list.pve.manual", { guest })) : []),
    [withPve, pveData, t],
  );
  const [pveEditing, setPveEditing] = React.useState<PveJob | "new" | null>(null);
  const [pveDeleting, setPveDeleting] = React.useState<PveJob | null>(null);
  const refreshPve = () => void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) });
  const empty = query.data !== undefined && query.data.items.length === 0 && pveRows.length === 0;

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
            {withPve ? (
              <NewJobMenu
                closed={access.closed}
                closedProps={closedProps(access)}
                onMachines={onCreate}
                onPve={() => setPveEditing("new")}
              />
            ) : (
              <Button disabled={access.closed} onClick={onCreate} {...closedProps(access)}>
                <ListPlus aria-hidden="true" />
                {t("actions.new")}
              </Button>
            )}
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
            {kind !== "endpoint" ? (
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
                withPve ? (
                  <NewJobMenu
                    variant="outline"
                    closed={access.closed}
                    closedProps={closedProps(access)}
                    onMachines={onCreate}
                    onPve={() => setPveEditing("new")}
                  />
                ) : (
                  <Button
                    variant="outline"
                    disabled={access.closed}
                    onClick={onCreate}
                    {...closedProps(access)}
                  >
                    <ListPlus aria-hidden="true" />
                    {t("actions.new")}
                  </Button>
                )
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
        pve={
          withPve
            ? {
                rows: pveRows,
                onOpen: (row: PveListRow) => {
                  if (row.rowType === "manual") {
                    // The run of a guest is on its page.
                    void navigate(guestTo(row.guest.id));
                  } else if (access.closed) {
                    void navigate(pveTo());
                  } else {
                    setPveEditing(row.job);
                  }
                },
                onEdit: (row) => setPveEditing(row.job),
                onDelete: (row) => setPveDeleting(row.job),
              }
            : undefined
        }
      />

      <KindEditor
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
        copy={copy}
        access={access}
        onSaved={onSaved}
      />
      {pveEditing ? (
        <PveJobDialog
          job={pveEditing === "new" ? null : pveEditing}
          guests={pveData?.guests ?? []}
          onClose={() => setPveEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={pveDeleting !== null}
        onOpenChange={(open) => (open ? undefined : setPveDeleting(null))}
        title={t("list.pve.deleteTitle", { name: pveDeleting?.name ?? "" })}
        description={t("list.pve.deleteDescription")}
        confirmLabel={t("actions.delete")}
        destructive
        onConfirm={async () => {
          if (pveDeleting) {
            await deletePveJob(pveDeleting.id);
            refreshPve();
            setPveDeleting(null);
          }
        }}
      />
      {actions.dialogs}
      <RunDrawerHost />
    </div>
  );
}

/**
 * "New job" on Servers & clients once Proxmox VE is connected: one entry per type (#53), a
 * machine job in the job editor, a Proxmox VE job in its own form with the guests to put in.
 */
function NewJobMenu({
  variant = "default",
  closed,
  closedProps: extra,
  onMachines,
  onPve,
}: {
  variant?: "default" | "outline";
  closed: boolean;
  closedProps: ReturnType<typeof closedProps>;
  onMachines: () => void;
  onPve: () => void;
}) {
  const { t } = useTranslation("backupjobs");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} disabled={closed} data-slot="new-job-menu" {...extra}>
          <ListPlus aria-hidden="true" />
          {t("actions.new")}
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onMachines} data-type="endpoint">
          <Server aria-hidden="true" />
          {t("list.newType.endpoint")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onPve} data-type="pve">
          <Container aria-hidden="true" />
          {t("list.newType.pve")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
