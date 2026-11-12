// Time-triggered report rules against a real Postgres: a due rule queues one
// delivery per channel and moves its next run on, a rule without a run time
// only gets one (no report the moment it is first seen), a suspended tenant's
// rules wait, and a rule whose cadence cannot be planned is pushed a day.
//
// Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database
// named `restow_scheduler_reports_test` is recreated there); skipped otherwise.

import { createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReportRuleStore, runDueReports } from "./reports.js";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_scheduler_reports_test";

async function recreateTestDatabase(base: string): Promise<string> {
  const admin = createDb(base);
  try {
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.$client.end();
  }
  const url = new URL(base);
  url.pathname = `/${TEST_DB}`;
  await runMigrations(url.toString());
  return url.toString();
}

describe.skipIf(!adminUrl)("report rules in the scheduler", () => {
  let db: ReturnType<typeof createDb>;
  let store: ReportRuleStore;
  let tenantId: string;
  let suspendedId: string;
  const errors: string[] = [];

  beforeAll(async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    db = createDb(url);
    store = new ReportRuleStore({ tenant: db.$client, installation: db.$client });
    const { rows: providers } = await db.$client.query<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    const providerId = providers[0]?.id;
    const { rows: created } = await db.$client.query<{ id: string }>(
      `INSERT INTO tenants (provider_id, name, slug, status)
       VALUES ($1, 'Contoso', 'contoso', 'active'), ($1, 'Old', 'old', 'suspended') RETURNING id`,
      [providerId],
    );
    tenantId = created[0]?.id ?? "";
    suspendedId = created[1]?.id ?? "";
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropTestDatabase(adminUrl as string, TEST_DB);
  });

  async function insertRule(values: {
    tenant?: string;
    cron?: string;
    nextRunAt: Date | null;
  }): Promise<string> {
    const { rows } = await db.$client.query<{ id: string }>(
      `INSERT INTO report_rules
         (tenant_id, name, trigger, cron, timezone, next_run_at, sections, email_recipients, in_app)
       VALUES ($1, 'Weekly', 'schedule', $2, 'Europe/Berlin', $3,
               ARRAY['backups','storage'], ARRAY['a@contoso.example','b@contoso.example'], true)
       RETURNING id`,
      [values.tenant ?? tenantId, values.cron ?? "0 7 * * 1", values.nextRunAt],
    );
    return rows[0]?.id ?? "";
  }

  const deliveriesOf = async (ruleId: string) =>
    (
      await db.$client.query<{
        channel: string;
        recipient: string | null;
        kind: string;
        payload: Record<string, unknown>;
      }>(
        "SELECT channel, recipient, kind, payload FROM report_deliveries WHERE rule_id = $1 ORDER BY channel, recipient",
        [ruleId],
      )
    ).rows;

  const ruleRow = async (ruleId: string) =>
    (
      await db.$client.query<{ next_run_at: Date | null; last_run_at: Date | null }>(
        "SELECT next_run_at, last_run_at FROM report_rules WHERE id = $1",
        [ruleId],
      )
    ).rows[0];

  it("gives a rule without a run time its first one, without sending a report", async () => {
    const id = await insertRule({ nextRunAt: null });
    // Wednesday 2026-09-30 12:00 UTC; the next Monday 07:00 in Berlin is 05:00 UTC.
    const summary = await runDueReports(store, new Date("2026-09-30T12:00:00Z"), 50, () => {});
    expect(summary.fired).toBe(0);
    expect(await deliveriesOf(id)).toEqual([]);
    expect((await ruleRow(id))?.next_run_at?.toISOString()).toBe("2026-10-05T05:00:00.000Z");
    await db.$client.query("DELETE FROM report_rules WHERE id = $1", [id]);
  });

  it("fires a due rule on every channel and moves it to its next run", async () => {
    const id = await insertRule({ nextRunAt: new Date("2026-10-05T05:00:00Z") });
    const now = new Date("2026-10-05T05:00:30Z");
    const summary = await runDueReports(store, now, 50, () => {});
    expect(summary).toMatchObject({ fired: 1, deliveries: 3 });
    const rows = await deliveriesOf(id);
    expect(rows.map((row) => [row.channel, row.recipient])).toEqual([
      ["email", "a@contoso.example"],
      ["email", "b@contoso.example"],
      ["in_app", null],
    ]);
    expect(rows[0]?.kind).toBe("summary");
    expect(rows[0]?.payload).toMatchObject({
      periodDays: 7,
      periodEnd: now.toISOString(),
      sections: ["backups", "storage"],
    });
    const after = await ruleRow(id);
    expect(after?.last_run_at?.toISOString()).toBe(now.toISOString());
    expect(after?.next_run_at?.toISOString()).toBe("2026-10-12T05:00:00.000Z");
    // Not due again in the same week.
    expect((await runDueReports(store, now, 50, () => {})).fired).toBe(0);
  });

  it("leaves a suspended tenant's rules alone and defers a broken cadence", async () => {
    const waiting = await insertRule({
      tenant: suspendedId,
      nextRunAt: new Date("2026-10-01T00:00:00Z"),
    });
    const broken = await insertRule({
      cron: "61 25 * * *",
      nextRunAt: new Date("2026-10-01T00:00:00Z"),
    });
    const now = new Date("2026-10-02T00:00:00Z");
    const summary = await runDueReports(store, now, 50, (rule, error) =>
      errors.push(`${rule.id}: ${String(error)}`),
    );
    expect(summary.deferred).toBe(1);
    expect(errors.some((line) => line.startsWith(broken))).toBe(true);
    expect((await ruleRow(broken))?.next_run_at?.toISOString()).toBe("2026-10-03T00:00:00.000Z");
    expect(await deliveriesOf(waiting)).toEqual([]);
  });

  describe("0.5.0", () => {
    it("covers the previous calendar week of a weekly cadence rule, with its days", async () => {
      const { rows } = await db.$client.query<{ id: string }>(
        `INSERT INTO report_rules
           (tenant_id, name, trigger, cron, cadence, attach_pdf, timezone, next_run_at, sections,
            email_recipients)
         VALUES ($1, 'Weekly', 'schedule', '0 7 * * 1', 'weekly', true, 'Europe/Berlin', $2,
                 ARRAY['backups'], ARRAY['w@contoso.example'])
         RETURNING id`,
        [tenantId, new Date("2026-10-05T05:00:00Z")],
      );
      const id = rows[0]?.id ?? "";
      await runDueReports(store, new Date("2026-10-05T05:00:30Z"), 50, () => {});
      const [delivery] = await deliveriesOf(id);
      expect(delivery?.payload).toMatchObject({
        cadence: "weekly",
        attachPdf: true,
        periodStart: "2026-09-27T22:00:00.000Z",
        periodEnd: "2026-10-04T22:00:00.000Z",
        fromDay: "2026-09-28",
        toDay: "2026-10-04",
        periodDays: 7,
      });
      await db.$client.query("DELETE FROM report_rules WHERE id = $1", [id]);
    });

    it("names the month of a customer report", async () => {
      const { rows } = await db.$client.query<{ id: string }>(
        `INSERT INTO report_rules
           (tenant_id, name, trigger, kind, cron, timezone, next_run_at, email_recipients,
            attach_pdf, recipient_category)
         VALUES ($1, 'Customer', 'schedule', 'customer', '0 8 3 * *', 'Europe/Berlin', $2,
                 ARRAY['c@contoso.example'], true, 'customerReport')
         RETURNING id`,
        [tenantId, new Date("2026-11-03T07:00:00Z")],
      );
      const id = rows[0]?.id ?? "";
      await runDueReports(store, new Date("2026-11-03T07:00:30Z"), 50, () => {});
      const [delivery] = await deliveriesOf(id);
      expect(delivery).toMatchObject({ kind: "summary", recipient: "c@contoso.example" });
      expect(delivery?.payload).toMatchObject({
        kind: "customer",
        month: "2026-10",
        attachPdf: true,
      });
      const after = await ruleRow(id);
      // The next run: 3 December, 08:00 in Berlin.
      expect(after?.next_run_at?.toISOString()).toBe("2026-12-03T07:00:00.000Z");
      await db.$client.query("DELETE FROM report_rules WHERE id = $1", [id]);
    });

    it("fires the provider's report across tenants once per address, without a tenant", async () => {
      const { rows } = await db.$client.query<{ id: string }>(
        `INSERT INTO provider_report_rules
           (cadence, timezone, send_hour, attach_pdf, email_recipients, next_run_at)
         VALUES ('monthly', 'Europe/Berlin', 7, true,
                 ARRAY['olivia@msp.example', 'OLIVIA@msp.example', 'noc@msp.example'], $1)
         RETURNING id`,
        [new Date("2026-11-01T06:00:00Z")],
      );
      const id = rows[0]?.id ?? "";
      const summary = await runDueReports(store, new Date("2026-11-01T06:00:30Z"), 50, () => {});
      expect(summary.deliveries).toBeGreaterThanOrEqual(2);
      const { rows: deliveries } = await db.$client.query<{
        tenant_id: string | null;
        recipient: string;
        payload: Record<string, unknown>;
        rule_name: string;
      }>(
        "SELECT tenant_id, recipient, payload, rule_name FROM report_deliveries WHERE provider_rule_id = $1 ORDER BY recipient",
        [id],
      );
      expect(deliveries.map((row) => [row.tenant_id, row.recipient])).toEqual([
        [null, "noc@msp.example"],
        [null, "olivia@msp.example"],
      ]);
      expect(deliveries[0]?.payload).toMatchObject({
        scope: "provider",
        cadence: "monthly",
        fromDay: "2026-10-01",
        toDay: "2026-10-31",
        attachPdf: true,
      });
      expect(deliveries[0]?.rule_name).toBe("Monatsbericht");
      const { rows: rule } = await db.$client.query<{ next_run_at: Date }>(
        "SELECT next_run_at FROM provider_report_rules WHERE id = $1",
        [id],
      );
      expect(rule[0]?.next_run_at.toISOString()).toBe("2026-12-01T06:00:00.000Z");
    });
  });
});
