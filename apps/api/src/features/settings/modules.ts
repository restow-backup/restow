import {
  archiveItems,
  backupJobs,
  type Database,
  endpoints,
  fileShares,
  protectedObjects,
  pveGuests,
  pveJobs,
  pveNodes,
  settings,
  sources,
  tenants,
} from "@restow/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../../lib/audit.js";
import {
  enabledModules,
  enabledModulesSchema,
  MODULE_IDS,
  type ModuleId,
  storedModules,
} from "../../lib/modules.js";
import type { DbExecutor } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";

/**
 * The installation's modules (lib/modules.ts): which of them are on, and what each still holds.
 *
 *   GET /api/v1/settings/modules   every module with `enabled` and its data across all tenants
 *   PUT /api/v1/settings/modules   `{ enabled: [...] }` replaces the modules that are on; at
 *                                   least one (422 otherwise); audited in the installation chain
 *
 * Every provider admin with every tenant reads, owners and administrators change
 * (lib/provider-access.ts). The counts say what a module that is off still has: switching a
 * module off hides it in the web interface and touches nothing else, so its connections, jobs,
 * machines and guests are still there, still run, and stay reachable by their address. The
 * modules that are on also travel with `/api/v1/me`, so the menu needs no request of its own.
 */

export const MODULES_AUDIT_ACTIONS = { updated: "settings.modules.updated" } as const;

export const modulesSchema = z.object({ enabled: enabledModulesSchema }).strict();

/**
 * What a module holds, by kind. Each is counted across every tenant and listed only while it is
 * above zero:
 *
 *   connections    sources of the module's kind (Microsoft 365, IMAP)
 *   objects        protected objects of those sources that are not orphaned
 *   archivingJobs  mail jobs that archive
 *   archives       tenants whose archive holds mail
 *   machines       servers and clients that were not removed
 *   fileShares     file shares that are not retired
 *   jobs           jobs of the module (machines, file shares and copies; Proxmox VE)
 *   nodes          Proxmox VE nodes
 *   guests         VMs and containers that are not retired
 */
export const MODULE_DATA_KINDS = [
  "connections",
  "objects",
  "archivingJobs",
  "archives",
  "machines",
  "fileShares",
  "jobs",
  "nodes",
  "guests",
] as const;
export type ModuleDataKind = (typeof MODULE_DATA_KINDS)[number];

export interface ModuleDataCount {
  kind: ModuleDataKind;
  count: number;
}

export interface ModuleDto {
  id: ModuleId;
  enabled: boolean;
  /** What the module holds across every tenant; empty when it holds nothing. */
  data: ModuleDataCount[];
}

export interface ModulesDto {
  modules: ModuleDto[];
}

/** The modules that are on (lib/modules.ts `enabledModules`); every module before the setup. */
export async function loadEnabledModules(db: DbExecutor): Promise<ModuleId[]> {
  const [row] = await db.select({ value: settings.modules }).from(settings).limit(1);
  return enabledModules(row?.value);
}

const count = sql<number>`count(*)::int`;

/** One count of a table across every tenant (the installation pool reads past Row Level Security). */
async function countOf(query: Promise<{ count: number }[]>): Promise<number> {
  const [row] = await query;
  return Number(row?.count ?? 0);
}

