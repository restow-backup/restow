import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Container } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { RelativeTime } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { canAccess, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

import {
  assignJob,
  backupNow,
  fetchOverview,
  overviewRefreshMs,
  type PveGuest,
  type PveJob,
  type PveNode,
  pveKeys,
} from "./api.js";
import { activityHint, BackupProgress } from "./backup-progress.js";
import { BackupSizeCell } from "./backup-size.js";
import { CancelBackupButton } from "./cancel-controls.js";
import { PVE_NAMESPACE } from "./i18n.js";
import { guestTo, PVE_ROLES, pveTo } from "./paths.js";
import { JobDialog } from "./pve-page.js";

/** Where a guest stands with its backups, worst first. */
export type GuestProtection =
  | "excluded"
  | "failed"
  | "noJob"
  | "never"
  | "incomplete"
  | "protected";

export function guestProtection(guest: PveGuest): GuestProtection {
  // Templates cannot be backed up (PVE disables fleecing) and absent guests are gone.
  if ((guest.template && guest.kind === "vm") || !guest.present) {
    return "excluded";
  }
  if (!guest.jobId) {
    return "noJob";
  }
  if (guest.lastRunStatus === "failed") {
    return "failed";
  }
  if (!guest.lastSuccessAt) {
    return "never";
  }
  // Succeeded, but restic could not read some items: the restore point misses them.
  return (guest.backups?.last?.unreadable ?? 0) > 0 ? "incomplete" : "protected";
}

const PROTECTION_BADGE = {
  protected: "outline",
  failed: "destructive",
  incomplete: "warning",
  noJob: "warning",
  never: "warning",
  excluded: "muted",
} as const;

interface NodeGroup {
  key: string;
  name: string;
  node: PveNode | null;
  guests: PveGuest[];
}

/** The guests of every node, nodes by name; guests without a known node last. */
export function groupByNode(nodes: PveNode[], guests: PveGuest[]): NodeGroup[] {
  const groups = new Map<string, NodeGroup>();
  for (const node of nodes) {
    groups.set(node.name, { key: node.id, name: node.name, node, guests: [] });
  }
  const unknown: PveGuest[] = [];
  for (const guest of guests) {
    const group = guest.node ? groups.get(guest.node) : undefined;
    if (group) {
      group.guests.push(guest);
    } else if (guest.node) {
      groups.set(guest.node, {
        key: `name:${guest.node}`,
        name: guest.node,
        node: null,
        guests: [guest],
      });
    } else {
      unknown.push(guest);
    }
  }
  const sorted = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const group of sorted) {
    group.guests.sort((a, b) => a.vmid - b.vmid);
  }
  if (unknown.length > 0) {
    sorted.push({ key: "unknown", name: "", node: null, guests: unknown });
  }
  return sorted;
}

/** A guest the selection may hold: present, and not a VM template (PVE cannot back those up). */
function selectable(guest: PveGuest): boolean {
  return guestProtection(guest) !== "excluded";
}

const NEW_JOB = "__new__";

function useInventoryActions() {
  const { t } = useTranslation(PVE_NAMESPACE);
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) });
  const assign = useMutation({
    mutationFn: async ({ guestIds, jobId }: { guestIds: string[]; jobId: string | null }) => {
      for (const guestId of guestIds) {
        await assignJob(guestId, jobId);
      }
      return guestIds.length;
    },
    onSuccess: (count, { jobId }) => {
      toast.success(
        jobId ? t("inventory.actions.assigned", { count }) : t("inventory.actions.unassigned"),
      );
      refresh();
    },
    onError: refresh,
  });
  const backup = useMutation({
    mutationFn: async (guestIds: string[]) => {
      let queued = 0;
      for (const guestId of guestIds) {
        const result = await backupNow(guestId);
        if (!result.alreadyQueued) {
          queued += 1;
        }
      }
      return { queued, total: guestIds.length };
    },
    onSuccess: ({ queued, total }) => {
      if (queued === 0) {
        toast.info(t("guests.backupAlreadyQueued"));
      } else {
        toast.success(t("inventory.actions.backupQueued", { count: queued, total }));
      }
      refresh();
    },
    onError: refresh,
  });
  return { assign, backup };
}

