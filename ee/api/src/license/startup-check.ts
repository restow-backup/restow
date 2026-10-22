import { pathToFileURL } from "node:url";
import { createDb } from "@restow/db";
import {
  decideStartup,
  type QueryRunner,
  readInstalledKeyRow,
  type StartupDecision,
} from "../../../licensing/src/index.js";

/**
 * The start check of the api against the installed licence key
 * (ee/licensing/src/startup-check.ts), as the program the api container runs
 * before the database migrations (Dockerfile `restow-entrypoint`):
 *
 *   node dist/ee/api/src/license/startup-check.js
 *
 * Exit code 0: start (and migrate); 1: this release is not covered by the
 * installed Business or Service Provider key and the api must not start. It
 * only reads the active `license` row (as the database owner,
 * DATABASE_MIGRATION_URL, the connection the migrations use next) and writes
 * nothing. The Community build has no ee/ and so no such file; the entrypoint
 * skips the check there.
 *
 * A failure to read the database never stops the start here: the migrations
 * that follow report an unreachable database themselves, and an unexpected
 * error must not keep an installation from starting.
 */

export const STARTUP_CHECK_DATABASE_ENV = "DATABASE_MIGRATION_URL";

type Log = (level: "info" | "warn" | "error", message: string, fields?: object) => void;

const defaultLog: Log = (level, message, fields = {}) => {
  const line = JSON.stringify({ level, component: "license", message, ...fields });
  if (level === "info") {
    console.log(line);
  } else {
    console.error(line);
  }
};

export interface StartupCheckDeps {
  /** Opens the connection the row is read with (tests pass a fake). */
  connect?: (url: string) => QueryRunner & { end(): Promise<void> };
  log?: Log;
}

function connectWithPool(url: string): QueryRunner & { end(): Promise<void> } {
  const pool = createDb(url).$client;
  return {
    query: async (text) => {
      const result = await pool.query(text);
      return { rows: result.rows as Array<Record<string, unknown>> };
    },
    end: () => pool.end(),
  };
}

/** Run the check; resolves to the process exit code. */
export async function runStartupLicenseCheck(
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: StartupCheckDeps = {},
): Promise<0 | 1> {
  const log = deps.log ?? defaultLog;
  const url = env[STARTUP_CHECK_DATABASE_ENV]?.trim();
  if (!url) {
    log("warn", `licence start check skipped: ${STARTUP_CHECK_DATABASE_ENV} is not set`);
    return 0;
  }
  let decision: StartupDecision;
  const db = (deps.connect ?? connectWithPool)(url);
  try {
    decision = decideStartup(await readInstalledKeyRow(db), env);
  } catch (error) {
    log("warn", "licence start check skipped: the installed licence could not be read", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return 0;
  } finally {
    await db.end().catch(() => undefined);
  }
  const fields = {
    version: env.RESTOW_VERSION?.trim() || null,
    releasedAt: env.RESTOW_RELEASED_AT?.trim() || null,
    updatesUntil: decision.entitlement.coveredUntil,
    series: decision.entitlement.series,
    reason: decision.entitlement.reason,
  };
  switch (decision.action) {
    case "start":
      return 0;
    case "community":
      log("warn", decision.message, fields);
      return 0;
    case "refuse":
      log("error", decision.message, fields);
      return 1;
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(await runStartupLicenseCheck());
}
