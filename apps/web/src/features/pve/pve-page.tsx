import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, Server, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog, PageHeader, RefreshButton } from "@/components/kit";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RecommendedJobButton } from "@/features/backup-jobs/components/recommended-job";
import { useTenantScope } from "@/features/endpoints/hooks";
import { inventoryTo } from "@/features/endpoints/paths";
import { CadenceFields } from "@/features/schedules/components/cadence-fields";
import { BackupDestinationNote } from "@/features/storage";

import {
  assignJob,
  deleteJob,
  fetchOverview,
  type JobInput,
  overviewRefreshMs,
  type PveBootTestSchedule,
  type PveGuest,
  type PveJob,
  type PveNode,
  pveKeys,
  revokeNode,
  saveJob,
  selfBackupBlocked,
} from "./api.js";
import { CancelQueuedButton } from "./cancel-controls.js";
import { ConnectDialog } from "./connect-dialog.js";
import { GuestSheet } from "./guest-sheet.js";
import {
  DEFAULT_GUEST_PAGE_SIZE,
  filterGuests,
  guestRows,
  type PveSearch,
  type PveTab,
  sortGuests,
} from "./guests-search.js";
import { GUEST_NAME_ATTRIBUTE, GuestsTable } from "./guests-table.js";
import { PVE_NAMESPACE } from "./i18n.js";
import { JobsTable } from "./jobs-table.js";
import { type NodeRow, NodesTable } from "./nodes-table.js";
import { PVE_PRESET_TYPES, pveCadenceDraft, pveScheduleOfDraft } from "./schedule.js";
import { RestowServerNote, useSelfBackupGuard } from "./self-backup.js";

/** The memory limit a job's boot tests start with (MiB), as the server's default. */
const DEFAULT_BOOT_TEST_MEMORY_MIB = 8192;

function useOverview() {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: pveKeys.overview(tenantId),
    queryFn: fetchOverview,
    enabled,
    refetchInterval: (query) => overviewRefreshMs(query.state.data),
  });
}

/** A guest as the job form lists it: "web01 · VM 101 · pve1". */
function guestLabel(guest: PveGuest): string {
  const kind = guest.kind === "vm" ? "VM" : "CT";
  const name = guest.name ? `${guest.name} · ${kind} ${guest.vmid}` : `${kind} ${guest.vmid}`;
  return guest.node ? `${name} · ${guest.node}` : name;
}

/**
 * Create or change a backup job for VMs and containers; `onSaved` gets the job as saved. With
 * `guests` the form lists them to put into the job (#53): the job's own are ticked, `preselect`
 * ticks more; on save each guest whose box changed is put into the job or taken out of it. A
 * guest of another job moves (a guest is in one job at a time).
 */
