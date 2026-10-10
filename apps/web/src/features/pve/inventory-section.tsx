import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Container } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { RelativeTime } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTenantScope } from "@/features/endpoints/hooks";
import { canAccess, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

import { type PveGuest, type PveNode, fetchOverview, pveKeys } from "./api.js";
import { PVE_NAMESPACE } from "./i18n.js";
import { PVE_ROLES, guestTo, pveTo } from "./paths.js";

const REFRESH_MS = 30_000;

/** Where a guest stands with its backups, worst first. */
export type GuestProtection = "excluded" | "failed" | "noJob" | "never" | "protected";

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
  return guest.lastSuccessAt ? "protected" : "never";
}

const PROTECTION_BADGE = {
  protected: "outline",
  failed: "destructive",
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

function NodeRow({ group }: { group: NodeGroup }) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const [open, setOpen] = React.useState(false);
  const counts = { protected: 0, failed: 0, noJob: 0, never: 0, excluded: 0 };
  for (const guest of group.guests) {
    counts[guestProtection(guest)] += 1;
  }
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
          {(["protected", "failed", "noJob", "never"] as const).map((state) =>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">{t("guests.vmid")}</TableHead>
                <TableHead>{t("guests.name")}</TableHead>
                <TableHead>{t("inventory.running")}</TableHead>
                <TableHead>{t("guests.job")}</TableHead>
                <TableHead>{t("inventory.protection")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.guests.map((guest) => {
                const protection = guestProtection(guest);
                return (
                  <TableRow key={guest.id} data-slot="pve-inventory-guest">
                    <TableCell className="tabular-nums">{guest.vmid}</TableCell>
                    <TableCell className="min-w-0">
                      <Link {...guestTo(guest.id)} className="font-medium hover:underline">
                        {guest.name ?? `${guest.kind === "vm" ? "VM" : "CT"} ${guest.vmid}`}
                      </Link>
                      <span className="ml-2 text-muted-foreground">
                        {t(`guests.${guest.kind}`)}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {guest.status ? t(`inventory.status.${guest.status}`, guest.status) : "–"}
                    </TableCell>
                    <TableCell>{guest.jobName ?? t("guests.noJob")}</TableCell>
                    <TableCell>
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant={PROTECTION_BADGE[protection]}
                          title={
                            protection === "failed" ? (guest.lastRunError ?? undefined) : undefined
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
                      {protection === "failed" && guest.lastRunError ? (
                        <p
                          className="mt-1 max-w-prose text-xs break-words text-destructive-text"
                          data-slot="pve-inventory-error"
                        >
                          {guest.lastRunError}
                        </p>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CollapsibleContent>
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
    refetchInterval: REFRESH_MS,
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
          <NodeRow key={group.key} group={group} />
        ))}
      </div>
    </section>
  );
}
