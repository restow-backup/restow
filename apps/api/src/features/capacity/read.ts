import { type FileShareSettings, fileShareSettingsOf } from "@restow/core";
import {
  type Database,
  endpoints,
  fileShares,
  packs,
  pveGuests,
  settings,
  storageSamples,
  storageTargets,
} from "@restow/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import type { DayTotal } from "../dashboard/growth.js";
import { utcDay } from "../stats/period.js";
import { loadRepositoryBytes, type RepositoryBytes } from "../storage/repository-bytes.js";
import { GROWTH_HORIZONS, type PackFacts } from "./math.js";
import type { MachineQuotaRow, ShareQuotaRow } from "./quota.js";

/**
 * What the capacity page reads of one tenant, inside its pinned transaction (Row Level Security):
 * the sums of its packs and repositories, the size samples, the rows its quotas are judged by.
 * Tenant by tenant, a fixed number of aggregate queries whatever the number of objects.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Sample days read: the longest growth horizon plus room for a reference day before it. */
const SAMPLE_READ_DAYS = 100;
/** The repositories listed for one tenant, largest first; the rest are counted. */
export const REPOSITORY_LIST_LIMIT = 200;

export interface TenantReading {
  repositories: RepositoryBytes;
  counts: { machines: number; fileShares: number; guests: number };
  packs: PackFacts;
  /** The tenant's size samples per day (chunk store and repositories added up), oldest first. */
  samples: DayTotal[];
  machineQuotaRows: MachineQuotaRow[];
  shareQuotaRows: ShareQuotaRow[];
}

/** The pack sums: now, and at the end of the days 7, 30 and 90 days ago, with the first write. */
async function readPacks(tx: Transaction, tenantId: string, now: Date): Promise<PackFacts> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // Everything written before the day after `days` days ago began, i.e. until the end of that day.
  const until = (days: number) => {
    const end = new Date(today - days * DAY_MS + DAY_MS).toISOString();
    return sql<number>`coalesce(sum(${packs.size}) filter (where ${packs.createdAt} < ${end}), 0)`.mapWith(
      Number,
    );
  };
  const [row] = await tx
    .select({
      total: sql<number>`coalesce(sum(${packs.size}), 0)`.mapWith(Number),
      first: sql<Date | null>`min(${packs.createdAt})`.mapWith(packs.createdAt),
      at7: until(GROWTH_HORIZONS[0]),
      at30: until(GROWTH_HORIZONS[1]),
      at90: until(GROWTH_HORIZONS[2]),
    })
    .from(packs)
    .where(eq(packs.tenantId, tenantId));
  const first = row?.first && !Number.isNaN(row.first.getTime()) ? row.first : null;
  return {
    firstWriteAt: first,
    totalBytes: row?.total ?? 0,
    bytesAtHorizons: [row?.at7 ?? 0, row?.at30 ?? 0, row?.at90 ?? 0],
  };
}

/** The tenant's samples of the last {@link SAMPLE_READ_DAYS} days, added up per day. */
async function readSamples(tx: Transaction, tenantId: string, now: Date): Promise<DayTotal[]> {
  const since = utcDay(new Date(now.getTime() - SAMPLE_READ_DAYS * DAY_MS));
  const rows = await tx
    .select({
      day: sql<string>`${storageSamples.day}::text`,
      bytes: sql<number>`sum(${storageSamples.bytes})`.mapWith(Number),
    })
    .from(storageSamples)
    .where(and(eq(storageSamples.tenantId, tenantId), sql`${storageSamples.day} >= ${since}`))
    .groupBy(storageSamples.day)
    .orderBy(storageSamples.day);
  return rows.map((row) => ({ date: row.day, bytes: row.bytes }));
}

export async function readTenant(
  db: Database,
  tenantId: string,
  now: Date,
): Promise<TenantReading> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [packFacts, repositories, samples] = [
      await readPacks(tx, tenantId, now),
      await loadRepositoryBytes(tx, tenantId),
      await readSamples(tx, tenantId, now),
    ];
    // Removed machines still keep their repository until it is deleted; they have no budget.
    const machineRows = await tx
      .select({
        settings: endpoints.settings,
        repositoryBytes: endpoints.repositoryBytes,
        repositoryMeasuredAt: endpoints.repositoryMeasuredAt,
        quotaRefusedAt: endpoints.quotaRefusedAt,
        removed: sql<boolean>`${endpoints.removedAt} is not null`,
      })
      .from(endpoints)
      .where(eq(endpoints.tenantId, tenantId));
    const shareRows = await tx
      .select({ repositoryBytes: fileShares.repositoryBytes, quotaGib: fileShares.quotaGib })
      .from(fileShares)
      .where(eq(fileShares.tenantId, tenantId));
    const [guests] = await tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(pveGuests)
      .where(eq(pveGuests.tenantId, tenantId));
    return {
      repositories,
      counts: {
        machines: machineRows.length,
        fileShares: shareRows.length,
        guests: guests?.n ?? 0,
      },
      packs: packFacts,
      samples,
      machineQuotaRows: machineRows.filter((row) => !row.removed),
      shareQuotaRows: shareRows,
    };
  });
}

/** The installation's file share budgets (installation pool). */
export async function loadFileShareSettings(providerDb: Database): Promise<FileShareSettings> {
  const [row] = await providerDb
    .select({ fileShareSettings: settings.fileShareSettings })
    .from(settings)
    .limit(1);
  return fileShareSettingsOf(row?.fileShareSettings ?? {});
}