export function JobDialog({
  job,
  onClose,
  onSaved,
  guests,
  preselect = [],
}: {
  job: PveJob | null;
  onClose: () => void;
  onSaved?: (job: PveJob) => void;
  guests?: readonly PveGuest[];
  preselect?: readonly string[];
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin";
  const [name, setName] = React.useState(job?.name ?? "");
  const [cadence, setCadence] = React.useState(() => pveCadenceDraft(job?.schedule ?? null, zone));
  const [attempted, setAttempted] = React.useState(false);
  // The Restow server's own VM goes into the job only with this confirmation (docs/PVE.md).
  const [selfConfirmed, setSelfConfirmed] = React.useState(false);
  const [scopeAll, setScopeAll] = React.useState(job?.scopeAll ?? false);
  const [keep, setKeep] = React.useState(
    job?.settings.retention ?? { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 },
  );
  const [testStorage, setTestStorage] = React.useState(
    job?.settings.restoreTest?.targetStorage ?? "",
  );
  const [testEnabled, setTestEnabled] = React.useState(job?.settings.restoreTest?.enabled ?? false);
  const [bootSchedule, setBootSchedule] = React.useState<PveBootTestSchedule>(
    job?.settings.bootTest?.schedule ?? "off",
  );
  const [bootMemory, setBootMemory] = React.useState(
    job?.settings.bootTest?.maxMemoryMiB ?? DEFAULT_BOOT_TEST_MEMORY_MIB,
  );
  // Templates and guests that are gone cannot be backed up; they are not offered.
  const offered = (guests ?? []).filter(
    (guest) => guest.present && !(guest.kind === "vm" && guest.template),
  );
  const own = new Set(job ? offered.filter((g) => g.jobId === job.id).map((g) => g.id) : []);
  const [chosen, setChosen] = React.useState<ReadonlySet<string>>(
    () => new Set([...own, ...preselect]),
  );
  const chosenSelf = offered.filter(
    (guest) => chosen.has(guest.id) && guest.jobId !== job?.id && selfBackupBlocked(guest),
  );
  const mutation = useMutation({
    mutationFn: async (input: JobInput) => {
      const saved = await saveJob(job?.id ?? null, input);
      if (guests) {
        for (const guest of offered) {
          const wanted = chosen.has(guest.id);
          if (wanted && guest.jobId !== saved.id) {
            await assignJob(guest.id, saved.id, {
              confirmSelfBackup: selfBackupBlocked(guest) && selfConfirmed,
            });
          } else if (!wanted && guest.jobId === saved.id) {
            await assignJob(guest.id, null);
          }
        }
      }
      return saved;
    },
    onSuccess: (saved) => {
      toast.success(t("jobs.saved"));
      void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) });
      onSaved?.(saved);
      onClose();
    },
  });
  const schedule = pveScheduleOfDraft(cadence);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (!schedule || (chosenSelf.length > 0 && !selfConfirmed)) {
      return;
    }
    mutation.mutate({
      name,
      scopeAll,
      enabled: true,
      schedule,
      settings: {
        ...job?.settings,
        retention: keep,
        restoreTest:
          testEnabled && testStorage
            ? { enabled: true, targetStorage: testStorage }
            : { enabled: false },
        bootTest: {
          ...job?.settings.bootTest,
          schedule: bootSchedule,
          maxMemoryMiB: Math.max(256, Math.round(bootMemory) || DEFAULT_BOOT_TEST_MEMORY_MIB),
        },
      },
    });
  };
  const number = (key: keyof typeof keep) => (
    <div className="space-y-1">
      <Label htmlFor={`pve-${key}`}>{t(`jobs.${key}`)}</Label>
      <Input
        id={`pve-${key}`}
        type="number"
        min={0}
        value={keep[key]}
        onChange={(e) => setKeep({ ...keep, [key]: Number(e.target.value) })}
      />
    </div>
  );
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{job ? job.name : t("jobs.create")}</DialogTitle>
          </DialogHeader>
          {/* The repository the job's container backups and VM disks land in. */}
          <BackupDestinationNote />
          <div className="space-y-1">
            <Label htmlFor="pve-job-name">{t("jobs.name")}</Label>
            <Input
              id="pve-job-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1" data-slot="pve-job-cadence">
            <p className="text-sm font-medium">{t("jobs.schedule")}</p>
            <CadenceFields
              idPrefix="pve-job-cadence"
              draft={cadence}
              onChange={setCadence}
              attempted={attempted}
              lastRunAt={job?.lastRunAt ?? null}
              presets={PVE_PRESET_TYPES}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={scopeAll}
              onChange={(e) => setScopeAll(e.target.checked)}
            />
            {t("jobs.allGuests")}
          </label>
          <div className="grid grid-cols-3 gap-2">
            {number("keepDaily")}
            {number("keepWeekly")}
            {number("keepMonthly")}
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={testEnabled}
              onChange={(e) => setTestEnabled(e.target.checked)}
            />
            {t("jobs.restoreTest")}
          </label>
          {testEnabled ? (
            <div className="space-y-1">
              <Label htmlFor="pve-job-test-storage">{t("jobs.restoreTestStorage")}</Label>
              <Input
                id="pve-job-test-storage"
                value={testStorage}
                onChange={(e) => setTestStorage(e.target.value)}
              />
            </div>
          ) : null}
          <div className="space-y-1" data-slot="pve-job-boot-test">
            <Label htmlFor="pve-job-boot-test">{t("jobs.bootTest")}</Label>
            <select
              id="pve-job-boot-test"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={bootSchedule}
              onChange={(e) => setBootSchedule(e.target.value as PveBootTestSchedule)}
            >
              <option value="off">{t("jobs.bootTestOff")}</option>
              <option value="weekly">{t("jobs.bootTestWeekly")}</option>
              <option value="after_backup">{t("jobs.bootTestAfterBackup")}</option>
            </select>
            <p className="text-xs text-muted-foreground">{t("jobs.bootTestHint")}</p>
          </div>
          {bootSchedule !== "off" ? (
            <div className="space-y-1">
              <Label htmlFor="pve-job-boot-memory">{t("jobs.bootTestMemory")}</Label>
              <Input
                id="pve-job-boot-memory"
                type="number"
                min={256}
                step={256}
                value={bootMemory}
                onChange={(e) => setBootMemory(Number(e.target.value))}
              />
            </div>
          ) : null}
          {guests ? (
            <fieldset className="space-y-2" data-slot="pve-job-guests">
              <legend className="text-sm font-medium">{t("jobs.guests")}</legend>
              {offered.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("jobs.noGuests")}</p>
              ) : (
                <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
                  {offered.map((guest) => {
                    const elsewhere = guest.jobId && guest.jobId !== job?.id ? guest.jobName : null;
                    return (
                      <li key={guest.id}>
                        <label className="flex items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={chosen.has(guest.id)}
                            onChange={(e) =>
                              setChosen((current) => {
                                const next = new Set(current);
                                if (e.target.checked) next.add(guest.id);
                                else next.delete(guest.id);
                                return next;
                              })
                            }
                          />
                          <span className="min-w-0">
                            <span className="block truncate">{guestLabel(guest)}</span>
                            <RestowServerNote guest={guest} compact />
                            {elsewhere ? (
                              <span className="block text-xs text-muted-foreground">
                                {chosen.has(guest.id)
                                  ? t("jobs.guestMoves", { job: elsewhere })
                                  : t("jobs.guestInJob", { job: elsewhere })}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </fieldset>
          ) : null}
          {chosenSelf.length > 0 ? (
            <div className="space-y-2" data-slot="pve-job-self-backup">
              {chosenSelf.map((guest) => (
                <RestowServerNote key={guest.id} guest={guest} />
              ))}
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={selfConfirmed}
                  onChange={(e) => setSelfConfirmed(e.target.checked)}
                />
                {t("selfBackup.confirmInJob")}
              </label>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="submit"
              disabled={
                mutation.isPending ||
                name.trim() === "" ||
                (attempted && schedule === null) ||
                (chosenSelf.length > 0 && !selfConfirmed)
              }
            >
              {t("jobs.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Where the host-files note remembers that it was put away (this browser only). */
export const HOST_FILES_DISMISSED_KEY = "restow.pve.hostFilesNote.dismissed";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(HOST_FILES_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The node itself is not backed up (#53): restow-pve backs up the guests through PVE's backup
 * interface. The host's own files (/etc/pve, network and storage configuration) need the
 * Restow agent on the host, as a server of the inventory. One line on the Nodes tab; it can be
 * put away (remembered in this browser).
 */
export function HostFilesNote() {
  const { t } = useTranslation(PVE_NAMESPACE);
  const [dismissed, setDismissed] = React.useState(readDismissed);
  if (dismissed) {
    return null;
  }
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border bg-info/5 p-3 text-sm sm:flex-row sm:items-center"
      data-slot="pve-host-files"
      role="note"
    >
      <Server aria-hidden="true" className="hidden size-4 shrink-0 text-info-text sm:block" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">{t("nodes.hostFiles.title")}.</span>{" "}
        <span className="text-muted-foreground">{t("nodes.hostFiles.short")}</span>
      </p>
      <div className="flex shrink-0 items-center gap-1">
        <Link
          to={inventoryTo()}
          search={{ kind: "server" } as never}
          className={buttonVariants({ variant: "outline", size: "sm" })}
          title={t("nodes.hostFiles.body")}
        >
          {t("nodes.hostFiles.install")}
        </Link>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={t("nodes.hostFiles.dismiss")}
          onClick={() => {
            try {
              window.localStorage.setItem(HOST_FILES_DISMISSED_KEY, "1");
            } catch {
              // Not remembered: it comes back on the next visit.
            }
            setDismissed(true);
          }}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

/** Every state of a guest as badges (kept under this name for the guest page's tests). */
export { GuestState } from "./guest-cells.js";

export interface PvePageProps {
  search?: PveSearch;
  onSearchChange?: (next: PveSearch) => void;
}

/** A count beside a tab's label; a dot (with words for screen readers) when something needs attention. */
function TabCount({ count, attention }: { count: number; attention?: string }) {
  return (
    <>
      <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
        {count}
      </span>
      {attention ? (
        <>
          <span className="size-2 rounded-full bg-warning" aria-hidden="true" />
          <span className="sr-only">{attention}</span>
        </>
      ) : null}
    </>
  );
}

/**
 * VMs & containers (0.4.3): three tabs, Guests (the default), Backup jobs and Nodes, each a
 * table whose layout never moves while the data refreshes. The tab, the guests' search,
 * filters, order and page and the open detail panel live in the address.
 */
export function PvePage({ search: given, onSearchChange }: PvePageProps = {}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const overview = useOverview();
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) });
  // Without a route (tests, embedding) the page keeps its search itself.
  const [own, setOwn] = React.useState<PveSearch>({});
  const search = given ?? own;
  const setSearch = onSearchChange ?? setOwn;
  const update = React.useCallback(
    (patch: Partial<PveSearch>) => {
      const next = { ...search, ...patch };
      setSearch(
        Object.fromEntries(
          Object.entries(next).filter(([, value]) => value !== undefined),
        ) as PveSearch,
      );
    },
    [search, setSearch],
  );
  const [editing, setEditing] = React.useState<PveJob | "new" | null>(null);
  const [revoking, setRevoking] = React.useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = React.useState<PveJob | null>(null);
  const selfBackup = useSelfBackupGuard();
  const assign = useMutation({
    mutationFn: ({
      guestId,
      jobId,
      confirmSelfBackup,
    }: {
      guestId: string;
      jobId: string | null;
      confirmSelfBackup?: boolean;
    }) => assignJob(guestId, jobId, { confirmSelfBackup }),
    onSuccess: refresh,
  });
  const data = overview.data;
  const loading = overview.isPending;

  const nodes = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const guest of data?.guests ?? []) {
      const key = `${guest.clusterId}\u0000${guest.node ?? ""}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return (data?.clusters ?? []).flatMap((c) =>
      c.nodes.map(
        (n): NodeRow => ({
          ...n,
          cluster: c.name,
          guests: counts.get(`${c.id}\u0000${n.name}`) ?? 0,
        }),
      ),
    );
  }, [data]);
  const nodeIndex = React.useMemo(() => {
    const index = new Map<string, PveNode>();
    for (const cluster of data?.clusters ?? []) {
      for (const node of cluster.nodes) {
        index.set(`${cluster.id}\u0000${node.name}`, node);
      }
    }
    return index;
  }, [data]);
  const nodeOf = React.useCallback(
    (g: PveGuest): PveNode | null => nodeIndex.get(`${g.clusterId}\u0000${g.node ?? ""}`) ?? null,
    [nodeIndex],
  );
  // Derived once per refresh, filtered and sorted once per change of the search.
  const rows = React.useMemo(() => guestRows(data?.guests ?? [], nodeOf), [data, nodeOf]);
  const problems = React.useMemo(
    () => rows.filter((row) => row.statuses.some((status) => status.problem)).length,
    [rows],
  );
  const filterKey = JSON.stringify([search.q, search.node, search.kind, search.job, search.state]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: filterKey is the filter part of search
  const matching = React.useMemo(() => filterGuests(rows, search), [rows, filterKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the order depends on sort and desc only
  const sorted = React.useMemo(
    () => sortGuests(matching, search),
    [matching, search.sort, search.desc],
  );
  const pageSize = search.size ?? DEFAULT_GUEST_PAGE_SIZE;
  const pageIndex = Math.max(0, (search.page ?? 1) - 1);
  const pageRows = React.useMemo(
    () => sorted.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
    [sorted, pageIndex, pageSize],
  );
  const nodeNames = React.useMemo(
    () => [...new Set((data?.guests ?? []).flatMap((g) => (g.node ? [g.node] : [])))].sort(),
    [data],
  );
  const withoutJob = React.useMemo(
    () =>
      (data?.guests ?? [])
        .filter((guest) => guest.attention.includes("no_job"))
        .map((guest) => guest.id),
    [data],
  );
  // Every backup that waits for a node, for "Cancel all queued" of the tenant.
  const queuedTotal = nodes.reduce((sum, n) => sum + (n.queuedBackups ?? 0), 0);
  const offline = nodes.filter((n) => !n.online || n.problems.length > 0).length;

  const openGuest = search.guest ?? null;
  const sheetGuest = openGuest ? (data?.guests.find((g) => g.id === openGuest) ?? null) : null;
  const onOpen = React.useCallback((guest: PveGuest) => update({ guest: guest.id }), [update]);
  const tab = search.tab ?? "guests";

  return (
    <div className="space-y-4">
      <PageHeader title={t("page.title")} description={t("page.subtitle")}>
        <RefreshButton onRefresh={() => void overview.refetch()} fetching={overview.isFetching} />
        <CancelQueuedButton node={null} count={queuedTotal} />
        <ConnectDialog />
      </PageHeader>
      <div className="flex flex-col gap-1">
        <p className="max-w-prose text-sm text-muted-foreground" data-slot="pve-limits">
          {t("page.limits")}
        </p>
        <BackupDestinationNote />
      </div>
      {overview.isError && data ? (
        <p className="text-sm text-destructive-text">{t("page.loadError")}</p>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(value) =>
          update({ tab: value === "guests" ? undefined : (value as PveTab) })
        }
      >
        <TabsList>
          <TabsTrigger value="guests" className="gap-2" data-slot="pve-tab-guests">
            {t("tabs.guests")}
            <TabCount
              count={data?.guests.length ?? 0}
              attention={problems > 0 ? t("tabs.problems", { count: problems }) : undefined}
            />
          </TabsTrigger>
          <TabsTrigger value="jobs" className="gap-2" data-slot="pve-tab-jobs">
            {t("tabs.jobs")}
            <TabCount count={data?.jobs.length ?? 0} />
          </TabsTrigger>
          <TabsTrigger value="nodes" className="gap-2" data-slot="pve-tab-nodes">
            {t("tabs.nodes")}
            <TabCount
              count={nodes.length}
              attention={offline > 0 ? t("tabs.nodeProblems", { count: offline }) : undefined}
            />
          </TabsTrigger>
        </TabsList>

        <TabsContent value="guests" className="pt-2">
          <GuestsTable
            rows={loading ? undefined : pageRows}
            matching={matching.length}
            total={rows.length}
            problems={problems}
            search={search}
            onSearchChange={update}
            jobs={data?.jobs ?? []}
            nodes={nodeNames}
            loading={loading}
            fetching={overview.isFetching}
            error={overview.error}
            onRetry={() => void overview.refetch()}
            guard={selfBackup.guard}
            onOpen={onOpen}
            toolbarExtra={
              // Guests in no job: the recommended Proxmox VE job protects them with one click (#52).
              withoutJob.length > 0 ? (
                <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  {t("inventory.actions.withoutJob", { count: withoutJob.length })}
                  <RecommendedJobButton scope={{ guestIds: withoutJob }} />
                </span>
              ) : null
            }
          />
        </TabsContent>

        <TabsContent value="jobs" className="space-y-3 pt-2">
          <div className="flex justify-end">
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing("new")}>
              <Plus aria-hidden="true" />
              {t("jobs.create")}
            </Button>
          </div>
          <JobsTable
            jobs={loading ? undefined : (data?.jobs ?? [])}
            loading={loading}
            onEdit={setEditing}
            onDelete={setDeleting}
          />
        </TabsContent>

        <TabsContent value="nodes" className="space-y-3 pt-2">
          {nodes.length > 0 ? <HostFilesNote /> : null}
          <NodesTable
            nodes={loading ? undefined : nodes}
            loading={loading}
            onRevoke={(node) => setRevoking({ id: node.id, name: node.name })}
          />
        </TabsContent>
      </Tabs>

      <GuestSheet
        guestId={openGuest}
        guest={sheetGuest}
        node={sheetGuest ? nodeOf(sheetGuest) : null}
        jobs={data?.jobs ?? []}
        loading={loading}
        onClose={() => update({ guest: undefined })}
        guard={selfBackup.guard}
        assigning={assign.isPending}
        onAssign={(guest, jobId) => {
          if (jobId === null) {
            assign.mutate({ guestId: guest.id, jobId });
            return;
          }
          selfBackup.guard([guest], (confirmSelfBackup) =>
            assign.mutate({ guestId: guest.id, jobId, confirmSelfBackup }),
          );
        }}
        returnFocus={() =>
          openGuest
            ? document.querySelector<HTMLElement>(
                `[${GUEST_NAME_ATTRIBUTE}="${CSS.escape(openGuest)}"]`,
              )
            : null
        }
      />
      {selfBackup.dialog}
      {editing ? (
        <JobDialog
          job={editing === "new" ? null : editing}
          guests={data?.guests ?? []}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => (open ? undefined : setRevoking(null))}
        title={t("nodes.revokeTitle", { name: revoking?.name ?? "" })}
        description={t("nodes.revokeDescription")}
        confirmLabel={t("nodes.revoke")}
        destructive
        onConfirm={async () => {
          if (revoking) {
            await revokeNode(revoking.id);
            refresh();
            setRevoking(null);
          }
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        title={t("jobs.deleteTitle", { name: deleting?.name ?? "" })}
        description={t("jobs.deleteDescription")}
        confirmLabel={t("jobs.delete")}
        destructive
        onConfirm={async () => {
          if (deleting) {
            await deleteJob(deleting.id);
            refresh();
            setDeleting(null);
          }
        }}
      />
    </div>
  );
}
