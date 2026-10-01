// Endpoint backup jobs (docs/AGENT.md): the scheduler decides which endpoints
// are due for server-side work and hands one job per endpoint and kind to the
// worker. It does not run restic itself.
//
//   endpoint-retention  every endpoint once a day: restic forget --prune
//   endpoint-check      every endpoint once a week: restic check, a slice of the data
//   endpoint-verify     every new good backup that has samples but no server-side restore test
//   endpoint-monitor    every five minutes: silent endpoints, failed runs, failed tests, alerts
//
// What is due comes from the endpoint rows themselves (last_retention_at,
// last_check_at, the reports), so a restart or a second scheduler decides the
// same. pg-boss' own singleton keys keep a job from being queued twice, and
// `singletonSeconds` spaces the retries of an endpoint whose job keeps failing,
// so a broken repository is tried every hour, not on every tick.

import { ENDPOINT_QUEUES, ENDPOINT_QUEUE_SETTINGS, endpointSingletonKey } from "@restow/core";
import type { Pool } from "pg";
import type PgBoss from "pg-boss";
import { errorMessage, logger } from "./logger.js";

const HOUR_SECONDS = 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface EndpointJobCounts {
  readonly retention: number;
  readonly check: number;
  readonly verify: number;
  readonly monitor: number;
}

/** The pg-boss options of an endpoint queue (settings shared with the worker, @restow/core). */
export const ENDPOINT_QUEUE_OPTIONS: Record<string, PgBoss.Queue> = Object.fromEntries(
  Object.values(ENDPOINT_QUEUE_SETTINGS).map((settings) => [settings.name, { ...settings }]),
);

interface DueRow {
  id: string;
  tenant_id: string;
}

export class EndpointJobPlanner {
  private lastPlanned = 0;

  constructor(
    private readonly pools: { readonly installation: Pool },
    private readonly boss: PgBoss,
    /** How often a planning pass runs; the tick loop is more frequent. */
    private readonly intervalMs = 60_000,
    private readonly retentionEveryMs = DAY_MS,
    private readonly checkEveryMs = 7 * DAY_MS,
  ) {}

  /** The endpoints whose retention, check or restore test is due. */
  async due(now: Date): Promise<{ retention: DueRow[]; check: DueRow[]; verify: DueRow[] }> {
    const retentionBefore = new Date(now.getTime() - this.retentionEveryMs);
    const checkBefore = new Date(now.getTime() - this.checkEveryMs);
    const base = `
      FROM endpoints e
      JOIN tenants t ON t.id = e.tenant_id
     WHERE t.status = 'active'
       AND e.last_snapshot_id IS NOT NULL`;
    const retention = await this.pools.installation.query<DueRow>(
      `SELECT e.id, e.tenant_id ${base}
          AND e.status = 'active'
          AND (e.last_retention_at IS NULL OR e.last_retention_at < $1)
        ORDER BY e.last_retention_at NULLS FIRST LIMIT 200`,
      [retentionBefore],
    );
    const check = await this.pools.installation.query<DueRow>(
      `SELECT e.id, e.tenant_id ${base}
          AND (e.last_check_at IS NULL OR e.last_check_at < $1)
        ORDER BY e.last_check_at NULLS FIRST LIMIT 200`,
      [checkBefore],
    );
    const verify = await this.pools.installation.query<DueRow>(
      `SELECT e.id, e.tenant_id ${base}
          AND e.status = 'active'
          AND EXISTS (SELECT 1 FROM endpoint_samples s
                       WHERE s.endpoint_id = e.id AND s.snapshot_id = e.last_snapshot_id)
          AND NOT EXISTS (SELECT 1 FROM endpoint_reports r
                           WHERE r.endpoint_id = e.id AND r.kind = 'restore_test'
                             AND r.origin = 'server' AND r.snapshot_id = e.last_snapshot_id)
        ORDER BY e.last_success_at LIMIT 200`,
    );
    return { retention: retention.rows, check: check.rows, verify: verify.rows };
  }

  private async send(
    queue: (typeof ENDPOINT_QUEUES)[keyof typeof ENDPOINT_QUEUES],
    row: DueRow,
    spacingSeconds: number,
  ): Promise<boolean> {
    const id = await this.boss.send(
      queue,
      { tenantId: row.tenant_id, endpointId: row.id },
      { singletonKey: endpointSingletonKey(queue, row.id), singletonSeconds: spacingSeconds },
    );
    return id !== null;
  }

  /** One planning pass; it does nothing if the last one was less than `intervalMs` ago. */
  async plan(now: Date): Promise<EndpointJobCounts | null> {
    if (now.getTime() - this.lastPlanned < this.intervalMs) {
      return null;
    }
    this.lastPlanned = now.getTime();
    const counts = { retention: 0, check: 0, verify: 0, monitor: 0 };
    try {
      const due = await this.due(now);
      for (const row of due.retention) {
        if (await this.send(ENDPOINT_QUEUES.retention, row, HOUR_SECONDS)) counts.retention++;
      }
      for (const row of due.check) {
        if (await this.send(ENDPOINT_QUEUES.check, row, HOUR_SECONDS)) counts.check++;
      }
      for (const row of due.verify) {
        if (await this.send(ENDPOINT_QUEUES.verify, row, HOUR_SECONDS)) counts.verify++;
      }
      const monitor = await this.boss.send(
        ENDPOINT_QUEUES.monitor,
        {},
        { singletonKey: ENDPOINT_QUEUES.monitor, singletonSeconds: 4 * 60 },
      );
      if (monitor !== null) counts.monitor++;
    } catch (error) {
      logger.error("planning endpoint jobs failed", { err: errorMessage(error) });
    }
    return counts;
  }
}