function NodeRow({ group, jobs }: { group: NodeGroup; jobs: PveJob[] }) {
  const { t, i18n } = useTranslation(PVE_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = React.useState(false);
  const { assign, backup } = useInventoryActions();
  const counts = { protected: 0, failed: 0, incomplete: 0, noJob: 0, never: 0, excluded: 0 };
  for (const guest of group.guests) {
    counts[guestProtection(guest)] += 1;
  }
  const eligible = group.guests.filter(selectable);
  // A guest that left (or became a template) since it was ticked drops out of the selection.
  const chosen = eligible.filter((guest) => selected.has(guest.id)).map((guest) => guest.id);
  const allChosen = eligible.length > 0 && chosen.length === eligible.length;
  const busy = assign.isPending || backup.isPending;
  const withoutJob = eligible.filter((guest) => !guest.jobId).map((guest) => guest.id);
  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  const addToJob = (value: string) => {
    if (value === NEW_JOB) {
      setCreating(true);
    } else if (value) {
      assign.mutate(
        { guestIds: chosen, jobId: value },
        { onSuccess: () => setSelected(new Set()) },
      );
    }
  };
  const contentId = `pve-node-${group.key}`;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-md border border-border"
      data-slot="pve-inventory-node"
    >
      <CollapsibleTrigger
        className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left text-sm hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
        aria-controls={contentId}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-4 shrink-0 transition-transform", open ? "rotate-90" : null)}
        />
        <span className="font-medium">{group.name || t("inventory.unknownNode")}</span>
        {group.node ? (
          <Badge variant={group.node.online ? "outline" : "muted"}>
            {group.node.online ? t("nodes.online") : t("nodes.offline")}
          </Badge>
        ) : null}
        <span className="text-muted-foreground">
          {t("inventory.guestCount", { count: group.guests.length })}
        </span>
        <span className="ml-auto flex flex-wrap gap-1" data-slot="pve-inventory-counts">
          {(["protected", "failed", "incomplete", "noJob", "never"] as const).map((state) =>
            counts[state] > 0 ? (
              <Badge key={state} variant={PROTECTION_BADGE[state]}>
                {t(`inventory.count.${state}`, { count: counts[state] })}
              </Badge>
            ) : null,
          )}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent id={contentId} className="border-t border-border">
        {group.guests.length === 0 ? (
          <p className="px-3 py-2.5 text-sm text-muted-foreground">{t("inventory.noGuests")}</p>
        ) : (
          <>
            {chosen.length > 0 ? (
              <div
                className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-sm"
                data-slot="pve-inventory-selection"
              >
                <span className="font-medium">
                  {t("inventory.actions.selected", { count: chosen.length })}
                </span>
                <select
                  className="h-8 rounded-md border bg-background px-2 text-sm"
                  aria-label={t("inventory.actions.addToJob")}
                  value=""
                  disabled={busy}
                  onChange={(event) => addToJob(event.target.value)}
                  data-slot="pve-inventory-add-to-job"
                >
                  <option value="">{t("inventory.actions.addToJob")}</option>
                  {jobs.map((job) => (
                    <option key={job.id} value={job.id}>
                      {job.name}
                    </option>
                  ))}
                  <option value={NEW_JOB}>{t("inventory.actions.newJob")}</option>
                </select>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => backup.mutate(chosen)}
                >
                  {t("guests.backupNow")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelected(new Set())}
                >
                  {t("inventory.actions.clear")}
                </Button>
              </div>
            ) : withoutJob.length > 0 ? (
              <div
                className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm"
                data-slot="pve-inventory-unprotected"
              >
                <span className="text-muted-foreground">
                  {t("inventory.actions.withoutJob", { count: withoutJob.length })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setSelected(new Set(withoutJob))}
                >
                  {t("inventory.actions.selectWithoutJob")}
                </Button>
                <RecommendedJobButton scope={{ guestIds: withoutJob }} />
              </div>
            ) : null}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label={t("inventory.actions.selectAll")}
                      checked={allChosen ? true : chosen.length > 0 ? "indeterminate" : false}
                      disabled={eligible.length === 0}
                      onCheckedChange={(value) =>
                        setSelected(
                          value === true ? new Set(eligible.map((guest) => guest.id)) : new Set(),
                        )
                      }
                    />
                  </TableHead>
                  <TableHead className="w-20">{t("guests.vmid")}</TableHead>
                  <TableHead>{t("guests.name")}</TableHead>
                  <TableHead>{t("inventory.running")}</TableHead>
                  <TableHead>{t("guests.job")}</TableHead>
                  <TableHead>{t("guests.backup")}</TableHead>
                  <TableHead>{t("inventory.protection")}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t("guests.actions")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.guests.map((guest) => {
                  const protection = guestProtection(guest);
                  const canBackUp = protection !== "excluded";
                  const label = guest.name ?? `${guest.kind === "vm" ? "VM" : "CT"} ${guest.vmid}`;
                  return (
                    <TableRow
                      key={guest.id}
                      data-slot="pve-inventory-guest"
                      data-state={selected.has(guest.id) ? "selected" : undefined}
                    >
                      <TableCell>
                        <Checkbox
                          aria-label={t("inventory.actions.select", { name: label })}
                          checked={selected.has(guest.id)}
                          disabled={!canBackUp}
                          onCheckedChange={(value) => toggle(guest.id, value === true)}
                        />
                      </TableCell>
                      <TableCell className="tabular-nums">{guest.vmid}</TableCell>
                      <TableCell className="min-w-0">
                        <Link {...guestTo(guest.id)} className="font-medium hover:underline">
                          {label}
                        </Link>
                        <span className="ml-2 text-muted-foreground">
                          {t(`guests.${guest.kind}`)}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {guest.status ? t(`inventory.status.${guest.status}`, guest.status) : "–"}
                      </TableCell>
                      <TableCell>
                        {canBackUp ? (
                          <select
                            className="h-8 max-w-48 rounded-md border bg-background px-2 text-sm"
                            aria-label={t("inventory.actions.jobOf", { name: label })}
                            value={guest.jobId ?? ""}
                            disabled={busy}
                            data-slot="pve-inventory-job"
                            onChange={(event) => {
                              if (event.target.value === NEW_JOB) {
                                setSelected(new Set([guest.id]));
                                setCreating(true);
                              } else {
                                assign.mutate({
                                  guestIds: [guest.id],
                                  jobId: event.target.value || null,
                                });
                              }
                            }}
                          >
                            <option value="">{t("guests.noJob")}</option>
                            {jobs.map((job) => (
                              <option key={job.id} value={job.id}>
                                {job.name}
                              </option>
                            ))}
                            <option value={NEW_JOB}>{t("inventory.actions.newJob")}</option>
                          </select>
                        ) : (
                          (guest.jobName ?? t("guests.noJob"))
                        )}
                      </TableCell>
                      <TableCell>
                        <BackupSizeCell guest={guest} />
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant={PROTECTION_BADGE[protection]}
                            title={
                              protection === "failed"
                                ? (guest.lastRunError ?? undefined)
                                : undefined
                            }
                          >
                            {t(`inventory.state.${protection}`)}
                          </Badge>
                          {guest.lastSuccessAt ? (
                            <span className="text-xs text-muted-foreground">
                              <RelativeTime value={guest.lastSuccessAt} />
                            </span>
                          ) : null}
                        </span>
                        {guest.activity === "queued" && !guest.cancelling ? (
                          <Badge
                            className="mt-1"
                            variant={group.node && !group.node.online ? "warning" : "muted"}
                            title={activityHint(t, language, guest, group.node)}
                            data-slot="pve-inventory-activity"
                          >
                            {t("guests.queued")}
                          </Badge>
                        ) : guest.activity === "running" ? (
                          <BackupProgress
                            className="mt-1.5"
                            progress={guest.progress}
                            name={label}
                            node={guest.activityNode}
                            to={guestTo(guest.id)}
                          />
                        ) : null}
                        {protection === "failed" && guest.lastRunError ? (
                          <p
                            className="mt-1 max-w-prose text-xs break-words text-destructive-text"
                            data-slot="pve-inventory-error"
                          >
                            {guest.lastRunError}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        {guest.activity ? (
                          <CancelBackupButton
                            guestId={guest.id}
                            name={label}
                            activity={guest.activity}
                            cancelling={guest.cancelling}
                            cancelledBy={guest.cancelledBy}
                            variant="ghost"
                          />
                        ) : canBackUp ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            aria-label={t("inventory.actions.backupNowOf", { name: label })}
                            onClick={() => backup.mutate([guest.id])}
                          >
                            {t("guests.backupNow")}
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </>
        )}
      </CollapsibleContent>
      {creating ? (
        <JobDialog
          job={null}
          onClose={() => setCreating(false)}
          onSaved={(job) =>
            chosen.length > 0
              ? assign.mutate(
                  { guestIds: chosen, jobId: job.id },
                  { onSuccess: () => setSelected(new Set()) },
                )
              : undefined
          }
        />
      ) : null}
    </Collapsible>
  );
}

/**
 * Proxmox VE in the inventory: one collapsible row per node with what runs on it
 * and how each VM and container stands with its backups. Only for the roles that
 * may open the Proxmox VE page, and only once a cluster is connected.
 */
export function PveInventorySection() {
  const { t } = useTranslation(PVE_NAMESPACE);
  const { role } = useSession();
  const allowed = canAccess(role, PVE_ROLES);
  const { tenantId, enabled } = useTenantScope();
  const overview = useQuery({
    queryKey: pveKeys.overview(tenantId),
    queryFn: fetchOverview,
    enabled: enabled && allowed,
    refetchInterval: (query) => overviewRefreshMs(query.state.data),
  });
  if (!allowed || !overview.data) {
    return null;
  }
  const nodes = overview.data.clusters.flatMap((cluster) => cluster.nodes);
  if (nodes.length === 0 && overview.data.guests.length === 0) {
    return null;
  }
  const groups = groupByNode(nodes, overview.data.guests);
  return (
    <section className="space-y-3" aria-labelledby="pve-inventory-title" data-slot="pve-inventory">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="pve-inventory-title" className="flex items-center gap-2 text-base font-semibold">
          <Container aria-hidden="true" className="size-4" />
          {t("inventory.title")}
        </h2>
        <Link {...pveTo()} className="text-sm text-primary hover:underline">
          {t("inventory.open")}
        </Link>
      </div>
      <div className="space-y-2">
        {groups.map((group) => (
          <NodeRow key={group.key} group={group} jobs={overview.data.jobs} />
        ))}
      </div>
    </section>
  );
}
