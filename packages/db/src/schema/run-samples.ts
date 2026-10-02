import { sql } from "drizzle-orm";
import { bigint, check, jsonb, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { endpointRuns } from "./endpoints.js";
import { jobs } from "./jobs.js";
import { tenants } from "./tenants.js";

/**
 * One measurement of a running run: cumulative bytes at a moment (`[epoch ms, bytes
 * processed, bytes transferred]`). Cumulative, so thinning old points loses no volume and a
 * rate is always the difference of two neighbours over their distance in time.
 */
export type RunSamplePoint = readonly [at: number, processed: number, transferred: number];

/**
 * The throughput history of one run, for the sparkline in a row and the two charts of the run
 * drawer: at most `MAX_RUN_SAMPLES` points per run, older ones compacted (../run-samples.ts).
 * Written while the run reports progress: by the worker for a mail run (`job_id`) and by the
 * API for a run an agent reports (`endpoint_run_id`); kept after the run ended. A run has at
 * most one row. `baseline_bytes` is, for an agent run, the size of the repository when the run
 * started: the bytes the repository grew since are what the machine transferred.
 */
export const runSamples = pgTable(
  "run_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    endpointRunId: uuid("endpoint_run_id").references(() => endpointRuns.id, {
      onDelete: "cascade",
    }),
    points: jsonb("points").$type<RunSamplePoint[]>().notNull().default([]),
    baselineBytes: bigint("baseline_bytes", { mode: "number" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("run_samples_job_uq").on(t.jobId).where(sql`${t.jobId} IS NOT NULL`),
    uniqueIndex("run_samples_endpoint_run_uq")
      .on(t.endpointRunId)
      .where(sql`${t.endpointRunId} IS NOT NULL`),
    check(
      "run_samples_one_run_ck",
      sql`(${t.jobId} IS NOT NULL) <> (${t.endpointRunId} IS NOT NULL)`,
    ),
  ],
);

export type RunSampleRow = typeof runSamples.$inferSelect;
export type NewRunSampleRow = typeof runSamples.$inferInsert;
