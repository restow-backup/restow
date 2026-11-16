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
//
// Since 0.5.0 a rule with a calendar cadence covers the previous day, Monday
// to Sunday or calendar month in its time zone (packages/core reports/period.ts),
// a customer report rule names its month, and the provider's own summary
// reports across tenants (`provider_report_rules`, Business) fire here too: one
// delivery per address, without a tenant (the API renders them across tenants).

import {
  calendarDateIn,
  isReportCadence,
  nextRunAt,
  periodLengthDays,
  periodMonth,
  plannedDeliveries,
  type ReportCadence,
  type ReportPeriod,
  reportPeriod,
} from "@restow/core";
import { createI18n, defaultLanguage } from "@restow/i18n";
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
  /** The calendar cadence (0.5.0); null keeps the rolling `periodDays`. */
  readonly cadence?: ReportCadence | null;
  /** Attach the PDF (0.5.0). */
  readonly attachPdf?: boolean;
  /** A summary report or the customer monthly report (0.5.0). */
  readonly kind?: "summary" | "customer";
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
  cadence: string | null;
  attach_pdf: boolean;
  kind: "summary" | "customer";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The next run after a firing (or after first sight): the cadence counted from `now`. */
export function nextReportRun(rule: DueReportRule, now: Date): Date {
  return nextRunAt(
    { intervalMinutes: rule.intervalMinutes, cron: rule.cron, timezone: rule.timezone },
    { now, lastRunAt: now },
  );
}

/** The calendar days a period covers in `timeZone` (the statistics read whole days). */
export function periodDaysOf(
  period: ReportPeriod,
  timeZone: string,
): { fromDay: string; toDay: string } {
  const day = (instant: Date) => {
    const date = calendarDateIn(instant, timeZone);
    return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
  };
  return { fromDay: day(period.start), toDay: day(new Date(period.end.getTime() - 1)) };
}

