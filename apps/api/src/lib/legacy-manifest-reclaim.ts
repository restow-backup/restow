import { createDb } from "@restow/db";
import {
  LEGACY_RECLAIM_MIN_BYTES,
  MIGRATION_URL_VARIABLE,
  legacyManifestBytes,
  reclaimLegacyManifestSpace,
} from "@restow/db/migrate";

/**
 * Give the disk space of the 0.3.4 manifest mirror back while the api runs.
 *
 * The worker folds `manifest_objects` into `manifest_versions` in the
 * background (apps/worker manifest-conversion.ts) and deletes the old rows as
 * it goes, but Postgres keeps their pages until the table is truncated or a
 * VACUUM gets to them, and only the table's owner may TRUNCATE. The migration
 * step at every api start does that (@restow/db migrate.ts
 * `reclaimLegacyManifestSpace`); this loop does the same later on, so the
 * space comes back once the conversion has finished, without a restart.
 *
 * Every attempt first asks the installation pool how large the old table is,
 * which reads no row and needs no privilege on it. Only when it is large
 * enough to matter does it open one short-lived connection as the owner
 * (DATABASE_MIGRATION_URL, the connection the migration step of this same
 * container used), run the bounded reclaim and close it again: no role gets a
 * new privilege, and no owner connection stays open. The loop ends for good
 * once the table is gone or small (the old table never grows again; nothing
 * writes to it since 0.3.5), and without an owner connection string it never
 * starts.
 */

/** How often a running api tries again while the old table is large. */
export const LEGACY_RECLAIM_INTERVAL_MS = 15 * 60 * 1000;

/** The first attempt, a little after the start (the migration step has just tried). */
const FIRST_ATTEMPT_MS = 5 * 60 * 1000;

export interface LegacyReclaimDeps {
  /** The size of the old table in bytes, or null when it does not exist (installation pool). */
  probe: () => Promise<number | null>;
  /** Truncate the old table when it is empty; true when it did (owner connection). */
  reclaim: () => Promise<boolean>;
  log: (level: "info" | "warn", message: string, fields?: object) => void;
  minBytes?: number;
  intervalMs?: number;
  firstAttemptMs?: number;
}

export type ReclaimOutcome = "reclaimed" | "nothing_to_do" | "retry";

/** One attempt. Never throws: a failure is reported and tried again later. */
export async function attemptLegacyReclaim(deps: LegacyReclaimDeps): Promise<ReclaimOutcome> {
  const minBytes = deps.minBytes ?? LEGACY_RECLAIM_MIN_BYTES;
  try {
    const bytes = await deps.probe();
    if (bytes === null || bytes < minBytes) {
      return "nothing_to_do";
    }
    if (await deps.reclaim()) {
      deps.log("info", "the old manifest table was emptied and its disk space given back", {
        bytes,
      });
      return "reclaimed";
    }
    // Rows are left (the conversion runs) or the table was busy: try again later.
    return "retry";
  } catch (error) {
    deps.log("warn", "giving back the old manifest table's disk space failed; trying again later", {
      reason: error instanceof Error ? error.name : "unknown error",
    });
    return "retry";
  }
}

/** Start the loop; returns a stop function. The timers never keep the process alive. */
export function startLegacyManifestReclaim(deps: LegacyReclaimDeps): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const schedule = (ms: number) => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => void tick(), ms);
    timer.unref();
  };
  const tick = async () => {
    const outcome = await attemptLegacyReclaim(deps);
    if (outcome === "retry") {
      schedule(deps.intervalMs ?? LEGACY_RECLAIM_INTERVAL_MS);
    }
  };
  schedule(deps.firstAttemptMs ?? FIRST_ATTEMPT_MS);
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}

interface ProbePool {
  query<R extends Record<string, unknown>>(text: string): Promise<{ rows: R[] }>;
}

/**
 * The loop's dependencies from the process environment: the probe on the
 * installation pool, the reclaim on an owner pool opened for each attempt
 * (it uses one connection) and closed after it. Null when the process has no
 * owner connection string (a development server whose migrations run
 * separately).
 */
export function legacyReclaimFromEnvironment(
  installationPool: ProbePool,
  log: LegacyReclaimDeps["log"],
  env: Record<string, string | undefined> = process.env,
): LegacyReclaimDeps | null {
  const ownerUrl = env[MIGRATION_URL_VARIABLE]?.trim();
  if (!ownerUrl) {
    return null;
  }
  return {
    probe: () => legacyManifestBytes(installationPool),
    reclaim: async () => {
      const owner = createDb(ownerUrl).$client;
      try {
        return await reclaimLegacyManifestSpace(owner);
      } finally {
        await owner.end();
      }
    },
    log,
  };
}