// ---------------------------------------------------------------------------
// One tenant's repositories
// ---------------------------------------------------------------------------

export interface MachineRow {
  id: string;
  hostname: string;
  displayName: string | null;
  settings: MachineQuotaRow["settings"];
  repositoryBytes: number | null;
}

export interface ShareRow {
  id: string;
  name: string;
  repositoryBytes: number | null;
  quotaGib: number | null;
}

export interface GuestRow {
  id: string;
  name: string | null;
  vmid: number;
  repositoryBytes: number | null;
}

export interface TargetRow {
  id: string;
  name: string | null;
  role: "primary" | "copy";
  kind: "local" | "s3" | "installation_default";
  status: string;
  bytesUsed: number;
}

export interface TenantRepositories {
  targets: TargetRow[];
  hasPrimaryTarget: boolean;
  machines: MachineRow[];
  fileShares: ShareRow[];
  guests: GuestRow[];
  /** All repositories of each kind, listed or not. */
  totals: { machines: number; fileShares: number; guests: number };
  /** The samples of the listed repositories: `sourceId` -> totals, oldest first. */
  samples: Map<string, DayTotal[]>;
}

/** The largest repositories of a tenant (at most {@link REPOSITORY_LIST_LIMIT} per kind) with their samples. */
export async function readRepositories(
  db: Database,
  tenantId: string,
  now: Date,
): Promise<TenantRepositories> {
  return withTenantTx(db, tenantId, async (tx) => {
    const targets = await tx
      .select({
        id: storageTargets.id,
        name: storageTargets.name,
        role: storageTargets.role,
        kind: storageTargets.kind,
        status: storageTargets.status,
        bytesUsed: storageTargets.bytesUsed,
      })
      .from(storageTargets)
      .where(
        and(
          eq(storageTargets.tenantId, tenantId),
          or(eq(storageTargets.role, "primary"), eq(storageTargets.role, "copy")),
        ),
      )
      .orderBy(storageTargets.role, storageTargets.createdAt);
    const machines = await tx
      .select({
        id: endpoints.id,
        hostname: endpoints.hostname,
        displayName: endpoints.displayName,
        settings: endpoints.settings,
        repositoryBytes: endpoints.repositoryBytes,
      })
      .from(endpoints)
      .where(and(eq(endpoints.tenantId, tenantId), isNull(endpoints.removedAt)))
      .orderBy(sql`${endpoints.repositoryBytes} desc nulls last`, endpoints.hostname)
      .limit(REPOSITORY_LIST_LIMIT);
    const shares = await tx
      .select({
        id: fileShares.id,
        name: fileShares.name,
        repositoryBytes: fileShares.repositoryBytes,
        quotaGib: fileShares.quotaGib,
      })
      .from(fileShares)
      .where(eq(fileShares.tenantId, tenantId))
      .orderBy(sql`${fileShares.repositoryBytes} desc nulls last`, fileShares.name)
      .limit(REPOSITORY_LIST_LIMIT);
    const guests = await tx
      .select({
        id: pveGuests.id,
        name: pveGuests.name,
        vmid: pveGuests.vmid,
        repositoryBytes: pveGuests.repositoryBytes,
      })
      .from(pveGuests)
      .where(eq(pveGuests.tenantId, tenantId))
      .orderBy(sql`${pveGuests.repositoryBytes} desc nulls last`, pveGuests.vmid)
      .limit(REPOSITORY_LIST_LIMIT);
    const result = await tx.execute(sql`
      select
        (select count(*)::int from ${endpoints}
          where ${endpoints.tenantId} = ${tenantId} and ${endpoints.removedAt} is null) as machines,
        (select count(*)::int from ${fileShares} where ${fileShares.tenantId} = ${tenantId}) as file_shares,
        (select count(*)::int from ${pveGuests} where ${pveGuests.tenantId} = ${tenantId}) as guests`);
    const counted = (result.rows[0] ?? {}) as Record<string, number>;

    const ids = [...machines, ...shares, ...guests].map((row) => row.id);
    const since = utcDay(new Date(now.getTime() - SAMPLE_READ_DAYS * DAY_MS));
    const sampleRows =
      ids.length === 0
        ? []
        : await tx
            .select({
              sourceId: storageSamples.sourceId,
              day: sql<string>`${storageSamples.day}::text`,
              bytes: storageSamples.bytes,
            })
            .from(storageSamples)
            .where(
              and(
                eq(storageSamples.tenantId, tenantId),
                inArray(storageSamples.sourceId, ids),
                sql`${storageSamples.day} >= ${since}`,
              ),
            )
            .orderBy(storageSamples.day);
    const samples = new Map<string, DayTotal[]>();
    for (const row of sampleRows) {
      if (row.sourceId) {
        const list = samples.get(row.sourceId) ?? [];
        list.push({ date: row.day, bytes: row.bytes });
        samples.set(row.sourceId, list);
      }
    }
    return {
      targets: targets.map((target) => ({
        id: target.id,
        name: target.name,
        role: target.role as "primary" | "copy",
        kind: target.kind,
        status: target.status,
        bytesUsed: target.bytesUsed,
      })),
      hasPrimaryTarget: targets.some((target) => target.role === "primary"),
      machines,
      fileShares: shares,
      guests,
      totals: {
        machines: Number(counted.machines ?? 0),
        fileShares: Number(counted.file_shares ?? 0),
        guests: Number(counted.guests ?? 0),
      },
      samples,
    };
  });
}
