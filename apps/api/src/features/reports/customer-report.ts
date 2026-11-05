import { nextRunAt, periodMonth, reportPeriod } from "@restow/core";
import {
  type Database,
  type ReportRule,
  reportDeliveries,
  reportRules,
  tenantContacts,
  tenants,
} from "@restow/db";
import { createI18n, defaultLanguage, type SupportedLanguage } from "@restow/i18n";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { featureHook } from "../../extensions.js";
import { audit } from "../../lib/audit.js";
import { featureEnabled, requireFeature } from "../../lib/features.js";
import { loadInstallationTimeZone } from "../../lib/installation-time-zone.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { effectiveBrand, mailBrandOf, pdfBrandOf } from "../branding/service.js";
import { CUSTOMER_REPORT_CATEGORY } from "./defaults.js";
import type { RenderedMessage } from "./render.js";
import "./hooks.js";

/**
 * The customer monthly report (0.5.0, edition Service Provider, gate `reports.customer`): once a
 * month, on the day and hour the provider chose, an HTML mail and a PDF in the provider's branding
 * (or the tenant's own) to the tenant's contacts that receive it (`tenant_contacts.monthly_report`).
 * It is one schedule rule of the tenant (`kind = 'customer'`, `recipient_category =
 * 'customerReport'`) whose addresses follow the contacts; the content comes from the
 * `reportCustomer` hook (ee/api reports/customer.ts).
 */

export const CUSTOMER_REPORT_AUDIT_ACTIONS = {
  updated: "report.customer.updated",
  testSent: "report.customer.test_sent",
} as const;

export const customerReportUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    sendDay: z.number().int().min(1).max(28).optional(),
    sendHour: z.number().int().min(0).max(23).optional(),
    language: z.enum(["de", "en"]).nullable().optional(),
  })
  .strict();

export const customerReportPreviewSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  lang: z.enum(["de", "en"]).optional(),
});

export interface CustomerReportDto {
  available: boolean;
  enabled: boolean;
  sendDay: number;
  sendHour: number;
  timezone: string;
  language: "de" | "en" | null;
  recipients: { contactId: string; name: string; email: string }[];
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastDelivery: { at: string; status: string } | null;
}

export interface CustomerReportActor {
  readonly id: string;
  readonly email: string;
  readonly ip: string | null;
}

/** The cron of the report: minute 0 of `hour` on `day` of every month. */
export function customerReportCron(day: number, hour: number): string {
  return `0 ${hour} ${day} * *`;
}

/** Day and hour of a stored cron (`0 H D * *`), or the defaults. */
export function customerReportSchedule(cron: string | null | undefined): {
  day: number;
  hour: number;
} {
  const match = /^0 (\d{1,2}) (\d{1,2}) \* \*$/.exec(cron ?? "");
  const hour = match ? Number(match[1]) : 7;
  const day = match ? Number(match[2]) : 1;
  return {
    day: day >= 1 && day <= 28 ? day : 1,
    hour: hour >= 0 && hour <= 23 ? hour : 7,
  };
}

async function ruleOf(tx: DbExecutor, tenantId: string): Promise<ReportRule | null> {
  const [rule] = await tx
    .select()
    .from(reportRules)
    .where(
      and(
        eq(reportRules.tenantId, tenantId),
        eq(reportRules.recipientCategory, CUSTOMER_REPORT_CATEGORY),
      ),
    )
    .limit(1);
  return rule ?? null;
}

async function contactsOf(tx: DbExecutor, tenantId: string) {
  const rows = await tx
    .select({ id: tenantContacts.id, name: tenantContacts.name, email: tenantContacts.email })
    .from(tenantContacts)
    .where(
      and(
        eq(tenantContacts.tenantId, tenantId),
        eq(tenantContacts.monthlyReport, true),
        isNotNull(tenantContacts.email),
      ),
    );
  return rows.flatMap((row) =>
    row.email ? [{ contactId: row.id, name: row.name, email: row.email.trim().toLowerCase() }] : [],
  );
}

/**
 * Keep the report's addresses in step with the contacts that receive it (called in the
 * transaction that saves the contacts). Without a rule there is nothing to do: the report is set
 * up on the tenant page.
 */
