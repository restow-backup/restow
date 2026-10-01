import { type Database, tenants } from "@restow/db";
import { asc, ne } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import type { TenantContext } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import type { ReportLanguage } from "../../reports/format.js";
import { renderStatsReport } from "../../reports/stats-report.js";
import { type TenantAggregate, aggregateTenant } from "./aggregate.js";
import { buildStats } from "./build.js";
import { collectTenantFacts } from "./collect.js";
import { datasetTable, toCsv } from "./csv.js";
import type { StatsDto } from "./dto.js";
import { type ResolvedPeriod, resolvePeriod } from "./period.js";
import type { ExportQuery, StatsQuery } from "./schemas.js";

/**
 * Statistics for a tenant, or for every tenant of the installation (the
 * provider scope, while `stats.allTenants` is on), as JSON, as a CSV file per
 * dataset and as a PDF report.
 *
 * Each tenant is read in its own tenant-pinned transaction (Row Level
 * Security), one tenant after the other; the provider scope adds the results
 * up and never runs a query across tenants.
 *
 * Auditing: exports and reports carry backup metadata out of Restow as a
 * file, so each one is audited: in the tenant's chain, and for the provider
 * scope in the installation chain plus the chain of every tenant whose
 * figures it contains. Showing the figures on the stats page (the JSON read)
 * is not audited, like the other admin overviews (protected objects,
 * recovery readiness): it returns counts, sizes and the names of the ten
 * largest protected objects, which those overviews list anyway, and never
 * any backup content; reading content (a snapshot's tree, a verify report)
 * or restoring it is audited where that happens. Auditing every page view
 * would bury those entries under the stats page's refreshes.
 */

export const STATS_AUDIT_ACTIONS = {
  exported: "stats.exported",
  reportGenerated: "stats.report_generated",
} as const;

export const DATASET_UNAVAILABLE_PROBLEM = "urn:restow:problem:stats-dataset-unavailable";
export const DATASET_NOT_IN_SCOPE_PROBLEM = "urn:restow:problem:stats-dataset-not-in-scope";

/** Whose figures a request covers. */
export type StatsScope =
  | { readonly kind: "tenant"; readonly tenant: Pick<TenantContext, "id" | "name" | "slug"> }
  | { readonly kind: "provider" };

export interface StatsActor {
  readonly userId: string;
  readonly email: string;
  readonly ip: string | null;
}

export interface StatsDeps {
  /** The application pool (Row Level Security applies). */
  readonly db: Database;
  /** The installation pool: the tenant list and the installation audit chain. */
  readonly providerDb: Database;
  readonly now?: () => Date;
}

