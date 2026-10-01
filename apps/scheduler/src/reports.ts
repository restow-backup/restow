// Time-triggered report rules (docs/ARCHITECTURE.md, Reports and notifications).
//
// Per tick the scheduler loads the due `schedule` rules of active tenants
// (cross-tenant, on the installation pool), and for each one queues its
// deliveries in `report_deliveries` and moves `next_run_at` on, in one
// tenant-pinned transaction. It does not build the report: the API's
// dispatcher renders it when it sends, from the period stored in the payload.
//
// A rule whose `next_run_at` is still empty (created by the data migration
// from the tenant wizard's weekly-report flag) only gets its first run time;
// it does not fire the moment the scheduler first sees it. A rule with a
// cadence that cannot be planned is pushed a day ahead instead of retried
// every tick.

import { nextRunAt, plannedDeliveries } from "@restow/core";
import type { Pool } from "pg";

export interface DueReportRule {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly intervalMinutes: number | null;
  readonly cron: string | null;
  readonly timezone: string;
  readonly nextRunAt: Date | null;
  readonly lastRunAt: Date | null;
  readonly periodDays: number;
  readonly sections: string[];
  readonly emailRecipients: string[];
  readonly inApp: boolean;
  readonly webhookId: string | null;
  readonly language: "de" | "en" | null;
}

interface DueReportRuleRecord {
  id: string;
  tenant_id: string;
  name: string;
  interval_minutes: number | null;
  cron: string | null;
  timezone: string;
  next_run_at: Date | null;
  last_run_at: Date | null;
  period_days: number;
  sections: string[];
  email_recipients: string[];
  in_app: boolean;
  webhook_id: string | null;
  language: "de" | "en" | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The next run after a firing (or after first sight): the cadence counted from `now`. */
export function nextReportRun(rule: DueReportRule, now: Date): Date {
  return nextRunAt(
    { intervalMinutes: rule.intervalMinutes, cron: rule.cron, timezone: rule.timezone },
    { now, lastRunAt: now },
  );
}

/** The outbox payload of one report: the period it covers and what it contains. */
export function reportPayload(rule: DueReportRule, now: Date): Record<string, unknown> {
  return {
    periodDays: rule.periodDays,
    periodStart: new Date(now.getTime() - rule.periodDays * DAY_MS).toISOString(),
    periodEnd: now.toISOString(),
    sections: [...rule.sections],
  };
}

export interface ReportTickSummary {
  readonly rules: number;
  readonly fired: number;
  readonly deliveries: number;
  readonly deferred: number;
}

export class ReportRuleStore {
  constructor(private readonly pools: { readonly tenant: Pool; readonly installation: Pool }) {}

  async loadDue(now: Date, limit: number): Promise<DueReportRule[]> {
    const result = await this.pools.installation.query<DueReportRuleRecord>(
      `SELECT r.id, r.tenant_id, r.name, r.interval_minutes, r.cron, r.timezone, r.next_run_at,
              r.last_run_at, r.period_days, r.sections, r.email_recipients, r.in_app,
              r.webhook_id, r.language
         FROM report_rules r
         JOIN tenants t ON t.id = r.tenant_id
        WHERE r.trigger = 'schedule'
          AND r.enabled
          AND t.status = 'active'
          AND (r.next_run_at IS NULL OR r.next_run_at <= $1)
        ORDER BY r.next_run_at NULLS FIRST, r.created_at
        LIMIT $2`,
      [now, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      intervalMinutes: row.interval_minutes,
      cron: row.cron,
      timezone: row.timezone,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      periodDays: row.period_days,
      sections: row.sections,
      emailRecipients: row.email_recipients,
      inApp: row.in_app,
      webhookId: row.webhook_id,
      language: row.language,
    }));
  }

  /**
   * Fire a due rule (queue its deliveries) or, when it never had a run time,
   * only set one. Returns how many deliveries were queued.
   */
  async fire(rule: DueReportRule, now: Date, next: Date): Promise<number> {
    const client = await this.pools.tenant.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [rule.tenantId]);
      let queued = 0;
      if (rule.nextRunAt !== null) {
        const payload = JSON.stringify(reportPayload(rule, now));
        for (const planned of plannedDeliveries(rule, "summary")) {
          await client.query(
            `INSERT INTO report_deliveries
               (tenant_id, rule_id, rule_name, kind, payload, channel, recipient, language,
                status, next_attempt_at, created_at, updated_at)
             VALUES ($1, $2, $3, 'summary', $4::jsonb, $5, $6, $7, 'pending', $8, $8, $8)`,
            [
              rule.tenantId,
              rule.id,
              rule.name,
              payload,
              planned.channel,
              planned.recipient,
              rule.language,
              now,
            ],
          );
          queued++;
        }
      }
      await client.query(
        `UPDATE report_rules
            SET last_run_at = CASE WHEN $4 THEN $2 ELSE last_run_at END,
                next_run_at = $3, updated_at = now()
          WHERE id = $1`,
        [rule.id, now, next, rule.nextRunAt !== null],
      );
      await client.query("COMMIT");
      return queued;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Push a rule that cannot be planned a day ahead. */
  async defer(rule: DueReportRule, now: Date): Promise<void> {
    const client = await this.pools.tenant.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [rule.tenantId]);
      await client.query(
        "UPDATE report_rules SET next_run_at = $2, updated_at = now() WHERE id = $1",
        [rule.id, new Date(now.getTime() + DAY_MS)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

/** One pass over the due report rules; failures of one rule never stop the others. */
export async function runDueReports(
  store: ReportRuleStore,
  now: Date,
  limit: number,
  onError: (rule: DueReportRule, error: unknown) => void,
): Promise<ReportTickSummary> {
  const due = await store.loadDue(now, limit);
  let fired = 0;
  let deliveries = 0;
  let deferred = 0;
  for (const rule of due) {
    let next: Date;
    try {
      next = nextReportRun(rule, now);
    } catch (error) {
      onError(rule, error);
      await store.defer(rule, now);
      deferred++;
      continue;
    }
    try {
      const queued = await store.fire(rule, now, next);
      if (rule.nextRunAt !== null) {
        fired++;
        deliveries += queued;
      }
    } catch (error) {
      onError(rule, error);
    }
  }
  return { rules: due.length, fired, deliveries, deferred };
}