/** What each module holds, across every tenant; a handful of counts, asked side by side. */
async function moduleData(db: DbExecutor): Promise<Record<ModuleId, ModuleDataCount[]>> {
  const sourcesOf = (kind: "m365" | "imap") =>
    countOf(db.select({ count }).from(sources).where(eq(sources.kind, kind)));
  const objectsOf = (kind: "m365" | "imap") =>
    countOf(
      db
        .select({ count })
        .from(protectedObjects)
        .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
        .where(sql`${sources.kind} = ${kind} and ${protectedObjects.status} <> 'orphaned'`),
    );
  const [
    m365Connections,
    m365Objects,
    imapConnections,
    imapObjects,
    archivingJobs,
    archives,
    machines,
    shares,
    machineJobs,
    nodes,
    guests,
    guestJobs,
  ] = await Promise.all([
    sourcesOf("m365"),
    objectsOf("m365"),
    sourcesOf("imap"),
    objectsOf("imap"),
    countOf(
      db
        .select({ count })
        .from(backupJobs)
        .where(sql`${backupJobs.kind} = 'mail' and ${backupJobs.archive}`),
    ),
    // One index probe per tenant, never a scan of the archive.
    countOf(
      db
        .select({ count })
        .from(tenants)
        .where(
          sql`exists (select 1 from ${archiveItems} where ${archiveItems.tenantId} = ${tenants.id})`,
        ),
    ),
    countOf(db.select({ count }).from(endpoints).where(sql`${endpoints.removedAt} is null`)),
    countOf(db.select({ count }).from(fileShares).where(sql`${fileShares.retiredAt} is null`)),
    countOf(
      db
        .select({ count })
        .from(backupJobs)
        .where(sql`${backupJobs.kind} in ('endpoint', 'share', 'copy')`),
    ),
    countOf(db.select({ count }).from(pveNodes)),
    countOf(db.select({ count }).from(pveGuests).where(sql`${pveGuests.retiredAt} is null`)),
    countOf(db.select({ count }).from(pveJobs)),
  ]);
  const held = (entries: [ModuleDataKind, number][]): ModuleDataCount[] =>
    entries.filter(([, value]) => value > 0).map(([kind, value]) => ({ kind, count: value }));
  return {
    microsoft365: held([
      ["connections", m365Connections],
      ["objects", m365Objects],
    ]),
    imap: held([
      ["connections", imapConnections],
      ["objects", imapObjects],
    ]),
    archive: held([
      ["archivingJobs", archivingJobs],
      ["archives", archives],
    ]),
    endpoints: held([
      ["machines", machines],
      ["fileShares", shares],
      ["jobs", machineJobs],
    ]),
    pve: held([
      ["nodes", nodes],
      ["guests", guests],
      ["jobs", guestJobs],
    ]),
  };
}

function toDto(enabled: readonly ModuleId[], data: Record<ModuleId, ModuleDataCount[]>) {
  return {
    modules: MODULE_IDS.map((id) => ({ id, enabled: enabled.includes(id), data: data[id] })),
  } satisfies ModulesDto;
}

export async function getModules(db: DbExecutor): Promise<ModulesDto> {
  const [enabled, data] = await Promise.all([loadEnabledModules(db), moduleData(db)]);
  return toDto(enabled, data);
}

/**
 * Replace the modules that are on. Nothing but the settings row changes: no data is deleted and
 * no job is stopped. A request that changes nothing writes no audit entry.
 */
export async function updateModules(
  db: Database,
  input: z.infer<typeof modulesSchema>,
  actor: { id: string; email: string; ip: string | null },
): Promise<ModulesDto> {
  const enabled = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).limit(1).for("update");
    if (!row) {
      throw new ProblemError(409, "Setup not completed", {
        type: "urn:restow:problem:setup-incomplete",
        detail: "Finish the setup wizard before changing installation settings.",
      });
    }
    const before = enabledModules(row.modules);
    const after = input.enabled;
    const switchedOn = after.filter((id) => !before.includes(id));
    const switchedOff = before.filter((id) => !after.includes(id));
    if (switchedOn.length === 0 && switchedOff.length === 0) {
      return before;
    }
    await tx
      .update(settings)
      .set({ modules: storedModules(after) })
      .where(eq(settings.id, row.id));
    await audit(tx, {
      actor: actor.email,
      actorUserId: actor.id,
      action: MODULES_AUDIT_ACTIONS.updated,
      target: row.id,
      targetType: "settings",
      ip: actor.ip,
      details: { before, after, switchedOn, switchedOff },
    });
    return after;
  });
  return toDto(enabled, await moduleData(db));
}
