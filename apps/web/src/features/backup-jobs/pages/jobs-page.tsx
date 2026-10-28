import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Archive,
  ChevronDown,
  Container,
  ListChecks,
  ListPlus,
  Server,
  ShieldOff,
} from "lucide-react";
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
import { deleteJob as deletePveJob, type PveJob, pveKeys } from "@/features/pve/api";
import { JobDialog as PveJobDialog } from "@/features/pve/pve-page";
import { pveConnected, usePveOverview } from "@/features/pve/use-overview";
import { useSession } from "@/lib/session";
import type { BackupJob, JobKind } from "../api.js";
import { closedProps, JobsAccessNote, useJobsAccess } from "../components/access-note.js";
import { useJobActions } from "../components/job-actions.js";
import { useJobRunControls } from "../components/job-run-controls.js";
import { JobSheet } from "../components/job-sheet.js";
import { JobsTable } from "../components/jobs-table.js";
import { KindEditor } from "../components/kind-editor.js";
import { type JobsListRow, pveListRows } from "../components/pve-rows.js";
import { RecommendedJobButton } from "../components/recommended-job.js";
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
  /** The row whose detail panel is open (`?job=`, 0.4.5). */
  openRow?: string | null;
  /** Open (a row's id) or close (null) a row's detail panel. */
  onOpenRow?: (rowId: string | null) => void;
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
  onOpenJob: _onOpenJob,
  openRow = null,
  onOpenRow,
}: JobsPageProps) {
  const { t } = useTranslation("backupjobs");
  const access = useJobsAccess();
  const query = useBackupJobs(kind);
  const [editing, setEditing] = React.useState<BackupJob | null>(null);
  const actions = useJobActions();
  const controls = useJobRunControls();
  // Without an address to keep it in (a test, an embedding), the panel lives in the page's state.
  const [ownOpen, setOwnOpen] = React.useState<string | null>(null);
  const openId = onOpenRow ? openRow : ownOpen;
  const setOpen = onOpenRow ?? setOwnOpen;
  const items = query.data?.items;
  const uncovered = query.data?.uncovered[kind] ?? 0;
  const session = useSession();
  // The mail job over all objects does not archive yet, where the installation offers the
  // capture (0.4.7): the recommended job switches it on.
  const archiveOffered =
    kind === "mail" &&
    (session.features?.includes("archive.mailboxCapture") ?? false) &&
    (items ?? []).some((job) => job.scopeMode === "all" && !job.archive);
  const unscheduled = query.data?.unscheduled?.[kind] ?? 0;
  const loading = query.isPending && query.fetchStatus !== "idle";
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
  // VMs and containers in no job (the overview's "no_job": templates and gone guests are not news).
  const pveWithoutJob = (pveData?.guests ?? []).filter((guest) =>
    guest.attention.includes("no_job"),
  ).length;
  const [pveEditing, setPveEditing] = React.useState<PveJob | "new" | null>(null);
  const [pveDeleting, setPveDeleting] = React.useState<PveJob | null>(null);
  const refreshPve = () => void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) });
  const empty = query.data !== undefined && query.data.items.length === 0 && pveRows.length === 0;
  const openListRow: JobsListRow | null = openId
    ? ((items ?? []).find((job) => job.id === openId) ??
      pveRows.find((row) => row.id === openId) ??
      null)
    : null;
  const onOpenPanel = React.useCallback((row: JobsListRow) => setOpen(row.id), [setOpen]);

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
            <span className="flex shrink-0 flex-wrap gap-2">
              {kind === "mail" || kind === "endpoint" ? (
                <RecommendedJobButton
                  scope={
                    kind === "mail" ? { mail: true } : { everything: true, kinds: ["endpoint"] }
                  }
                />
              ) : null}
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
      {archiveOffered ? (
        <Alert data-slot="archive-offer-notice">
          <Archive aria-hidden="true" />
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{t("list.archiveOffer.text")}</span>
            <span className="flex shrink-0 flex-wrap gap-2">
              <RecommendedJobButton
                scope={{ everything: true, kinds: ["archive"] }}
                label={t("list.archiveOffer.action")}
              />
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      {withPve && pveWithoutJob > 0 ? (
        <Alert variant="warning" data-slot="pve-uncovered-notice">
          <ShieldOff aria-hidden="true" />
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{t("list.uncovered.pve", { count: pveWithoutJob })}</span>
            <span className="flex shrink-0 flex-wrap gap-2">
              <RecommendedJobButton scope={{ everything: true, kinds: ["pve"] }} />
              <Button variant="outline" size="sm" asChild>
                <Link to={inventoryTo()} hash="pve-inventory-title">
                  {t("list.uncovered.show")}
                </Link>
              </Button>
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
        onOpenPanel={onOpenPanel}
        onEdit={setEditing}
        onPause={actions.askPause}
        onResume={actions.resume}
        onDelete={actions.askDelete}
        controls={controls}
        pve={
          withPve
            ? {
                rows: pveRows,
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
      <JobSheet
        rowId={openId}
        row={openListRow}
        loading={loading || (withPve && pveView.query.isPending)}
        onClose={() => setOpen(null)}
        access={access}
        controls={controls}
        onEdit={setEditing}
        onEditPve={(row) => setPveEditing(row.job)}
      />
      {controls.dialog}
      {actions.dialogs}
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
