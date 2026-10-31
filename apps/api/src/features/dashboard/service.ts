import { type InstallationDefaultStorage, installationDefaultStorage } from "@restow/core";
import { type Database, safeErrorMessage } from "@restow/db";
import { featureHook } from "../../extensions.js";
import { requireFeature } from "../../lib/features.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { isTenantAdmin, type Role } from "../../middleware/rbac.js";
import type { TenantContext } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { loadTenantSummaryWithReadiness, type TenantSummaryDto } from "../../routes/v1/status.js";
import { loadShareCounts, type ShareProtection } from "../file-shares/protection.js";
import { listJobsQuerySchema } from "../jobs/schemas.js";
import { listJobs } from "../jobs/service.js";
import { type GuestProtection, loadGuestCounts } from "../pve/protection.js";
import { loadRunning } from "../running/read.js";
import type { SystemDiskDeps } from "../storage/system-disk.js";
import {
  countTenantMailboxes,
  loadTenantUsage,
  type TenantUsageDto,
  totalMailboxes,
} from "../usage/service.js";
import type { ReadinessSummaryDto } from "../verify/summary.js";
import {
  capacityPath,
  type FilesystemSpace,
  type FilesystemSpaceReader,
  statfsSpace,
} from "./capacity.js";
import {
  type DashboardDto,
  type EndpointsWidget,
  type MailboxUsageWidget,
  type ProviderViewDto,
  type RecentJobDto,
  type RecentJobsWidget,
  type RunningWidget,
  type SystemDiskWarningDto,
  TENANT_WIDGET_IDS,
  type TenantWidgetId,
  type TenantWidgetsDto,
  type WidgetResult,
} from "./dto.js";
import { loadEndpointsWidget } from "./endpoints.js";
import { runsFull, STORAGE_DEFAULT_DAYS, storageBuckets, storageForecast } from "./growth.js";
import {
  BACKUP_TREND_DAYS,
  HISTORY_DAYS,
  loadInstallationDefaultTest,
  loadMailFacts,
  loadStaleThresholds,
  loadStorageCapacityFacts,
  loadStorageHistory,
  loadTenantCap,
  loadTenantFacts,
  loadTenantTrends,
  type StaleThresholds,
  type StorageHistory,
  soleTenantOnDefault,
  type TenantFacts,
  type TenantTrends,
} from "./queries.js";
import { summarizeRetention } from "./retention.js";
import type { DashboardQuery } from "./schemas.js";
import { dayKeys, fillDays } from "./series.js";
import { buildSetupChecklist, type SetupFacts } from "./setup.js";
import { loadSystemDiskWarning } from "./system-disk.js";
import "./hooks.js";
import type { SettledSource } from "./hooks.js";

/**
 * The start page in one response. Which widgets apply is decided here, not
 * in the browser: every single-tenant widget exists on every installation, the
 * admin widgets are left out for plain members, and the provider view exists
 * only for provider admins while `dashboard.allTenants` is on. A request may
 * narrow the tenant widgets to a few (`widgets=setup` for the sidebar's Start
 * checklist) or ask for the provider view alone (`provider=only`).
 *
 * Each data source is loaded on its own and may fail on its own: a widget
 * whose source failed is returned as `{ state: "error" }` (the cause goes to
 * the server log, never into the response) and every other widget still
 * renders.
 */

export interface DashboardDeps {
  /** The application pool (Row Level Security applies). */
  db: Database;
  /** The installation pool, for installation-level facts and the tenant list. */
  providerDb: Database;
  /** Environment of the installation default storage (used when `defaultStorageConfigured` is absent). */
  env: NodeJS.ProcessEnv;
  /**
   * Whether the installation default that applies right now (saved under Installation → Default
   * storage, else the environment) is usable; omitted, the environment alone decides.
   */
  defaultStorageConfigured?: () => Promise<boolean>;
  /**
   * The installation default that applies right now (saved, else the environment); omitted,
   * the environment alone decides. The storage growth chart reads the free space of a local one.
   */
  installationDefault?: () => Promise<InstallationDefaultStorage | null>;
  /** Free space of the filesystem a local repository is on (statfs); omitted, `statfsSpace`. */
  filesystemSpace?: FilesystemSpaceReader;
  /** How the server's system disk is recognised (tests); the api container's view otherwise. */
  systemDisk?: SystemDiskDeps;
  now: () => Date;
}