export async function syncCustomerReportRecipients(
  tx: DbExecutor,
  tenantId: string,
  now: Date,
): Promise<void> {
  const rule = await ruleOf(tx, tenantId);
  if (!rule) {
    return;
  }
  const addresses = [...new Set((await contactsOf(tx, tenantId)).map((contact) => contact.email))];
  await tx
    .update(reportRules)
    .set({ emailRecipients: addresses, updatedAt: now })
    .where(eq(reportRules.id, rule.id));
}

async function tenantZone(providerDb: DbExecutor, tenantId: string) {
  const [tenant] = await providerDb
    .select({ name: tenants.name, timeZone: tenants.timeZone, language: tenants.language })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) {
    throw new ProblemError(404, "Tenant not found");
  }
  const zone = tenant.timeZone?.trim() || (await loadInstallationTimeZone(providerDb)).timeZone;
  return { ...tenant, zone };
}

/** GET /tenants/:id/customer-report. */
export async function getCustomerReport(
  db: Database,
  providerDb: Database,
  tenantId: string,
): Promise<CustomerReportDto> {
  const tenant = await tenantZone(providerDb, tenantId);
  const available = await featureEnabled("reports.customer", providerDb);
  return withTenantTx(db, tenantId, async (tx) => {
    const rule = await ruleOf(tx, tenantId);
    const schedule = customerReportSchedule(rule?.cron);
    const [last] = rule
      ? await tx
          .select({ at: reportDeliveries.updatedAt, status: reportDeliveries.status })
          .from(reportDeliveries)
          .where(and(eq(reportDeliveries.tenantId, tenantId), eq(reportDeliveries.ruleId, rule.id)))
          .orderBy(desc(reportDeliveries.createdAt))
          .limit(1)
      : [];
    return {
      available,
      enabled: rule?.enabled ?? false,
      sendDay: schedule.day,
      sendHour: schedule.hour,
      timezone: rule?.timezone ?? tenant.zone,
      language: rule?.language ?? null,
      recipients: await contactsOf(tx, tenantId),
      nextRunAt: rule?.enabled ? (rule.nextRunAt?.toISOString() ?? null) : null,
      lastRunAt: rule?.lastRunAt?.toISOString() ?? null,
      lastDelivery: last ? { at: last.at.toISOString(), status: last.status } : null,
    };
  });
}

/** PUT /tenants/:id/customer-report (`reports.customer`). */
export async function putCustomerReport(
  db: Database,
  providerDb: Database,
  tenantId: string,
  input: z.infer<typeof customerReportUpdateSchema>,
  actor: CustomerReportActor,
  now: Date = new Date(),
): Promise<CustomerReportDto> {
  await requireFeature("reports.customer", providerDb);
  const tenant = await tenantZone(providerDb, tenantId);
  await withTenantTx(db, tenantId, async (tx) => {
    const rule = await ruleOf(tx, tenantId);
    const current = customerReportSchedule(rule?.cron);
    const day = input.sendDay ?? current.day;
    const hour = input.sendHour ?? current.hour;
    const cron = customerReportCron(day, hour);
    const timezone = rule?.timezone ?? tenant.zone;
    const language = input.language === undefined ? (rule?.language ?? null) : input.language;
    const enabled = input.enabled ?? rule?.enabled ?? true;
    const addresses = [
      ...new Set((await contactsOf(tx, tenantId)).map((contact) => contact.email)),
    ];
    const next = nextRunAt({ cron, timezone }, { now });
    if (rule) {
      await tx
        .update(reportRules)
        .set({
          cron,
          enabled,
          language,
          emailRecipients: addresses,
          nextRunAt: next,
          updatedAt: now,
        })
        .where(eq(reportRules.id, rule.id));
    } else {
      const i18n = createI18n({ lng: tenant.language === "en" ? "en" : "de" });
      await tx.insert(reportRules).values({
        tenantId,
        name: String(i18n.t("reports:defaultRules.customerReport")),
        trigger: "schedule",
        kind: "customer",
        recipientCategory: CUSTOMER_REPORT_CATEGORY,
        cron,
        timezone,
        periodDays: 30,
        attachPdf: true,
        enabled,
        language,
        emailRecipients: addresses,
        nextRunAt: next,
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
      });
    }
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: CUSTOMER_REPORT_AUDIT_ACTIONS.updated,
      target: tenantId,
      targetType: "report_rule",
      ip: actor.ip,
      details: { enabled, sendDay: day, sendHour: hour, language, recipients: addresses.length },
    });
  });
  return getCustomerReport(db, providerDb, tenantId);
}

