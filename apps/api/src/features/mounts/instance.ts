import { access } from "node:fs/promises";
import * as path from "node:path";
import { endpointRuns, jobs, storageTargets, tenants } from "@restow/db";
import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { providerDb } from "../../db.js";
import { audit } from "../../lib/audit.js";
import { currentInstallationDefault } from "../../lib/installation-default.js";
import { updaterClient } from "../updates/instance.js";
import { DEFAULT_MOUNTER_SECRET_FILE, mounterClientFromEnv } from "./mounter-client.js";
import { secretPendingMountStore } from "./pending.js";
import {
  type ActiveWork,
  type ComposeFacts,
  liesOn,
  MountsService,
  type MountUser,
} from "./service.js";

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

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the api knows about its compose project, for the commands of the Mounts section.
 * The directory: RESTOW_PROJECT_DIR (the installer writes it into .env, which the api
 * reads), else what the opt-in updater reports. Whether the compose file defines the
 * mounter: the updater reads the configuration; without it, a containerized api that has
 * no mounter volume (every compose file with the mounter mounts it into the api) was
 * started from a compose file without the mounter.
 */
export async function composeFacts(
  env: Record<string, string | undefined> = process.env,
): Promise<ComposeFacts> {
  const capabilities = (await updaterClient.state().catch(() => null))?.capabilities ?? null;
  const projectDir = env.RESTOW_PROJECT_DIR?.trim() || capabilities?.projectDir || null;
  let mounterService = capabilities?.mounterService ?? null;
  if (mounterService === null) {
    const secretDir = path.dirname(
      env.RESTOW_MOUNTER_SECRET_FILE?.trim() || DEFAULT_MOUNTER_SECRET_FILE,
    );
    if ((await exists("/.dockerenv")) && !(await exists(secretDir))) {
      mounterService = false;
    }
  }
  return { projectDir, mounterService };
}

/** The process-wide service, on the installation pool. */
export const mountsService = new MountsService({
  client: mounterClientFromEnv(process.env, config.demo.enabled),
  pending: secretPendingMountStore(providerDb),
  activeWork,
  usersOf,
  audit: async (event) => {
    await audit(providerDb, event);
  },
  compose: () => composeFacts(),
  version: process.env.RESTOW_VERSION?.trim() || null,
  demo: config.demo.enabled,
  updater: updaterClient,
});