export interface DashboardViewer {
  tenant: TenantContext;
  role: Role;
  isProviderAdmin: boolean;
  /**
   * The provider admin's team role covers every tenant. A member limited to some tenants is
   * refused the provider view, which lists them all; omitted, every tenant is covered.
   */
  providerAllTenants?: boolean;
}

/** Jobs shown in the recent-jobs widget. */
export const RECENT_JOBS_LIMIT = 8;

/**
 * Who sees a widget. `admins` widgets name mailboxes and accounts (recent
 * jobs) or describe the installation's usage, so plain members of a tenant do
 * not get them.
 */
export const WIDGET_AUDIENCE: Readonly<Record<TenantWidgetId, "everyone" | "admins">> = {
  setup: "everyone",
  lastBackup: "everyone",
  readiness: "everyone",
  // The runs name mailboxes, machines and guests: for the people who administer them.
  running: "admins",
  protectedObjects: "everyone",
  storage: "everyone",
  mailboxUsage: "admins",
  // The endpoint pages are admin pages (docs/AGENT.md); the machines' names stay there.
  endpoints: "admins",
  backupTrend: "everyone",
  verificationHistory: "everyone",
  storageGrowth: "everyone",
  retention: "everyone",
  recentJobs: "admins",
};

/** The widgets a viewer gets, in page order. */
export function widgetsFor(canAdminister: boolean): TenantWidgetId[] {
  return TENANT_WIDGET_IDS.filter((id) => canAdminister || WIDGET_AUDIENCE[id] === "everyone");
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

type Settled<T> = SettledSource<T>;

const NOT_NEEDED: Settled<never> = { ok: false };

function logFailure(source: string, tenantId: string | null, error: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      message: "dashboard data source failed",
      source,
      tenantId,
      // Never the failed query with its bound parameters.
      errorMessage: safeErrorMessage(error),
    }),
  );
}

async function settle<T>(
  source: string,
  tenantId: string | null,
  run: () => Promise<T>,
): Promise<Settled<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    logFailure(source, tenantId, error);
    return { ok: false };
  }
}

/** A widget from its sources: an error as soon as one of them failed. */
function widget<T>(inputs: readonly Settled<unknown>[], build: () => T): WidgetResult<T> {
  return inputs.every((input) => input.ok) ? { state: "ok", data: build() } : { state: "error" };
}

/** The value of a source that `widget` already checked. */
function value<T>(settled: Settled<T>): T {
  if (!settled.ok) {
    throw new Error("dashboard source read before it was checked");
  }
  return settled.value;
}

async function loadRecentJobs(
  db: Database,
  tenantId: string,
  now: Date,
): Promise<RecentJobsWidget> {
  const page = await listJobs(
    db,
    tenantId,
    listJobsQuerySchema.parse({ limit: RECENT_JOBS_LIMIT }),
  );
  const items: RecentJobDto[] = page.items.map((job) => ({
    id: job.id,
    queue: job.queue,
    status: job.status,
    object: job.object ? { kind: job.object.kind, displayName: job.object.displayName } : null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    progress: job.progress
      ? { total: job.progress.total, done: job.progress.done, failed: job.progress.failed }
      : null,
    throttledUntil:
      job.status === "active" && job.throttle && Date.parse(job.throttle.until) > now.getTime()
        ? job.throttle.until
        : null,
    failure: job.failure,
    serviceLimited: job.serviceLimited,
    notBackedUp: job.notBackedUp,
    itemCauses: job.itemCauses,
  }));
  return { items };
}

/**
 * The installation's mailbox usage (every tenant counted in its own pinned
 * transaction), read at most once per request: the mailbox widget and the
 * provider view both need it.
 */
type UsageReader = () => Promise<TenantUsageDto[]>;

