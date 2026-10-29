/**
 * SharePoint site discovery: the tenant's sites as protected objects of kind
 * `site`, next to the mailboxes and OneDrives the users/delta sync finds.
 *
 * Sites belong to no directory user, so they are planned apart from
 * ./plan.ts: every run lists all sites (`/sites/getAllSites`, group-connected
 * sites of Microsoft 365 groups and Teams included), drops personal sites
 * (those are OneDrives, protected through their owner), and decides each
 * site's status from its override and the sites mode of the rules
 * (`evaluateSiteProtection`). A known site the listing no longer has is
 * orphaned; its restore points stay. A site Microsoft or an admin locked (HTTP 423, ./locks.ts)
 * stays listed: once a backup marked it `orphaned` with the reason `locked` it stays so until
 * its lock probe answers 200 (`lockState`), and turns active again then.
 *
 * Listing sites needs `Sites.Read.All`. A tenant that consented before
 * SharePoint support has no such grant: Graph answers 403, the run reports it
 * as a warning and leaves the known sites as they are, and mail and OneDrive
 * keep working. Pure planning plus one Graph call; nothing here touches a
 * database.
 */
import type { GraphClient } from "../graph/client.js";
import { isGraphError } from "../graph/errors.js";
import { isPersonalSite, listAllSites, type SiteInfo } from "../graph/resources/sites.js";
import type { LockState } from "./locks.js";
import type { ObjectStatusReason } from "./plan.js";
import {
  evaluateSiteProtection,
  type ProtectionOverrides,
  type ProtectionReason,
  type ProtectionRules,
} from "./rules.js";

/** A site the tenant listing returned (personal sites already left out). */
export interface DiscoveredSite {
  /** Graph site id (`host,siteCollectionId,webId`): the protected object's external id. */
  readonly id: string;
  readonly displayName: string | null;
  readonly webUrl: string | null;
}

/** A `site` object of the source as known before the run. */
export interface KnownSite {
  readonly externalId: string;
  readonly status: "active" | "excluded" | "orphaned";
  readonly origin: "directory_sync" | "manual";
  readonly displayName: string | null;
  /** Why an orphaned site is not backed up (`locked`); null or absent when it was removed. */
  readonly statusReason?: ObjectStatusReason | null;
}

/** A site row to insert or update. */
export interface PlannedSite {
  readonly externalId: string;
  readonly displayName: string | null;
  readonly status: "active" | "excluded";
  readonly reason: ProtectionReason;
  readonly change: "created" | "updated" | "rescoped";
}

export interface SitePlan {
  readonly sites: readonly PlannedSite[];
  /** External ids of directory-sync sites to mark orphaned, or whose orphan reason changed. */
  readonly orphanExternalIds: readonly string[];
  /** The reason of each listed orphan that is still at the source (`locked`); else removed. */
  readonly orphanReasons?: Readonly<Record<string, ObjectStatusReason>>;
  /** Sites the listing returned; null when it could not be read. */
  readonly discovered: number | null;
}

/** Why sites could not be listed (a missing `Sites.Read.All`, mostly). */
export interface SiteDiscoveryFailure {
  readonly status: number;
  readonly code: string | null;
  readonly message: string;
}

export type SiteDiscovery =
  | { readonly ok: true; readonly sites: readonly DiscoveredSite[] }
  | { readonly ok: false; readonly failure: SiteDiscoveryFailure };

/** The name a site is shown under: its title, else its URL name, else its URL. */
export function siteDisplayName(
  site: Pick<SiteInfo, "displayName" | "name" | "webUrl">,
): string | null {
  return site.displayName?.trim() || site.name?.trim() || site.webUrl?.trim() || null;
}

/**
 * List the tenant's sites. A refusal (401/403, also 400 for tenants without
 * SharePoint) comes back as a failure for the run to report; throttling and
 * server errors propagate (the client already retried them) and fail the run.
 */
export async function discoverSites(client: GraphClient): Promise<SiteDiscovery> {
  const sites: DiscoveredSite[] = [];
  const seen = new Set<string>();
  try {
    for await (const site of listAllSites(client)) {
      if (!site.id || isPersonalSite(site) || seen.has(site.id)) {
        continue;
      }
      seen.add(site.id);
      sites.push({ id: site.id, displayName: siteDisplayName(site), webUrl: site.webUrl ?? null });
    }
  } catch (error) {
    if (isGraphError(error) && error.status < 500 && error.status !== 429) {
      return {
        ok: false,
        failure: {
          status: error.status,
          code: error.code ?? null,
          message: error.message.slice(0, 300),
        },
      };
    }
    throw error;
  }
  return { ok: true, sites };
}

export interface SitePlanInput {
  /** The listing; null when it failed (known sites keep their place, only rules apply). */
  readonly sites: readonly DiscoveredSite[] | null;
  readonly known: readonly KnownSite[];
  readonly rules: Pick<ProtectionRules, "sites">;
  readonly overrides: ProtectionOverrides;
  /** The lock re-check of sites known as locked (./locks.ts); missing means unknown. */
  readonly lockState?: ReadonlyMap<string, LockState>;
}

/** The row changes for the sites of one run. Unchanged sites produce no write. */
export function planSites(input: SitePlanInput): SitePlan {
  const known = new Map(
    input.known
      .filter((site) => site.origin === "directory_sync")
      .map((site) => [site.externalId, site]),
  );
  const planned: PlannedSite[] = [];
  const decide = (externalId: string) =>
    evaluateSiteProtection(input.rules, input.overrides[externalId] ?? null);

  if (input.sites === null) {
    for (const site of known.values()) {
      if (site.status === "orphaned") {
        continue;
      }
      const decision = decide(site.externalId);
      if (decision.status !== site.status) {
        planned.push({
          externalId: site.externalId,
          displayName: site.displayName,
          ...decision,
          change: "rescoped",
        });
      }
    }
    return { sites: planned, orphanExternalIds: [], orphanReasons: {}, discovered: null };
  }

  const listed = new Set<string>();
  for (const site of input.sites) {
    listed.add(site.id);
    const decision = decide(site.id);
    const before = known.get(site.id);
    if (
      before?.status === "orphaned" &&
      before.statusReason === "locked" &&
      decision.status === "active" &&
      input.lockState?.get(site.id) !== "unlocked"
    ) {
      // Still listed, still locked (or the probe could not tell): no write, no backup.
      continue;
    }
    if (!before) {
      planned.push({
        externalId: site.id,
        displayName: site.displayName,
        ...decision,
        change: "created",
      });
      continue;
    }
    if (before.status !== decision.status || before.displayName !== site.displayName) {
      planned.push({
        externalId: site.id,
        displayName: site.displayName,
        ...decision,
        change: before.displayName === site.displayName ? "rescoped" : "updated",
      });
    }
  }
  // Gone from the listing: orphaned, and a locked site that disappeared reads "removed" now.
  const orphanExternalIds = [...known.values()]
    .filter(
      (site) =>
        !listed.has(site.externalId) &&
        (site.status !== "orphaned" || (site.statusReason ?? null) !== null),
    )
    .map((site) => site.externalId);
  return { sites: planned, orphanExternalIds, orphanReasons: {}, discovered: input.sites.length };
}
