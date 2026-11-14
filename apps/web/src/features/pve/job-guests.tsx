import * as React from "react";
import { useTranslation } from "react-i18next";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

import type { PveGuest } from "./api.js";
import { matchesText } from "./guests-search.js";
import { PVE_NAMESPACE } from "./i18n.js";
import { RestowServerNote } from "./self-backup.js";

/**
 * The guests of the job form (docs/PVE.md, "Backup jobs"): grouped by node, with a search by
 * name or ID, a "Select all" per node and one for every guest the search shows. "Select all"
 * never ticks the Restow server's own guest (detected or marked), nor a container that may be
 * it (its VMID in more than one cluster): backing it up needs the admin's confirmation, so it is
 * ticked on its own or not at all. Guests that cannot be backed
 * up (templates, gone, excluded) are not offered by the form in the first place.
 */

export interface JobGuestGroup {
  key: string;
  /** The node's name; empty for guests whose node is not known. */
  node: string;
  guests: PveGuest[];
}

/**
 * The guests by node, nodes by name and guests by ID, guests without a known node last. The same
 * node name in two clusters stays two groups.
 */
export function jobGuestGroups(guests: readonly PveGuest[]): JobGuestGroup[] {
  const groups = new Map<string, JobGuestGroup>();
  for (const guest of guests) {
    const key = guest.node ? `${guest.clusterId}/${guest.node}` : "";
    const group = groups.get(key) ?? { key, node: guest.node ?? "", guests: [] };
    group.guests.push(guest);
    groups.set(key, group);
  }
  const sorted = [...groups.values()].sort((a, b) => {
    if (!a.node || !b.node) {
      return a.node ? -1 : b.node ? 1 : 0;
    }
    return a.node.localeCompare(b.node) || a.key.localeCompare(b.key);
  });
  for (const group of sorted) {
    group.guests.sort((a, b) => a.vmid - b.vmid);
  }
  return sorted;
}

/** Whether "Select all" may tick the guest: never the Restow server's own one, or a maybe. */
export function bulkSelectable(
  guest: Pick<PveGuest, "restowServer" | "restowServerAmbiguous">,
): boolean {
  return !guest.restowServer && !guest.restowServerAmbiguous;
}

/**
 * The state of a "Select all" box over `guests`: ticked when every guest it may tick is chosen,
 * a dash when some of them are, empty when none is.
 */
export function selectAllState(
  guests: readonly PveGuest[],
  chosen: ReadonlySet<string>,
): boolean | "indeterminate" {
  const bulk = guests.filter(bulkSelectable);
  if (bulk.length > 0 && bulk.every((guest) => chosen.has(guest.id))) {
    return true;
  }
  return guests.some((guest) => chosen.has(guest.id)) ? "indeterminate" : false;
}

/**
 * The selection after "Select all" over `guests` was ticked (`on`) or cleared. Ticking adds every
 * guest but the Restow server's own; clearing takes every one of them out, that one too.
 */
export function applySelectAll(
  chosen: ReadonlySet<string>,
  guests: readonly PveGuest[],
  on: boolean,
): Set<string> {
  const next = new Set(chosen);
  for (const guest of guests) {
    if (on && bulkSelectable(guest)) {
      next.add(guest.id);
    } else if (!on) {
      next.delete(guest.id);
    }
  }
  return next;
}

/** The chosen guests that are in another job now and move into this one when it is saved. */
export function movingGuests(
  guests: readonly PveGuest[],
  chosen: ReadonlySet<string>,
  jobId: string | null,
): PveGuest[] {
  return guests.filter(
    (guest) => chosen.has(guest.id) && guest.jobId !== null && guest.jobId !== jobId,
  );
}

/** A guest as a node's list shows it: "web01 · VM 101". */
function guestLabel(guest: PveGuest): string {
  const kind = guest.kind === "vm" ? "VM" : "CT";
  return guest.name ? `${guest.name} · ${kind} ${guest.vmid}` : `${kind} ${guest.vmid}`;
}

