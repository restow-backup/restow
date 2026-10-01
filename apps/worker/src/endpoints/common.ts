/**
 * What the endpoint jobs share (docs/AGENT.md): opening an endpoint's
 * repository from the worker and writing reports.
 *
 * The worker reads the repository password the API sealed with the tenant key
 * (`PgSecretReader`) and reaches the repository through the tenant's primary
 * storage target and a loopback listener that lives for one operation
 * (@restow/core `withRepository`); the credential of that listener is random
 * per operation and never leaves the process.
 */
import { type RepositoryAccess, endpointPrefix, resticBinary, resticCacheBase } from "@restow/core";
import {
  type Database,
  type Endpoint,
  type NewEndpointReport,
  type RepositoryLockMode,
  endpointReports,
  endpoints,
  withEndpointRepositoryLock,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import {
  PgSecretReader,
  type WorkerRuntime,
  tenantRunner,
  withTenantTx,
} from "../handlers/framework.js";

export interface EndpointJobDeps {
  /** The application role (Row Level Security). */
  readonly db: Database;
  /** The installation role, for scans across tenants. */
  readonly providerDb: Database;
  readonly runtime: Pick<
    WorkerRuntime,
    "keyrings" | "storage" | "logger" | "now" | "shutdownSignal"
  >;
  /** How long a job waits for other work on the same repository (tests shorten it). */
  readonly maintenanceLockWaitMs?: number;
}

/** How long a job waits for another job on the same repository before it is retried later. */
export const MAINTENANCE_LOCK_WAIT_MS = 60_000;

/**
 * Run `work` while no other server work runs on the endpoint's repository
 * (@restow/db `withEndpointRepositoryLock`): retention and the check hold it
 * exclusively, the restore test shares it with the API's reads. A job that
 * does not get it in time fails with `EndpointRepositoryBusyError` and is
 * retried later; it rates nothing and writes no report.
 */
export function withMaintenanceLock<T>(
  deps: EndpointJobDeps,
  endpointId: string,
  mode: RepositoryLockMode,
  work: () => Promise<T>,
): Promise<T> {
  return withEndpointRepositoryLock(
    deps.db.$client,
    endpointId,
    { mode, waitMs: deps.maintenanceLockWaitMs ?? MAINTENANCE_LOCK_WAIT_MS, pollMs: 1000 },
    work,
  );
}

export class EndpointGoneError extends Error {
  constructor(endpointId: string) {
    super(`endpoint ${endpointId} does not exist or has no repository`);
    this.name = "EndpointGoneError";
  }
}

export async function loadEndpoint(
  deps: EndpointJobDeps,
  tenantId: string,
  endpointId: string,
): Promise<Endpoint | null> {
  return withTenantTx(deps.db, tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(endpoints)
      .where(and(eq(endpoints.tenantId, tenantId), eq(endpoints.id, endpointId)))
      .limit(1);
    return row ?? null;
  });
}

/** The endpoint and what restic needs to open its repository. */
export async function openEndpointRepository(
  deps: EndpointJobDeps,
  tenantId: string,
  endpointId: string,
): Promise<{ endpoint: Endpoint; access: RepositoryAccess }> {
  const endpoint = await loadEndpoint(deps, tenantId, endpointId);
  if (!endpoint?.repositorySecretId) {
    throw new EndpointGoneError(endpointId);
  }
  const keys = await deps.runtime.keyrings.get(tenantId);
  const password = await new PgSecretReader(tenantRunner(deps.db, tenantId), tenantId, keys).get(
    endpoint.repositorySecretId,
  );
  if (password === null) {
    throw new EndpointGoneError(endpointId);
  }
  const targets = await deps.runtime.storage.get(tenantId);
  return {
    endpoint,
    access: {
      storage: targets.primary,
      prefix: endpointPrefix(endpointId),
      repositoryPassword: password,
      endpointId,
      binary: resticBinary(),
      cacheBase: resticCacheBase(),
    },
  };
}

/** Write a report of the server's own work on an endpoint. */
export async function writeReport(
  deps: EndpointJobDeps,
  tenantId: string,
  report: Omit<NewEndpointReport, "tenantId" | "checkedAt">,
  now: Date,
): Promise<void> {
  await withTenantTx(deps.db, tenantId, async (tx) => {
    await tx.insert(endpointReports).values({ ...report, tenantId, checkedAt: now });
  });
}

/** A message safe to store and show: one line, no credentials, bounded. */
export function reportableMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 500);
}
