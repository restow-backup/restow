import { endpointRuns, jobs, storageTargets, tenants } from "@restow/db";
import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { providerDb } from "../../db.js";
import { audit } from "../../lib/audit.js";
import { currentInstallationDefault } from "../../lib/installation-default.js";
import { mounterClientFromEnv } from "./mounter-client.js";
import { type ActiveWork, type MountUser, MountsService, liesOn } from "./service.js";

/** Endpoint runs older than this that still say "running" are stale, not running. */
const ENDPOINT_RUN_STALE_MS = 24 * 60 * 60 * 1000;

/** Jobs and endpoint runs that use storage right now, across every tenant (installation pool). */
export async function activeWork(): Promise<ActiveWork> {
  const [jobRow] = await providerDb
    .select({ value: count() })
    .from(jobs)
    .where(inArray(jobs.status, ["active"]));
  const [runRow] = await providerDb
    .select({ value: count() })
    .from(endpointRuns)
    .where(
      and(
        eq(endpointRuns.status, "running"),
        gt(endpointRuns.startedAt, new Date(Date.now() - ENDPOINT_RUN_STALE_MS)),
      ),
    );
  return { jobs: Number(jobRow?.value ?? 0), endpointRuns: Number(runRow?.value ?? 0) };
}

/** Storage targets of any tenant (any role, also retired ones) and the installation default on `path`. */
export async function usersOf(path: string): Promise<MountUser[]> {
  const rows = await providerDb
    .select({
      tenantId: storageTargets.tenantId,
      tenantName: tenants.name,
      name: storageTargets.name,
      basePath: sql<string | null>`${storageTargets.config}->>'basePath'`,
    })
    .from(storageTargets)
    .innerJoin(tenants, eq(tenants.id, storageTargets.tenantId))
    .where(
      and(
        eq(storageTargets.kind, "local"),
        sql`(${storageTargets.config}->>'basePath' = ${path} or ${storageTargets.config}->>'basePath' like ${`${path}/%`})`,
      ),
    );
  const users: MountUser[] = rows.map((row) => ({
    kind: "target",
    tenantId: row.tenantId,
    tenantName: row.tenantName,
    name: row.name,
    path: row.basePath ?? path,
  }));
  const fallback = await currentInstallationDefault().catch(() => null);
  for (const location of [fallback?.primary, fallback?.copy]) {
    if (location?.kind === "local" && liesOn(location.basePath, path)) {
      users.push({
        kind: "installation_default",
        tenantId: null,
        tenantName: null,
        name: null,
        path: location.basePath,
      });
    }
  }
  return users;
}

/** The process-wide service, on the installation pool. */
export const mountsService = new MountsService({
  client: mounterClientFromEnv(process.env, config.demo.enabled),
  activeWork,
  usersOf,
  audit: async (event) => {
    await audit(providerDb, event);
  },
  demo: config.demo.enabled,
});