/** The month a report sent now covers: the previous calendar month in the tenant's zone. */
export function previousMonth(now: Date, zone: string): string {
  return periodMonth(reportPeriod({ cadence: "monthly" }, now, zone), zone);
}

async function renderInput(
  db: Database,
  providerDb: Database,
  tenantId: string,
  query: z.infer<typeof customerReportPreviewSchema>,
  now: Date,
) {
  await requireFeature("reports.customer", providerDb);
  const renderer = featureHook("reportCustomer");
  if (!renderer) {
    throw new ProblemError(404, "Not available");
  }
  const tenant = await tenantZone(providerDb, tenantId);
  const rule = await withTenantTx(db, tenantId, (tx) => ruleOf(tx, tenantId));
  const language: SupportedLanguage =
    query.lang ?? rule?.language ?? tenant.language ?? defaultLanguage;
  const loaded = await effectiveBrand(providerDb, tenantId);
  return {
    renderer,
    month: query.month ?? previousMonth(now, tenant.zone),
    tenant,
    rule,
    language,
    loaded,
  };
}

/** GET /tenants/:id/customer-report/preview: the mail of a month, logo by its public path. */
export async function previewCustomerReport(
  db: Database,
  providerDb: Database,
  tenantId: string,
  query: z.infer<typeof customerReportPreviewSchema>,
  now: Date = new Date(),
): Promise<RenderedMessage> {
  const { renderer, month, tenant, rule, language, loaded } = await renderInput(
    db,
    providerDb,
    tenantId,
    query,
    now,
  );
  const rendered = await withTenantTx(db, tenantId, (tx) =>
    renderer.render({
      db: tx,
      providerDb,
      tenantPool: db,
      scope: "tenant",
      tenantId,
      tenantName: tenant.name,
      ruleName: rule?.name ?? "",
      language,
      payload: { kind: "customer", month },
      brand: mailBrandOf(loaded, "preview").brand,
      attachPdf: false,
      pdfBrand: null,
      month,
    }),
  );
  return { subject: rendered.subject, html: rendered.html, text: rendered.text };
}

/** GET /tenants/:id/customer-report/preview.pdf. */
export async function previewCustomerReportPdf(
  db: Database,
  providerDb: Database,
  tenantId: string,
  query: z.infer<typeof customerReportPreviewSchema>,
  now: Date = new Date(),
): Promise<{ fileName: string; pdf: Buffer }> {
  const { renderer, month, tenant, rule, language, loaded } = await renderInput(
    db,
    providerDb,
    tenantId,
    query,
    now,
  );
  const pdf = await withTenantTx(db, tenantId, (tx) =>
    renderer.pdf({
      db: tx,
      providerDb,
      tenantPool: db,
      scope: "tenant",
      tenantId,
      tenantName: tenant.name,
      ruleName: rule?.name ?? "",
      language,
      payload: { kind: "customer", month },
      attachPdf: true,
      pdfBrand: pdfBrandOf(loaded),
      month,
    }),
  );
  return { fileName: `report-${month}.pdf`, pdf };
}

/** POST /tenants/:id/customer-report/test: queue the report of last month for the signed-in user. */
export async function sendCustomerReportTest(
  db: Database,
  providerDb: Database,
  tenantId: string,
  actor: CustomerReportActor,
  now: Date = new Date(),
): Promise<{ to: string }> {
  await requireFeature("reports.customer", providerDb);
  const tenant = await tenantZone(providerDb, tenantId);
  const month = previousMonth(now, tenant.zone);
  await withTenantTx(db, tenantId, async (tx) => {
    const rule = await ruleOf(tx, tenantId);
    await tx.insert(reportDeliveries).values({
      tenantId,
      ruleId: rule?.id ?? null,
      ruleName:
        rule?.name ??
        String(
          createI18n({ lng: tenant.language === "en" ? "en" : "de" }).t(
            "reports:defaultRules.customerReport",
          ),
        ),
      kind: "summary",
      payload: { kind: "customer", month, attachPdf: true, test: true },
      channel: "email",
      recipient: actor.email,
      language: rule?.language ?? null,
      status: "pending",
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: CUSTOMER_REPORT_AUDIT_ACTIONS.testSent,
      target: tenantId,
      targetType: "report_rule",
      ip: actor.ip,
      details: { month },
    });
  });
  return { to: actor.email };
}