export function JobGuestPicker({
  guests,
  chosen,
  onChange,
  jobId,
}: {
  /** The guests the form offers. */
  guests: readonly PveGuest[];
  chosen: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** The job being edited; null for a new one. */
  jobId: string | null;
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const [query, setQuery] = React.useState("");
  const needle = query.trim();
  const visible = needle ? guests.filter((guest) => matchesText(guest, needle)) : guests;
  const groups = jobGuestGroups(visible);
  const chosenCount = guests.filter((guest) => chosen.has(guest.id)).length;
  const moving = movingGuests(guests, chosen, jobId);
  const hasServer = guests.some((guest) => !bulkSelectable(guest));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <Input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("jobs.guestSearch")}
        aria-label={t("jobs.guestSearch")}
        data-slot="pve-job-guest-search"
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <label htmlFor="pve-job-guests-all" className="flex items-center gap-2 font-medium">
          <Checkbox
            id="pve-job-guests-all"
            data-slot="pve-job-guests-all"
            checked={selectAllState(visible, chosen)}
            disabled={!visible.some(bulkSelectable)}
            onCheckedChange={(value) => onChange(applySelectAll(chosen, visible, value === true))}
          />
          {needle ? t("jobs.guestSelectMatches") : t("jobs.guestSelectAll")}
        </label>
        <span className="text-muted-foreground" data-slot="pve-job-guests-count">
          {t("jobs.guestChosenCount", { chosen: chosenCount, total: guests.length })}
        </span>
      </div>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("jobs.guestNoMatch")}</p>
      ) : (
        <div className="max-h-72 overflow-y-auto rounded-md border">
          {groups.map((group) => {
            const nodeName = group.node || t("inventory.unknownNode");
            const boxId = `pve-job-node-${group.key || "unknown"}`;
            return (
              <div key={group.key} data-slot="pve-job-guest-node" data-node={group.node}>
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-muted px-2 py-1.5 text-sm">
                  <Checkbox
                    id={boxId}
                    aria-label={t("jobs.guestSelectNode", { node: nodeName })}
                    checked={selectAllState(group.guests, chosen)}
                    disabled={!group.guests.some(bulkSelectable)}
                    onCheckedChange={(value) =>
                      onChange(applySelectAll(chosen, group.guests, value === true))
                    }
                  />
                  <label htmlFor={boxId} className="min-w-0 flex-1 truncate font-medium">
                    {nodeName}
                  </label>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t("jobs.guestChosenCount", {
                      chosen: group.guests.filter((guest) => chosen.has(guest.id)).length,
                      total: group.guests.length,
                    })}
                  </span>
                </div>
                <ul className="space-y-1 p-2">
                  {group.guests.map((guest) => {
                    const elsewhere = guest.jobId && guest.jobId !== jobId ? guest.jobName : null;
                    return (
                      <li key={guest.id} data-slot="pve-job-guest">
                        <label
                          htmlFor={`pve-job-guest-${guest.id}`}
                          className="flex items-start gap-2 text-sm"
                        >
                          <Checkbox
                            id={`pve-job-guest-${guest.id}`}
                            className="mt-0.5"
                            checked={chosen.has(guest.id)}
                            onCheckedChange={(checked) => toggle(guest.id, checked === true)}
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
              </div>
            );
          })}
        </div>
      )}
      {moving.length > 0 ? (
        <p className="text-xs text-warning-text" data-slot="pve-job-guests-moving">
          {t("jobs.guestsMoving", { count: moving.length })}
        </p>
      ) : null}
      {hasServer ? (
        <p className="text-xs text-muted-foreground" data-slot="pve-job-guests-server">
          {t("jobs.guestSelectAllSkipsServer")}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("jobs.guestSelectionHint")}</p>
    </div>
  );
}