function usageReader(providerDb: Database): UsageReader {
  let pending: Promise<TenantUsageDto[]> | null = null;
  return () => {
    pending ??= loadTenantUsage(providerDb);
    return pending;
  };
}

/** The viewer's tenant alone, in its pinned transaction. */
async function loadOwnUsage(db: Database, tenantId: string): Promise<MailboxUsageWidget["tenant"]> {
  return withTenantTx(db, tenantId, async (tx) => ({
    used: await countTenantMailboxes(tx, tenantId),
    cap: await loadTenantCap(tx, tenantId),
  }));
}

async function loadMailboxUsage(
  deps: DashboardDeps,
  viewer: DashboardViewer,
  readUsage: UsageReader,
): Promise<MailboxUsageWidget> {
  const tenantId = viewer.tenant.id;

  // Provider admins see the installation; everyone else the tenant's own
  // mailboxes only, never a figure that spans other tenants.
  if (viewer.isProviderAdmin) {
    const usage = await readUsage();
    const own = usage.find((row) => row.id === tenantId);
    return {
      scope: "installation",
      used: totalMailboxes(usage),
      tenant: own ? { used: own.mailboxes, cap: own.cap } : await loadOwnUsage(deps.db, tenantId),
    };
  }
  const tenant = await loadOwnUsage(deps.db, tenantId);
  return { scope: "tenant", used: tenant.used, tenant };
}

interface StorageCapacity extends FilesystemSpace {
  /** Other data of the tenant is written to the same repository: no date is estimated. */
  otherData: boolean;
}

/** The installation default's primary location, or null when there is no usable default. */
async function defaultLocation(deps: DashboardDeps) {
  if (deps.installationDefault) {
    return (await deps.installationDefault())?.primary ?? null;
  }
  try {
    return installationDefaultStorage(deps.env).primary;
  } catch {
    return null;
  }
}

