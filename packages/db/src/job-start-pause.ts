import type { Queryable } from "./roles.js";
import type { JobPauseMode, JobPausePhase } from "./schema/job-start-pause.js";

/**
 * Whether new job starts are paused for an update (`job_start_pause`, #46), as the
 * scheduler, the worker and the PVE node heartbeat ask it. Read on the installation
 * pool. A pause past its `expires_at` counts as lifted, whoever was meant to remove it,
 * and a database that has no such table yet (a process that started before the
 * migration ran) is not paused.
 */

export interface JobStartPauseState {
  readonly paused: boolean;
  /** Running worker jobs are to checkpoint and stop now (`drain` mode). */
  readonly drain: boolean;
  readonly mode: JobPauseMode | null;
  readonly phase: JobPausePhase | null;
  /** The release the pause is for. */
  readonly version: string | null;
}

export const NOT_PAUSED: JobStartPauseState = {
  paused: false,
  drain: false,
  mode: null,
  phase: null,
  version: null,
};

/** Postgres' "undefined_table". */
const UNDEFINED_TABLE = "42P01";

export async function readJobStartPause(db: Queryable): Promise<JobStartPauseState> {
  let rows: { mode: JobPauseMode; phase: JobPausePhase; version: string }[];
  try {
    ({ rows } = await db.query<{ mode: JobPauseMode; phase: JobPausePhase; version: string }>(
      `SELECT mode, phase, version FROM job_start_pause WHERE expires_at > now() LIMIT 1`,
    ));
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === UNDEFINED_TABLE) {
      return NOT_PAUSED;
    }
    throw error;
  }
  const row = rows[0];
  if (!row) {
    return NOT_PAUSED;
  }
  return {
    paused: true,
    drain: row.mode === "drain",
    mode: row.mode,
    phase: row.phase,
    version: row.version,
  };
}
