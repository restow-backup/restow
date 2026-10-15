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
 * orphaned; its restore points stay.
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
  /** External ids of directory-sync sites to mark orphaned. */
  readonly orphanExternalIds: readonly string[];
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
    return { sites: planned, orphanExternalIds: [], discovered: null };
  }

  const listed = new Set<string>();
  for (const site of input.sites) {
    listed.add(site.id);
    const decision = decide(site.id);
    const before = known.get(site.id);
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
  const orphanExternalIds = [...known.values()]
    .filter((site) => !listed.has(site.externalId) && site.status !== "orphaned")
    .map((site) => site.externalId);
  return { sites: planned, orphanExternalIds, discovered: input.sites.length };
}