/** The free space of the tenant's repository (capacity.ts), or null where it is not known. */
async function loadStorageCapacity(
  deps: DashboardDeps,
  tenantId: string,
): Promise<StorageCapacity | null> {
  const facts = await loadStorageCapacityFacts(deps.db, tenantId);
  const path = facts.ownTarget
    ? capacityPath(facts, null, false)
    : capacityPath(
        facts,
        await defaultLocation(deps),
        await soleTenantOnDefault(deps.providerDb, tenantId),
      );
  if (!path) {
    return null;
  }
  const space = await (deps.filesystemSpace ?? statfsSpace)(path);
  return space ? { ...space, otherData: facts.otherData } : null;
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

/**
 * The tenant summary with the readiness counted as the readiness page counts it (objects
 * confirmed as empty apart, where v1 counts them as green).
 */
type DashboardSummary = Omit<TenantSummaryDto, "readiness"> & { readiness: ReadinessSummaryDto };

interface Sources {
  summary: Settled<DashboardSummary>;
  facts: Settled<TenantFacts>;
  mail: Settled<SetupFacts["mail"]>;
  trends: Settled<TenantTrends>;
  storageHistory: Settled<StorageHistory>;
  /** The free space of the repository, where known; a failure to read it only leaves it out. */
  capacity: Settled<StorageCapacity | null>;
  /** The primary on the system disk; a failure to read it only leaves the warning out. */
  systemDisk: Settled<SystemDiskWarningDto | null>;
  jobs: Settled<RecentJobsWidget>;
  mailboxes: Settled<MailboxUsageWidget>;
  endpoints: Settled<EndpointsWidget>;
  stale: Settled<StaleThresholds>;
  guests: Settled<Pick<GuestProtection, "counts" | "staleAfterHours">>;
  shares: Settled<Pick<ShareProtection, "counts" | "staleAfterHours">>;
  running: Settled<RunningWidget>;
}

function buildWidgets(
  wanted: readonly TenantWidgetId[],
  sources: Sources,
  viewer: DashboardViewer,
  now: Date,
  forecastDays: number,
): TenantWidgetsDto {
  const { summary, facts, mail, trends } = sources;
  const widgets: TenantWidgetsDto = {};
  for (const id of wanted) {
    switch (id) {
      case "setup":
        widgets.setup = widget([facts, mail], () =>
          buildSetupChecklist(
            { ...value(facts).setup, storage: value(facts).storage, mail: value(mail) },
            viewer.role,
          ),
        );
        break;
      case "lastBackup":
        widgets.lastBackup = widget(
          [summary, facts, sources.endpoints, sources.stale, sources.guests, sources.shares],
          () => {
            const machines = value(sources.endpoints);
            const guests = value(sources.guests);
            const shares = value(sources.shares);
            return {
              lastSuccess: value(summary).lastSuccess,
              protectedKinds: value(facts).kinds,
              machines: {
                protected: machines.protected,
                withoutJob: machines.withoutJob,
                lastSuccessAt: machines.lastSuccessAt,
              },
              guests: {
                protected: guests.counts.protected,
                withoutJob: guests.counts.withoutJob,
                lastSuccessAt: guests.counts.lastSuccessAt,
              },
              fileShares: {
                protected: shares.counts.protected,
                withoutJob: shares.counts.withoutJob,
                lastSuccessAt: shares.counts.lastSuccessAt,
              },
              staleAfterHours: {
                ...value(sources.stale),
                guests: guests.staleAfterHours,
                fileShares: shares.staleAfterHours,
              },
            };
          },
        );
        break;
      case "readiness":
        widgets.readiness = widget([summary], () => {
          const { readiness } = value(summary);
          return {
            overall: readiness.overall,
            total: readiness.total,
            green: readiness.green,
            yellow: readiness.yellow,
            red: readiness.red,
            unverified: readiness.unverified,
            noBackup: readiness.noBackup,
            empty: readiness.empty,
            overdue: readiness.overdue,
            withoutJob: readiness.withoutJob,
            objectsWithoutJob: readiness.objectsWithoutJob,
            guestsWithoutJob: readiness.guestsWithoutJob,
            sharesWithoutJob: readiness.sharesWithoutJob,
            toConfirm: readiness.toConfirm,
            running: readiness.running,
            lastCheckedAt: readiness.lastCheckedAt,
          };
        });
        break;
      case "running":
        widgets.running = widget([sources.running], () => value(sources.running));
        break;
      case "protectedObjects":
        widgets.protectedObjects = widget(
          [summary, sources.endpoints, sources.guests, sources.shares],
          () => {
            const machines = value(sources.endpoints);
            const guests = value(sources.guests).counts;
            const shares = value(sources.shares).counts;
            return {
              ...value(summary).objects,
              withoutJob: value(summary).readiness.objectsWithoutJob,
              machines: {
                protected: machines.protected,
                withoutJob: machines.withoutJob,
                failedLastBackup: machines.failedLastBackup,
              },
              guests: {
                protected: guests.protected,
                withoutJob: guests.withoutJob,
                failedLastBackup: guests.failedLastBackup,
                restorePoints: guests.restorePoints,
              },
              fileShares: {
                protected: shares.protected,
                withoutJob: shares.withoutJob,
                failedLastBackup: shares.failedLastBackup,
                warnings: shares.warnings,
                restorePoints: shares.restorePoints,
              },
              noBackup: value(summary).readiness.noBackup,
            };
          },
        );
        break;
      case "storage":
        widgets.storage = widget([summary, facts], () => ({
          logicalBytes: value(summary).storage.logicalBytes,
          physicalBytes: value(summary).storage.physicalBytes,
          repositoryBytes: value(facts).repositoryBytes,
          target: value(facts).storage,
          immutability: value(facts).immutability,
          systemDisk: sources.systemDisk.ok ? sources.systemDisk.value : null,
        }));
        break;
      case "mailboxUsage":
        widgets.mailboxUsage = widget([sources.mailboxes], () => value(sources.mailboxes));
        break;
      case "endpoints":
        widgets.endpoints = widget([sources.endpoints], () => value(sources.endpoints));
        break;
      case "backupTrend":
        widgets.backupTrend = widget([trends], () => ({
          days: BACKUP_TREND_DAYS,
          series: fillDays(dayKeys(now, BACKUP_TREND_DAYS), value(trends).backupDays, (date) => ({
            date,
            succeeded: 0,
            withItemFailures: 0,
            failed: 0,
          })),
        }));
        break;
      case "verificationHistory":
        widgets.verificationHistory = widget([trends], () => ({
          days: HISTORY_DAYS,
          series: fillDays(dayKeys(now, HISTORY_DAYS), value(trends).verificationDays, (date) => ({
            date,
            green: 0,
            yellow: 0,
            red: 0,
          })),
          lastCheckedAt: value(trends).lastCheckedAt,
        }));
        break;
      case "storageGrowth":
        widgets.storageGrowth = widget([sources.storageHistory], () => {
          const { window, baseline, written } = value(sources.storageHistory);
          const buckets = storageBuckets(window, baseline, written);
          const forecast = storageForecast(window, buckets, forecastDays);
          const space = sources.capacity.ok ? sources.capacity.value : null;
          const today = buckets.at(-1)?.date;
          return {
            days: window.days,
            requestedDays: window.requestedDays,
            granularity: window.granularity,
            series: buckets.map(({ date, bytes }) => ({ date, bytes })),
            growthBytes: (buckets.at(-1)?.bytes ?? baseline) - baseline,
            forecast,
            capacity:
              space && today
                ? {
                    source: "filesystem" as const,
                    freeBytes: space.freeBytes,
                    totalBytes: space.totalBytes,
                    runsFull: space.otherData ? null : runsFull(today, space.freeBytes, forecast),
                  }
                : null,
          };
        });
        break;
      case "retention":
        widgets.retention = widget([facts], () => {
          const { rows, activeHolds, snapshots, lastRun } = value(facts).retention;
          return { ...summarizeRetention(rows), activeHolds, snapshots, lastRun };
        });
        break;
      case "recentJobs":
        widgets.recentJobs = widget([sources.jobs], () => value(sources.jobs));
        break;
    }
  }
  return widgets;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Refuse the provider view to anyone but a provider admin, and while `dashboard.allTenants` is off. */
export async function assertProviderView(
  viewer: DashboardViewer,
  installation: Database,
): Promise<void> {
  if (!viewer.isProviderAdmin) {
    throw new ProblemError(403, "Provider admin required", {
      detail: "Only provider administrators may see the provider view.",
    });
  }
  if (viewer.providerAllTenants === false) {
    throw new ProblemError(403, "Every tenant required", {
      detail:
        "The provider view covers every tenant; your role in the provider team is limited to some.",
    });
  }
  await requireFeature("dashboard.allTenants", installation);
}

export async function loadDashboard(
  deps: DashboardDeps,
  viewer: DashboardViewer,
  query: DashboardQuery,
): Promise<DashboardDto> {
  const now = deps.now();
  if (query.provider) {
    await assertProviderView(viewer, deps.providerDb);
  }

  const canAdminister = isTenantAdmin(viewer.role);
  // `provider=only` reads no tenant widget at all; `widgets=` narrows to the ones asked for.
  const wanted = query.tenantWidgets
    ? widgetsFor(canAdminister).filter((id) => query.widgets === null || query.widgets.includes(id))
    : [];
  const needs = (...ids: TenantWidgetId[]) => ids.some((id) => wanted.includes(id));
  const tenantId = viewer.tenant.id;
  const load = <T>(source: string, needed: boolean, run: () => Promise<T>) =>
    needed ? settle(source, tenantId, run) : Promise.resolve(NOT_NEEDED as Settled<T>);

  const storageDays = query.storageDays ?? STORAGE_DEFAULT_DAYS;
  const readUsage = usageReader(deps.providerDb);
  const [
    summary,
    facts,
    mail,
    trends,
    storageHistory,
    capacity,
    systemDisk,
    jobs,
    mailboxes,
    endpoints,
    stale,
    guests,
    shares,
    running,
  ] = await Promise.all([
    load("summary", needs("lastBackup", "readiness", "protectedObjects", "storage"), async () => {
      const { summary: tenantSummary, readiness } = await loadTenantSummaryWithReadiness(
        deps.db,
        tenantId,
        now,
      );
      return { ...tenantSummary, readiness };
    }),
    load("facts", needs("setup", "lastBackup", "storage", "retention"), async () => {
      // The installation's own test of the default storage counts for every tenant on the default.
      // It lives in the installation chain; if that cannot be read the storage reads as untested
      // (as it did before that test existed) and every other fact still shows.
      const installationTest = await settle("default-storage-test", tenantId, () =>
        loadInstallationDefaultTest(deps.providerDb),
      );
      return loadTenantFacts(
        deps.db,
        tenantId,
        deps.env,
        installationTest.ok ? installationTest.value : null,
        deps.defaultStorageConfigured ? await deps.defaultStorageConfigured() : undefined,
      );
    }),
    load("mail", needs("setup"), () => loadMailFacts(deps.providerDb)),
    load("trends", needs("backupTrend", "verificationHistory"), () =>
      loadTenantTrends(deps.db, tenantId, now),
    ),
    load("storage-growth", needs("storageGrowth"), () =>
      loadStorageHistory(deps.db, tenantId, now, storageDays),
    ),
    load("storage-capacity", needs("storageGrowth"), () => loadStorageCapacity(deps, tenantId)),
    load("system-disk", needs("storage"), async () =>
      loadSystemDiskWarning({
        facts: await loadStorageCapacityFacts(deps.db, tenantId),
        installationDefault: await defaultLocation(deps),
        providerDb: deps.providerDb,
        isProviderAdmin: viewer.isProviderAdmin,
        now,
        systemDisk: deps.systemDisk,
      }),
    ),
    load("jobs", needs("recentJobs"), () => loadRecentJobs(deps.db, tenantId, now)),
    load("mailboxes", needs("mailboxUsage"), () => loadMailboxUsage(deps, viewer, readUsage)),
    // Its own source: a failing endpoint query fails this card only.
    // The last-backup card and the protected-objects tile count the machines as well.
    load("endpoints", needs("endpoints", "lastBackup", "protectedObjects"), () =>
      loadEndpointsWidget(deps.db, tenantId, now),
    ),
    load("stale", needs("lastBackup"), () => loadStaleThresholds(deps.db, tenantId, now)),
    // VMs and containers of Proxmox VE, counted next to the machines.
    load("guests", needs("lastBackup", "protectedObjects"), () =>
      loadGuestCounts(deps.db, tenantId, now),
    ),
    // File shares (docs/FILESHARES.md 13), counted next to the guests.
    load("shares", needs("lastBackup", "protectedObjects"), () =>
      loadShareCounts(deps.db, tenantId, now),
    ),
    // What runs right now (the live channel keeps it current once the page is open).
    load("running", needs("running"), () => loadRunning(deps.db, tenantId, now)),
  ]);

  let provider: DashboardDto["provider"] = null;
  if (query.provider) {
    // The cross-tenant matrix is an extension (ee/api); without it the
    // provider view is reported as unavailable, like a failed source.
    const loader = featureHook("providerDashboard");
    const view: Settled<ProviderViewDto> = loader
      ? await settle("provider", null, async () =>
          loader.load({ db: deps.db, now, tenants: await readUsage(), settle }),
        )
      : { ok: false };
    provider = view.ok ? { state: "ok", data: view.value } : { state: "error" };
  }

  const { tenant } = viewer;
  return {
    generatedAt: now.toISOString(),
    viewer: { role: viewer.role, isProviderAdmin: viewer.isProviderAdmin, canAdminister },
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status },
    widgets: buildWidgets(
      wanted,
      {
        summary,
        facts,
        mail,
        trends,
        storageHistory,
        capacity,
        systemDisk,
        jobs,
        mailboxes,
        endpoints,
        stale,
        guests,
        shares,
        running,
      },
      viewer,
      now,
      query.forecastDays ?? storageDays,
    ),
    provider,
  };
}
