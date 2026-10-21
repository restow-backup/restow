import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Container, Plus, Server } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  ConfirmDialog,
  EmptyState,
  PageHeader,
  RefreshButton,
  RelativeTime,
} from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RecommendedJobButton } from "@/features/backup-jobs/components/recommended-job";
import { useTenantScope } from "@/features/endpoints/hooks";
import { inventoryTo } from "@/features/endpoints/paths";
import { CadenceFields } from "@/features/schedules/components/cadence-fields";
import { describeCadence } from "@/features/schedules/presenters";
import { BackupDestinationNote } from "@/features/storage";
import { formatBytes, formatDateTime } from "@/lib/format";

import {
  assignJob,
  backupNow,
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
import { activityHint, BackupProgress, PROGRESS_SLOT_CLASS } from "./backup-progress.js";
import { BackupSizeCell } from "./backup-size.js";
import {
  CancelBackupButton,
  CancelledBadge,
  CancellingBadge,
  CancelQueuedButton,
  NodeQueueButton,
  NodeUpdateButton,
  QueuePausedBadge,
} from "./cancel-controls.js";
import { ConnectDialog } from "./connect-dialog.js";
import { PVE_NAMESPACE } from "./i18n.js";
import { guestTo } from "./paths.js";
import {
  cadenceOfPveSchedule,
  PVE_PRESET_TYPES,
  pveCadenceDraft,
  pveScheduleOfDraft,
} from "./schedule.js";
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

function problemLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  code: string,
): string {
  const key = `problems.${code}`;
  const label = t(key);
  return label === key ? t("problems.unknown", { code }) : label;
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

/**
 * The node itself is not backed up (#53): restow-pve backs up the guests through PVE's backup
 * interface. The host's own files (/etc/pve, network and storage configuration) need the
 * Restow agent on the host, as a server of the inventory.
 */
export function HostFilesNote() {
  const { t } = useTranslation(PVE_NAMESPACE);
  return (
    <Alert variant="info" data-slot="pve-host-files">
      <Server aria-hidden="true" />
      <AlertTitle>{t("nodes.hostFiles.title")}</AlertTitle>
      <AlertDescription>
        <p>{t("nodes.hostFiles.body")}</p>
        <Link
          to={inventoryTo()}
          search={{ kind: "server" } as never}
          className={buttonVariants({ variant: "outline", size: "sm", className: "mt-2" })}
        >
          {t("nodes.hostFiles.install")}
        </Link>
      </AlertDescription>
    </Alert>
  );
}

export function GuestState({ guest, node }: { guest: PveGuest; node?: PveNode | null }) {
  const { t, i18n } = useTranslation(PVE_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const hint = activityHint(t, language, guest, node);
  const badges: React.ReactNode[] = [];
  if (guest.template && guest.kind === "vm") {
    badges.push(
      <Badge key="t" variant="muted">
        {t("guests.template")}
      </Badge>,
    );
  }
  if (guest.privileged && guest.kind === "ct") {
    badges.push(
      <Badge key="p" variant="warning">
        {t("guests.privileged")}
      </Badge>,
    );
  }
  if (!guest.present) {
    badges.push(
      <Badge key="a" variant="muted">
        {t("guests.absent")}
      </Badge>,
    );
  }
  if (guest.activity && guest.cancelling) {
    badges.push(<CancellingBadge key="c" by={guest.cancelledBy} />);
  } else if (guest.activity === "running") {
    badges.push(
      <Badge key="run" variant="info" data-slot="pve-guest-activity" title={hint}>
        {t("guests.running")}
      </Badge>,
    );
  } else if (guest.activity === "queued") {
    badges.push(
      // Amber when its node is disconnected: then nothing starts until it reports again.
      <Badge
        key="q"
        variant={node && !node.online ? "warning" : "muted"}
        data-slot="pve-guest-activity"
        title={hint}
      >
        {t("guests.queued")}
      </Badge>,
    );
  }
  if (guest.restowServer) {
    badges.push(
      <Badge
        key="self"
        variant="warning"
        data-slot="pve-guest-restow-server"
        title={t(`selfBackup.reason.${guest.restowServer}`)}
      >
        {t("selfBackup.badge")}
      </Badge>,
    );
  }
  const warnings = guest.lastRunWarnings ?? [];
  if (guest.lastRunStatus === "failed") {
    badges.push(
      <Badge key="f" variant="destructive" title={guest.lastRunError ?? undefined}>
        {t("guests.lastFailed")}
      </Badge>,
    );
  } else if (guest.lastRunStatus === "cancelled" && !guest.activity) {
    badges.push(<CancelledBadge key="x" by={guest.lastRunCancelledBy} />);
  } else if (guest.lastRunStatus === "succeeded" && warnings.length > 0) {
    // The restore point was committed; vzdump warned about something beside it.
    badges.push(
      <Badge key="w" variant="warning" data-slot="pve-guest-warnings" title={warnings.join("\n")}>
        {t("guests.succeededWithWarnings")}
      </Badge>,
    );
  } else if ((guest.backups?.last?.unreadable ?? 0) > 0) {
    // Succeeded, but the restore point misses what restic could not read.
    badges.push(
      <Badge
        key="g"
        variant="warning"
        data-slot="pve-guest-incomplete"
        title={t("guests.incompleteHint", { count: guest.backups?.last?.unreadable ?? 0 })}
      >
        {t("guests.incomplete")}
      </Badge>,
    );
  } else if (guest.lastRunStatus === "succeeded" && guest.bitmapState === null) {
    // A VM says it with its bitmap badge; a container has none.
    badges.push(
      <Badge key="s" variant="outline" data-slot="pve-guest-succeeded">
        {t("guests.lastSucceeded")}
      </Badge>,
    );
  }
  if (guest.bitmapState === "incremental") {
    badges.push(
      <Badge key="i" variant="info">
        {t("guests.incremental")}
      </Badge>,
    );
  } else if (guest.bitmapState === "full_read") {
    badges.push(
      <Badge key="r" variant="info">
        {t("guests.fullRead")}
      </Badge>,
    );
  }
  const verify = guest.lastVerify ?? null;
  const verifyErrors = verify?.state === "red" ? verify.errors : [];
  if (verify?.state === "red") {
    badges.push(
      <Badge
        key="v"
        variant="destructive"
        data-slot="pve-guest-verify-failed"
        title={verifyErrors.join("\n") || t("guests.verifyFailedHint")}
      >
        {t("guests.verifyFailed")}
      </Badge>,
    );
  } else if (verify?.state === "yellow" && verify.notChecked) {
    // The check could not run (not "failed"): what restic said in the tooltip.
    badges.push(
      <Badge
        key="v"
        variant="warning"
        data-slot="pve-guest-verify-not-checked"
        title={verify.notChecked.detail || undefined}
      >
        {verify.notChecked.reason === "locked"
          ? t("guests.verifyNotCheckedLocked")
          : t("guests.verifyNotCheckedInterrupted")}
      </Badge>,
    );
  }
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap gap-1">{badges}</div>
      {guest.lastRunStatus === "failed" && guest.lastRunError ? (
        // The reason in plain sight (two lines, the whole text in the tooltip).
        <p
          className="line-clamp-2 text-xs break-words text-destructive-text"
          title={guest.lastRunError}
          data-slot="pve-guest-error"
        >
          {guest.lastRunError}
        </p>
      ) : verifyErrors.length > 0 ? (
        // What the restore check really found (the restic or read error), not only "red".
        <p
          className="line-clamp-2 text-xs break-words text-destructive-text"
          title={verifyErrors.join("\n")}
          data-slot="pve-guest-verify-error"
        >
          {verifyErrors[0]}
        </p>
      ) : null}
    </div>
  );
}

export function PvePage() {
  const { t, i18n } = useTranslation(PVE_NAMESPACE);
  const { t: tSchedules } = useTranslation("schedules");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const overview = useOverview();
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) });
  const [editing, setEditing] = React.useState<PveJob | "new" | null>(null);
  const [revoking, setRevoking] = React.useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = React.useState<PveJob | null>(null);
  const selfBackup = useSelfBackupGuard();
  const backup = useMutation({
    mutationFn: ({ id, confirmSelfBackup }: { id: string; confirmSelfBackup?: boolean }) =>
      backupNow(id, false, { confirmSelfBackup }),
    onSuccess: (result) => {
      if (result.alreadyQueued) {
        toast.info(t("guests.backupAlreadyQueued"));
      } else {
        toast.success(t("guests.backupQueued"));
      }
      refresh();
    },
  });
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
  const nodes = (data?.clusters ?? []).flatMap((c) =>
    c.nodes.map((n) => ({ ...n, cluster: c.name })),
  );
  const withoutJob = (data?.guests ?? [])
    .filter((guest) => guest.attention.includes("no_job"))
    .map((guest) => guest.id);
  const nodeOf = (g: PveGuest): PveNode | null =>
    data?.clusters.find((c) => c.id === g.clusterId)?.nodes.find((n) => n.name === g.node) ?? null;
  // Every backup that waits for a node, for "Cancel all queued" of the tenant.
  const queuedTotal = nodes.reduce((sum, n) => sum + (n.queuedBackups ?? 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader title={t("page.title")} description={t("page.subtitle")}>
        <RefreshButton onRefresh={() => void overview.refetch()} fetching={overview.isFetching} />
        <CancelQueuedButton node={null} count={queuedTotal} />
        <ConnectDialog />
      </PageHeader>
      <p className="text-sm text-muted-foreground" data-slot="pve-limits">
        {t("page.limits")}
      </p>
      <BackupDestinationNote />
      {overview.isError ? (
        <p className="text-sm text-destructive-text">{t("page.loadError")}</p>
      ) : null}

      <section className="space-y-2" aria-labelledby="pve-nodes">
        <h2 id="pve-nodes" className="text-lg font-semibold">
          {t("nodes.title")}
        </h2>
        {nodes.length === 0 ? (
          <EmptyState icon={Server} title={t("nodes.empty")} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("nodes.node")}</TableHead>
                <TableHead>{t("nodes.cluster")}</TableHead>
                <TableHead>{t("nodes.status")}</TableHead>
                <TableHead>{t("nodes.pveVersion")}</TableHead>
                <TableHead>{t("nodes.helper")}</TableHead>
                <TableHead>{t("nodes.fleecing")}</TableHead>
                <TableHead>{t("nodes.lastSeen")}</TableHead>
                <TableHead>{t("nodes.problems")}</TableHead>
                <TableHead>{t("queue.title")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {nodes.map((n) => (
                <TableRow key={n.id}>
                  <TableCell className="font-medium">{n.name}</TableCell>
                  <TableCell>{n.cluster}</TableCell>
                  <TableCell>
                    <Badge variant={n.online ? "outline" : "muted"}>
                      {n.online ? t("nodes.online") : t("nodes.offline")}
                    </Badge>
                  </TableCell>
                  <TableCell>{n.pveVersion ?? ""}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="tabular-nums">{n.helperVersion ?? ""}</span>
                      <NodeUpdateButton node={n} />
                    </div>
                  </TableCell>
                  <TableCell>{n.fleecingStorage ?? ""}</TableCell>
                  <TableCell>
                    <RelativeTime value={n.lastSeenAt} fallback={t("nodes.never")} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {n.problems.map((p) => (
                        <Badge key={p} variant="warning">
                          {problemLabel(t, p)}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2" data-slot="pve-node-queue">
                      <QueuePausedBadge node={n} />
                      {(n.queuedBackups ?? 0) > 0 ? (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {t("queue.waiting", { count: n.queuedBackups ?? 0 })}
                        </span>
                      ) : null}
                      <NodeQueueButton node={n} />
                      <CancelQueuedButton node={n} count={n.queuedBackups ?? 0} />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setRevoking({ id: n.id, name: n.name })}
                    >
                      {t("nodes.revoke")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {nodes.length > 0 ? <HostFilesNote /> : null}
      </section>

      <section className="space-y-2" aria-labelledby="pve-jobs">
        <div className="flex items-center justify-between">
          <h2 id="pve-jobs" className="text-lg font-semibold">
            {t("jobs.title")}
          </h2>
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing("new")}>
            <Plus aria-hidden="true" />
            {t("jobs.create")}
          </Button>
        </div>
        {(data?.jobs ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("jobs.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("jobs.name")}</TableHead>
                <TableHead>{t("jobs.scope")}</TableHead>
                <TableHead>{t("jobs.schedule")}</TableHead>
                <TableHead>{t("jobs.nextRun")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.jobs ?? []).map((job) => (
                <TableRow key={job.id}>
                  <TableCell className="font-medium">{job.name}</TableCell>
                  <TableCell>
                    {job.scopeAll ? t("jobs.scopeAll") : t("jobs.scopeSelected")}
                  </TableCell>
                  <TableCell>
                    {job.schedule
                      ? describeCadence(cadenceOfPveSchedule(job.schedule), tSchedules, language)
                      : t("jobs.manualOnly")}
                  </TableCell>
                  <TableCell>{formatDateTime(job.nextRunAt, language) ?? ""}</TableCell>
                  <TableCell className="space-x-1 text-right">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(job)}>
                      {t("jobs.edit")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setDeleting(job)}
                    >
                      {t("jobs.delete")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="pve-guests">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="pve-guests" className="text-lg font-semibold">
            {t("guests.title")}
          </h2>
          {/* Guests in no job: the recommended Proxmox VE job protects them with one click (#52). */}
          {withoutJob.length > 0 ? (
            <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {t("inventory.actions.withoutJob", { count: withoutJob.length })}
              <RecommendedJobButton scope={{ guestIds: withoutJob }} />
            </span>
          ) : null}
        </div>
        {(data?.guests ?? []).length === 0 ? (
          <EmptyState icon={Container} title={t("guests.empty")} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("guests.vmid")}</TableHead>
                <TableHead>{t("guests.name")}</TableHead>
                <TableHead>{t("guests.kind")}</TableHead>
                <TableHead>{t("guests.node")}</TableHead>
                <TableHead title={t("guests.sizeHint")}>{t("guests.size")}</TableHead>
                <TableHead>{t("guests.backup")}</TableHead>
                <TableHead>{t("guests.job")}</TableHead>
                <TableHead>{t("guests.lastBackup")}</TableHead>
                <TableHead className="w-72 min-w-72">{t("guests.state")}</TableHead>
                <TableHead>{t("guests.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.guests ?? []).map((g) => (
                <TableRow key={g.id} data-slot="pve-guest">
                  <TableCell>{g.vmid}</TableCell>
                  <TableCell className="font-medium">
                    <Link {...guestTo(g.id)} className="underline-offset-4 hover:underline">
                      {g.name ?? String(g.vmid)}
                    </Link>
                    <RestowServerNote guest={g} compact />
                  </TableCell>
                  <TableCell>{t(`guests.${g.kind}`)}</TableCell>
                  <TableCell>{g.node ?? ""}</TableCell>
                  <TableCell title={t("guests.sizeHint")} className="tabular-nums">
                    {g.diskBytes > 0
                      ? t("guests.diskAllocated", { size: formatBytes(g.diskBytes, language) })
                      : ""}
                  </TableCell>
                  <TableCell>
                    <BackupSizeCell guest={g} />
                  </TableCell>
                  <TableCell>
                    <select
                      className="h-8 rounded-md border bg-background px-2 text-sm"
                      aria-label={t("guests.job")}
                      value={g.jobId ?? ""}
                      onChange={(e) => {
                        const jobId = e.target.value || null;
                        if (jobId === null) {
                          assign.mutate({ guestId: g.id, jobId });
                          return;
                        }
                        selfBackup.guard([g], (confirmSelfBackup) =>
                          assign.mutate({ guestId: g.id, jobId, confirmSelfBackup }),
                        );
                      }}
                    >
                      <option value="">{t("guests.noJob")}</option>
                      {(data?.jobs ?? []).map((job) => (
                        <option key={job.id} value={job.id}>
                          {job.name}
                        </option>
                      ))}
                    </select>
                  </TableCell>
                  <TableCell>
                    <RelativeTime value={g.lastBackupAt} fallback={t("guests.never")} />
                  </TableCell>
                  {/* A fixed width and a reserved progress slot: the row keeps its size while
                      the figures change, and long messages are cut (full text in the tooltip). */}
                  <TableCell className="w-72 max-w-72 min-w-72 space-y-1.5 align-top">
                    <GuestState guest={g} node={nodeOf(g)} />
                    <div className={PROGRESS_SLOT_CLASS} data-slot="pve-guest-progress-slot">
                      {g.activity === "running" ? (
                        <BackupProgress
                          progress={g.progress}
                          name={g.name ?? String(g.vmid)}
                          node={g.activityNode}
                          to={guestTo(g.id)}
                        />
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    {g.activity ? (
                      <CancelBackupButton
                        guestId={g.id}
                        name={g.name ?? String(g.vmid)}
                        activity={g.activity}
                        cancelling={g.cancelling}
                        cancelledBy={g.cancelledBy}
                      />
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={backup.isPending || (g.kind === "vm" && g.template)}
                        onClick={() =>
                          selfBackup.guard([g], (confirmSelfBackup) =>
                            backup.mutate({ id: g.id, confirmSelfBackup }),
                          )
                        }
                      >
                        {t("guests.backupNow")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

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