interface TenantRef {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

/** The tenants a scope covers: the one tenant, or every tenant not being deleted. */
async function tenantsOf(deps: StatsDeps, scope: StatsScope): Promise<TenantRef[]> {
  if (scope.kind === "tenant") {
    return [scope.tenant];
  }
  return deps.providerDb
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
    .from(tenants)
    .where(ne(tenants.status, "deleting"))
    .orderBy(asc(tenants.name), asc(tenants.id));
}

async function aggregatesOf(
  deps: StatsDeps,
  scope: StatsScope,
  covered: readonly TenantRef[],
  period: ResolvedPeriod,
): Promise<TenantAggregate[]> {
  const aggregates: TenantAggregate[] = [];
  // One tenant per transaction, one after the other: no query spans tenants,
  // and a large installation does not hold many connections at once.
  for (const tenant of covered) {
    const facts = await withTenantTx(deps.db, tenant.id, (tx) =>
      collectTenantFacts(tx, { id: tenant.id, name: tenant.name }, period),
    );
    aggregates.push(aggregateTenant(facts, period, scope.kind));
  }
  return aggregates;
}

export interface LoadedStats {
  readonly stats: StatsDto;
  readonly tenants: readonly TenantRef[];
}

/** The statistics of a scope for the requested period. */
export async function loadStats(
  deps: StatsDeps,
  scope: StatsScope,
  query: Pick<StatsQuery, "from" | "to" | "granularity">,
): Promise<LoadedStats> {
  const now = (deps.now ?? (() => new Date()))();
  const period = resolvePeriod(query, now);
  const covered = await tenantsOf(deps, scope);
  const aggregates = await aggregatesOf(deps, scope, covered, period);
  return {
    stats: buildStats({ period, scope: scope.kind, tenants: aggregates, generatedAt: now }),
    tenants: covered,
  };
}

/** Write the audit entries of an export or report (see the module comment). */
async function auditExport(
  deps: StatsDeps,
  scope: StatsScope,
  covered: readonly TenantRef[],
  actor: StatsActor,
  event: { action: string; target: string; details: Record<string, unknown> },
): Promise<void> {
  const base = {
    actor: actor.email,
    actorUserId: actor.userId,
    ip: actor.ip,
    action: event.action,
    target: event.target,
    targetType: "stats",
  };
  if (scope.kind === "tenant") {
    await audit(deps.db, {
      ...base,
      tenantId: scope.tenant.id,
      details: { ...event.details, scope: "tenant" },
    });
    return;
  }
  await audit(deps.providerDb, {
    ...base,
    tenantId: null,
    details: { ...event.details, scope: "provider", tenants: covered.length },
  });
  for (const tenant of covered) {
    await audit(deps.db, {
      ...base,
      tenantId: tenant.id,
      details: { ...event.details, scope: "provider" },
    });
  }
}

function periodDetails(stats: StatsDto): Record<string, unknown> {
  return {
    from: stats.period.from,
    to: stats.period.to,
    granularity: stats.period.granularity,
  };
}

/** `restow-stats-<tenant or all-tenants>-<dataset>-<from>-<to>.<ext>` */
function fileName(scope: StatsScope, stats: StatsDto, part: string | null, ext: string): string {
  const who = scope.kind === "tenant" ? scope.tenant.slug : "all-tenants";
  const name = ["restow-stats", who, part, stats.period.from, stats.period.to]
    .filter((segment): segment is string => segment !== null)
    .join("-");
  return `${name}.${ext}`;
}

export interface CsvExport {
  readonly fileName: string;
  readonly body: string;
}

/** One dataset as a CSV file; audited. */
export async function exportDataset(
  deps: StatsDeps,
  scope: StatsScope,
  query: ExportQuery,
  actor: StatsActor,
): Promise<CsvExport> {
  const { stats, tenants: covered } = await loadStats(deps, scope, query);
  const table = datasetTable(stats, query.dataset);
  if (table === null) {
    throw new ProblemError(422, "Dataset not in this scope", {
      type: DATASET_NOT_IN_SCOPE_PROBLEM,
      detail: `The ${query.dataset} dataset exists only in the provider scope.`,
      extensions: { dataset: query.dataset },
    });
  }
  if ("unavailable" in table) {
    throw new ProblemError(409, "Dataset unavailable", {
      type: DATASET_UNAVAILABLE_PROBLEM,
      detail: `The ${query.dataset} dataset has no data source in this scope.`,
      extensions: { dataset: query.dataset, reason: table.unavailable },
    });
  }
  const body = toCsv(table.header, table.rows);
  await auditExport(deps, scope, covered, actor, {
    action: STATS_AUDIT_ACTIONS.exported,
    target: query.dataset,
    details: {
      ...periodDetails(stats),
      format: "csv",
      dataset: query.dataset,
      rows: table.rows.length,
    },
  });
  return { fileName: fileName(scope, stats, query.dataset, "csv"), body };
}

export interface PdfReport {
  readonly fileName: string;
  readonly pdf: Buffer;
}

/** The statistics report as a PDF in the requested language; audited. */
export async function generateReport(
  deps: StatsDeps,
  scope: StatsScope,
  query: Pick<StatsQuery, "from" | "to" | "granularity">,
  language: ReportLanguage,
  actor: StatsActor,
): Promise<PdfReport> {
  const { stats, tenants: covered } = await loadStats(deps, scope, query);
  const pdf = await renderStatsReport({
    stats,
    language,
    subject:
      scope.kind === "tenant"
        ? { kind: "tenant", name: scope.tenant.name }
        : { kind: "provider", tenantCount: covered.length },
  });
  await auditExport(deps, scope, covered, actor, {
    action: STATS_AUDIT_ACTIONS.reportGenerated,
    target: "report",
    details: { ...periodDetails(stats), format: "pdf", language, bytes: pdf.length },
  });
  return { fileName: fileName(scope, stats, null, "pdf"), pdf };
}
