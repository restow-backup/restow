/**
 * `endpoint-check`: read a slice of an endpoint's repository back and verify
 * it (`restic check --read-data-subset`). Weekly, one twentieth of the data at
 * a time, in a fixed rotation, so the whole repository is verified over about
 * five months without ever reading all of it at once. A damaged repository
 * rates the endpoint red until a later check finds it whole (packages/core
 * `endpointReadiness`).
 *
 * A check that could not run (the repository was locked, restic was stopped
 * or could not start) is no check: `last_check_at` stays where it was, so the
 * scheduler offers it again, and a repository that stays locked is counted
 * and, in time, announced (./maintenance.ts).
 */
import {
  DEFAULT_CHECK_SUBSET_PERCENT,
  type EndpointJobPayload,
  type RepositoryAccess,
  ResticError,
  resticCheck,
  resticUnlock,
  withRepository,
} from "@restow/core";
import { endpoints } from "@restow/db";
import { eq } from "drizzle-orm";
import { withTenantTx } from "../handlers/framework.js";
import {
  type EndpointJobDeps,
  openEndpointRepository,
  reportableMessage,
  withMaintenanceLock,
  writeReport,
} from "./common.js";
import {
  clearLocksBeforeMaintenance,
  keepRepositoryPasswordFile,
  recordMaintenanceLocked,
  recordMaintenanceUnlocked,
} from "./maintenance.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The slice for this week: part `n` of `t`, `n` advancing weekly so every part is read in turn. */
export function checkSubset(now: Date, percent: number = DEFAULT_CHECK_SUBSET_PERCENT): string {
  const parts = Math.max(1, Math.round(100 / Math.min(100, Math.max(1, percent))));
  const week = Math.floor(now.getTime() / WEEK_MS);
  return `${(week % parts) + 1}/${parts}`;
}

export async function endpointCheck(
  deps: EndpointJobDeps,
  payload: EndpointJobPayload,
): Promise<void> {
  const { tenantId, endpointId } = payload;
  const { access } = await openEndpointRepository(deps, tenantId, endpointId);
  // Never beside retention or a restore test of the same repository.
  await withMaintenanceLock(deps, endpointId, "exclusive", () => check(deps, payload, access));
}

async function check(
  deps: EndpointJobDeps,
  payload: EndpointJobPayload,
  access: RepositoryAccess,
): Promise<void> {
  const { tenantId, endpointId } = payload;
  const { logger } = deps.runtime;
  const now = deps.runtime.now();
  const subset = checkSubset(now, payload.subsetPercent);
  await keepRepositoryPasswordFile(deps, tenantId, endpointId, access);
  const checked = () =>
    withTenantTx(deps.db, tenantId, (tx) =>
      tx.update(endpoints).set({ lastCheckAt: now }).where(eq(endpoints.id, endpointId)),
    );
  try {
    await clearLocksBeforeMaintenance(deps, tenantId, endpointId, access, now);
    await withRepository(access, async (session) => {
      await resticUnlock(session).catch(() => undefined);
      await resticCheck(session, subset, { signal: deps.runtime.shutdownSignal });
    });
    await recordMaintenanceUnlocked(deps, tenantId, endpointId);
    await writeReport(
      deps,
      tenantId,
      {
        endpointId,
        kind: "repository_check",
        origin: "server",
        readiness: "green",
        summary: { subset },
      },
      now,
    );
    await checked();
    logger.info("endpoint check passed", { tenantId, endpointId, subset });
  } catch (error) {
    if (error instanceof ResticError && error.failure === "locked") {
      await recordMaintenanceLocked(deps, tenantId, endpointId, "check", now);
      throw error;
    }
    if (
      error instanceof ResticError &&
      (error.failure === "interrupted" || error.failure === "killed")
    ) {
      // Stopped before it finished (a shutdown, a signal): no finding about the repository.
      logger.warn("endpoint check interrupted, it will retry", { tenantId, endpointId });
      throw error;
    }
    if (!(error instanceof ResticError)) {
      // restic could not even be started: not a finding about the repository.
      throw error;
    }
    await writeReport(
      deps,
      tenantId,
      {
        endpointId,
        kind: "repository_check",
        origin: "server",
        readiness: "red",
        summary: { subset, errorMessage: reportableMessage(error.stderr || error.message) },
      },
      now,
    );
    await recordMaintenanceUnlocked(deps, tenantId, endpointId);
    await checked();
    logger.error("endpoint check found problems", { tenantId, endpointId, subset });
  }
}