/** The outbox payload of one report: the period it covers and what it contains. */
export function reportPayload(rule: DueReportRule, now: Date): Record<string, unknown> {
  if (rule.kind === "customer") {
    // The previous calendar month in the rule's zone.
    const period = reportPeriod({ cadence: "monthly" }, now, rule.timezone);
    return {
      kind: "customer",
      month: periodMonth(period, rule.timezone),
      periodStart: period.start.toISOString(),
      periodEnd: period.end.toISOString(),
      attachPdf: true,
    };
  }
  if (rule.cadence) {
    const period = reportPeriod({ cadence: rule.cadence }, now, rule.timezone);
    return {
      periodDays: periodLengthDays(period),
      periodStart: period.start.toISOString(),
      periodEnd: period.end.toISOString(),
      ...periodDaysOf(period, rule.timezone),
      sections: [...rule.sections],
      cadence: rule.cadence,
      attachPdf: rule.attachPdf === true,
    };
  }
  return {
    periodDays: rule.periodDays,
    periodStart: new Date(now.getTime() - rule.periodDays * DAY_MS).toISOString(),
    periodEnd: now.toISOString(),
    sections: [...rule.sections],
    attachPdf: rule.attachPdf === true,
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
              r.webhook_id, r.language, r.cadence, r.attach_pdf, r.kind
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
      cadence: isReportCadence(row.cadence) ? row.cadence : null,
      attachPdf: row.attach_pdf,
      kind: row.kind,
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

  /** The provider's due reports across tenants (0.5.0), with at least one address. */
  async loadDueProvider(now: Date, limit: number): Promise<DueProviderReportRule[]> {
    const result = await this.pools.installation.query<{
      id: string;
      cadence: ReportCadence;
      timezone: string;
      send_hour: number;
      attach_pdf: boolean;
      email_recipients: string[];
      language: "de" | "en" | null;
      next_run_at: Date | null;
    }>(
      `SELECT id, cadence, timezone, send_hour, attach_pdf, email_recipients, language, next_run_at
         FROM provider_report_rules
        WHERE enabled
          AND (next_run_at IS NULL OR next_run_at <= $1)
        ORDER BY next_run_at NULLS FIRST
        LIMIT $2`,
      [now, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      cadence: row.cadence,
      timezone: row.timezone,
      sendHour: row.send_hour,
      attachPdf: row.attach_pdf,
      emailRecipients: row.email_recipients,
      language: row.language,
      nextRunAt: row.next_run_at,
    }));
  }

  /**
   * Fire the provider's report (one delivery per address, without a tenant) or, when it never had
   * a run time, only set one. Runs on the installation pool: the rows carry no tenant.
   */
  async fireProvider(rule: DueProviderReportRule, now: Date, next: Date): Promise<number> {
    const client = await this.pools.installation.connect();
    try {
      await client.query("BEGIN");
      let queued = 0;
      if (rule.nextRunAt !== null) {
        const payload = JSON.stringify(providerReportPayload(rule, now));
        const name = providerReportName(rule);
        const seen = new Set<string>();
        for (const address of rule.emailRecipients) {
          const recipient = address.trim().toLowerCase();
          if (!recipient || seen.has(recipient)) continue;
          seen.add(recipient);
          await client.query(
            `INSERT INTO report_deliveries
               (tenant_id, provider_rule_id, rule_name, kind, payload, channel, recipient, language,
                status, next_attempt_at, created_at, updated_at)
             VALUES (NULL, $1, $2, 'summary', $3::jsonb, 'email', $4, $5, 'pending', $6, $6, $6)`,
            [rule.id, name, payload, recipient, rule.language, now],
          );
          queued++;
        }
      }
      await client.query(
        `UPDATE provider_report_rules
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

/** The provider's report across tenants (0.5.0), as the scheduler reads it. */
export interface DueProviderReportRule {
  readonly id: string;
  readonly cadence: ReportCadence;
  readonly timezone: string;
  readonly sendHour: number;
  readonly attachPdf: boolean;
  readonly emailRecipients: string[];
  readonly language: "de" | "en" | null;
  readonly nextRunAt: Date | null;
}

/** The cron of a provider report (the API writes the same, provider-notifications/service.ts). */
export function providerReportCron(cadence: ReportCadence, hour: number): string {
  switch (cadence) {
    case "daily":
      return `0 ${hour} * * *`;
    case "weekly":
      return `0 ${hour} * * 1`;
    case "monthly":
      return `0 ${hour} 1 * *`;
  }
}

/** The payload of a provider report fired at `now`. */
export function providerReportPayload(
  rule: DueProviderReportRule,
  now: Date,
): Record<string, unknown> {
  const period = reportPeriod({ cadence: rule.cadence }, now, rule.timezone);
  return {
    scope: "provider",
    cadence: rule.cadence,
    periodDays: periodLengthDays(period),
    periodStart: period.start.toISOString(),
    periodEnd: period.end.toISOString(),
    ...periodDaysOf(period, rule.timezone),
    attachPdf: rule.attachPdf,
  };
}

/** The name a provider report is sent under, in its language. */
function providerReportName(rule: DueProviderReportRule): string {
  const i18n = createI18n({ lng: rule.language ?? defaultLanguage });
  return String(i18n.t(`reports:defaultRules.${rule.cadence}Report`));
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
  // The provider's own reports across tenants first; their errors are reported like a rule's.
  for (const rule of await store.loadDueProvider(now, limit)) {
    try {
      const next = nextRunAt(
        { cron: providerReportCron(rule.cadence, rule.sendHour), timezone: rule.timezone },
        { now, lastRunAt: now },
      );
      const queued = await store.fireProvider(rule, now, next);
      if (rule.nextRunAt !== null) {
        fired++;
        deliveries += queued;
      }
    } catch (error) {
      onError(
        {
          id: rule.id,
          tenantId: "",
          name: rule.cadence,
          intervalMinutes: null,
          cron: null,
          timezone: rule.timezone,
          nextRunAt: rule.nextRunAt,
          lastRunAt: null,
          periodDays: 1,
          sections: [],
          emailRecipients: rule.emailRecipients,
          inApp: false,
          webhookId: null,
          language: rule.language,
        },
        error,
      );
    }
  }
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
