import { timestamp } from "drizzle-orm/pg-core";

// Column helpers shared across the schema. They are factory functions (not
// shared builder instances) so every table gets its own fresh column builders.

/**
 * `created_at` / `updated_at` as `timestamptz`. `created_at` is set on insert,
 * `updated_at` is set on insert and bumped on every update.
 */
export const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * `created_at` only, for append-only / immutable tables (audit log, archive
 * items, hash-chain anchors) where an update path must not exist.
 */
export const createdOnly = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A classified failure, stored next to the legacy error text (`jobs.error_message`,
 * `item_failures.reason`, `sources.error_message`). Mirrors `FailureRecord` in
 * @restow/core (packages/core/src/failures): a stable machine code plus a few
 * scalar parameters, the redacted technical details for a support case, and
 * when and where it happened. Never contains secrets. Readers must tolerate
 * codes and fields this version does not know.
 */
export type FailureRecordJson = {
  v: 1;
  code: string;
  transient: boolean;
  params: Record<string, string | number | boolean | null>;
  technical: Record<string, string | number>;
  /** ISO 8601. */
  occurredAt: string;
  /** Engine phase the run was in, e.g. "download". */
  step: string | null;
  /** Automatic retry state of a run that failed but is queued again. */
  retry: { attempt: number; limit: number; nextAttemptAt: string | null } | null;
};
