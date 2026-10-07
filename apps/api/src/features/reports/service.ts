import {
  REPORT_EVENTS,
  REPORT_EVENT_INFO,
  REPORT_PERIOD_DAYS,
  REPORT_SECTIONS,
  type ReportEvent,
  nextRunAt as cadenceNextRunAt,
  isInstallationReportEvent,
  plannedDeliveries,
  validateCadence,
} from "@restow/core";
import {
  type Database,
  type NewReportDelivery,
  type ReportDelivery,
  type ReportRule,
  notifications,
  reportDeliveries,
  reportRules,
  tenants,
  webhookDeliveries,
  webhooks,
} from "@restow/db";
import { type SQL, and, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { featureEnabled, requireFeature } from "../../lib/features.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { toCsv } from "../stats/csv.js";
import { WEBHOOK_DELIVERY_KEY } from "./dispatcher.js";
import {
  type CreateReportRuleInput,
  type ListDeliveriesQuery,
  type ListNotificationsQuery,
  type MarkNotificationsReadInput,
  type UpdateReportRuleInput,
  reportRuleProblem,
} from "./schemas.js";

/**
 * Notification and report rules of a tenant, their delivery log, test sends
 * and the bell (docs/ARCHITECTURE.md, Reports and notifications). Event rules
 * are always on; `schedule` rules exist only while an extension enables
 * `reports.timed` (lib/features.ts). Every change is audited in the same
 * transaction.
 */

export const REPORT_AUDIT_ACTIONS = {
  created: "report.rule.created",
  updated: "report.rule.updated",
  deleted: "report.rule.deleted",
  testSent: "report.test_sent",
} as const;

export interface ReportActor {
  userId: string | null;
  label: string;
  ip: string | null;
  /**
   * A provider administrator. Only they may put installation events (an update
   * being available) into a rule: a tenant's own administrators are not told
   * about the operator's software updates.
   */
  providerAdmin?: boolean;
}

export interface ReportRuleDto {
  id: string;
  name: string;
  enabled: boolean;
  trigger: "event" | "schedule";
  events: string[];
  throttleMinutes: number;
  intervalMinutes: number | null;
  cron: string | null;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  periodDays: number;
  sections: string[];
  emailRecipients: string[];
  /**
   * Set when this rule carries one category of the tenant's notification recipients
   * (`jobFailures`, `readinessRed`, `weeklyReport`): its e-mail recipients are the recipients
   * who chose that category and change only through them.
   */
  recipientCategory: string | null;
  inApp: boolean;
  webhookId: string | null;
  language: "de" | "en" | null;
  /**
   * The rule's own deadline for `backup.overdue` in hours: its alerts come when nothing was
   * backed up successfully for this long, instead of by the jobs' schedules. Null: by the
   * schedules (and always for a rule that does not list `backup.overdue`).
   */
  overdueAfterHours: number | null;
  /** A schedule rule the installation cannot send right now (`reports.timed` is off). */
  locked: boolean;
  /** When the rule last sent something, and whether the newest delivery failed. */
  lastDelivery: { at: string; status: ReportDelivery["status"] } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportDeliveryDto {
  id: string;
  ruleId: string | null;
  ruleName: string;
  kind: "event" | "summary";
  event: string | null;
  channel: "email" | "in_app" | "webhook";
  recipient: string | null;
  status: ReportDelivery["status"];
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  /** Object or queue the alert is about, when known. */
  target: string | null;
  /** What the alert is about, for a link: the protected object, the machine, the run. */
  subject: DeliverySubjectDto;
  /**
   * A webhook alert is handed to the webhook dispatcher; its own delivery decides `status`
   * (pending while it is retried, sent once the receiver accepted it, failed when it gave up).
   */
  webhook: { id: string; deliveryId: string | null } | null;
  /** Set in the view across tenants: whose alert it is. */
  tenant?: { id: string; name: string };
}

export interface DeliverySubjectDto {
  objectId: string | null;
  endpointId: string | null;
  /** A VM or container of Proxmox VE. */
  guestId: string | null;
  jobId: string | null;
}

export interface ReportCatalogDto {
  events: { name: ReportEvent; group: string; level: string }[];
  sections: string[];
  periods: number[];
  /** Whether time-triggered reports can be created (`reports.timed` is on). */
  scheduledAvailable: boolean;
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

export function toRuleDto(
  row: ReportRule,
  scheduledAvailable: boolean,
  last: { at: Date; status: ReportDelivery["status"] } | null = null,
): ReportRuleDto {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    trigger: row.trigger,
    events: [...row.events],
    throttleMinutes: row.throttleMinutes,
    intervalMinutes: row.intervalMinutes,
    cron: row.cron,
    timezone: row.timezone,
    nextRunAt: row.trigger === "schedule" && row.enabled ? iso(row.nextRunAt) : null,
    lastRunAt: iso(row.lastRunAt),
    periodDays: row.periodDays,
    sections: [...row.sections],
    emailRecipients: [...row.emailRecipients],
    recipientCategory: row.recipientCategory,
    inApp: row.inApp,
    webhookId: row.webhookId,
    language: row.language,
    overdueAfterHours: row.overdueAfterHours,
    locked: row.trigger === "schedule" && !scheduledAvailable,
    lastDelivery: last ? { at: last.at.toISOString(), status: last.status } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The outcome of the webhook delivery a webhook alert was handed to. */
export interface HandedOverWebhook {
  status: "pending" | "delivered" | "failed";
  lastError: string | null;
  deliveredAt: Date | null;
  attempts: number;
}

const stringOr = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** The id of the webhook delivery a webhook alert was handed to, if it was. */
export function webhookDeliveryIdOf(row: Pick<ReportDelivery, "payload">): string | null {
  return stringOr(row.payload?.[WEBHOOK_DELIVERY_KEY]);
}

/**
 * The status the log shows. A webhook alert the dispatcher handed over is "sent" in its own
 * row, but nothing has reached the receiver yet: the webhook delivery decides. One that is no
 * longer there (the log keeps finished webhook deliveries for 30 days) keeps the row's status.
 */
export function deliveryStatusOf(
  row: Pick<ReportDelivery, "status" | "channel">,
  hook: HandedOverWebhook | null,
): ReportDelivery["status"] {
  if (row.channel !== "webhook" || row.status !== "sent" || !hook) {
    return row.status;
  }
  return hook.status === "delivered" ? "sent" : hook.status;
}

export function toDeliveryDto(
  row: ReportDelivery,
  hook: HandedOverWebhook | null = null,
): ReportDeliveryDto {
  const details = ((row.payload ?? {}) as { details?: Record<string, unknown> }).details ?? {};
  const target =
    typeof details.objectName === "string"
      ? details.objectName
      : typeof details.queue === "string"
        ? details.queue
        : null;
  const status = deliveryStatusOf(row, hook);
  return {
    id: row.id,
    ruleId: row.ruleId,
    ruleName: row.ruleName,
    kind: row.kind,
    event: row.event,
    channel: row.channel,
    recipient: row.channel === "webhook" ? null : row.recipient,
    status,
    attempts: row.attempts,
    lastError: hook && status !== row.status ? hook.lastError : row.lastError,
    createdAt: row.createdAt.toISOString(),
    sentAt: hook ? iso(hook.deliveredAt) : iso(row.sentAt),
    target,
    subject: {
      objectId: stringOr(details.protectedObjectId),
      endpointId: stringOr(details.endpointId),
      guestId: stringOr(details.pveGuestId),
      jobId: stringOr(details.jobId),
    },
    webhook:
      row.channel === "webhook" && row.recipient
        ? { id: row.recipient, deliveryId: webhookDeliveryIdOf(row) }
        : null,
  };
}

/** The webhook deliveries webhook alerts were handed to, by id (read on the given executor). */
async function handedOver(
  tx: DbExecutor,
  rows: readonly ReportDelivery[],
): Promise<Map<string, HandedOverWebhook>> {
  const ids = rows
    .filter((row) => row.channel === "webhook")
    .map(webhookDeliveryIdOf)
    .filter((id): id is string => id !== null);
  if (ids.length === 0) {
    return new Map();
  }
  const found = await tx
    .select({
      id: webhookDeliveries.id,
      status: webhookDeliveries.status,
      lastError: webhookDeliveries.lastError,
      deliveredAt: webhookDeliveries.deliveredAt,
      attempts: webhookDeliveries.attempts,
    })
    .from(webhookDeliveries)
    .where(inArray(webhookDeliveries.id, ids));
  return new Map(found.map(({ id, ...hook }) => [id, hook]));
}

async function deliveryDtos(
  tx: DbExecutor,
  rows: readonly ReportDelivery[],
): Promise<ReportDeliveryDto[]> {
  const hooks = await handedOver(tx, rows);
  return rows.map((row) => {
    const id = webhookDeliveryIdOf(row);
    return toDeliveryDto(row, id ? (hooks.get(id) ?? null) : null);
  });
}

/** The rule as recorded in the audit log: what it does, not who receives it in full. */
function ruleDefinition(row: ReportRule): Record<string, unknown> {
  return {
    name: row.name,
    enabled: row.enabled,
    trigger: row.trigger,
    events: row.events,
    throttleMinutes: row.throttleMinutes,
    intervalMinutes: row.intervalMinutes,
    cron: row.cron,
    timezone: row.timezone,
    periodDays: row.periodDays,
    sections: row.sections,
    recipients: row.emailRecipients.length,
    inApp: row.inApp,
    webhookId: row.webhookId,
    overdueAfterHours: row.overdueAfterHours,
  };
}

function auditEvent(
  tenantId: string,
  actor: ReportActor,
  action: string,
  ruleId: string,
  details: Record<string, unknown>,
) {
  return {
    tenantId,
    actor: actor.label,
    actorUserId: actor.userId,
    action,
    target: ruleId,
    targetType: "report_rule",
    ip: actor.ip,
    details,
  };
}

type RuleShape = Pick<
  ReportRule,
  | "trigger"
  | "events"
  | "intervalMinutes"
  | "cron"
  | "timezone"
  | "sections"
  | "emailRecipients"
  | "inApp"
  | "webhookId"
> &
  Partial<Pick<ReportRule, "overdueAfterHours">>;

/** A deadline for missing backups belongs to an event rule that lists `backup.overdue`. */
export function assertOverdueDeadline(
  rule: Pick<RuleShape, "trigger" | "events" | "overdueAfterHours">,
): void {
  if (
    rule.overdueAfterHours !== undefined &&
    rule.overdueAfterHours !== null &&
    (rule.trigger !== "event" || !rule.events.includes("backup.overdue"))
  ) {
    throw reportRuleProblem(
      "overdueAfterHours",
      "overdue_event_required",
      "A deadline for missing backups needs the event backup.overdue.",
    );
  }
}

/** Everything a rule needs to be able to fire; throws the first problem as a 422. */
export function assertRuleShape(rule: RuleShape, now: Date): void {
  if (rule.trigger === "event" && rule.events.length === 0) {
    throw reportRuleProblem("events", "events_required", "Choose at least one event.");
  }
  if (rule.trigger === "schedule") {
    if (rule.sections.length === 0) {
      throw reportRuleProblem("sections", "sections_required", "Choose at least one section.");
    }
    const issue = validateCadence(
      { intervalMinutes: rule.intervalMinutes, cron: rule.cron, timezone: rule.timezone },
      now,
    );
    if (issue) {
      throw reportRuleProblem(issue.field, issue.code, issue.message);
    }
  }
  assertOverdueDeadline(rule);
  const kind = rule.trigger === "event" ? "event" : "summary";
  if (plannedDeliveries(rule, kind).length === 0) {
    throw reportRuleProblem(
      "channels",
      "channel_required",
      rule.trigger === "event"
        ? "Add a recipient or a webhook."
        : "Add a recipient, the bell or a webhook.",
    );
  }
}

async function assertWebhook(tx: DbExecutor, tenantId: string, webhookId: string | null) {
  if (webhookId === null) return;
  const [row] = await tx
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.id, webhookId)));
  if (!row) {
    throw reportRuleProblem("webhookId", "webhook_not_found", "The webhook does not exist.");
  }
}

async function assertScheduledAllowed(db: DbExecutor, trigger: string): Promise<void> {
  if (trigger === "schedule") {
    await requireFeature(db, "reports.timed");
  }
}

/** When a schedule rule runs next: an interval counts from now, cron follows its zone. */
function firstRun(rule: RuleShape, now: Date): Date | null {
  if (rule.trigger !== "schedule") return null;
  return cadenceNextRunAt(
    { intervalMinutes: rule.intervalMinutes, cron: rule.cron, timezone: rule.timezone },
    { now, lastRunAt: now },
  );
}

/** Installation events may only be chosen by provider administrators. */
function assertInstallationEventsAllowed(events: readonly string[], actor: ReportActor): void {
  if (actor.providerAdmin !== true && events.some(isInstallationReportEvent)) {
    throw reportRuleProblem(
      "events",
      "installation_event",
      "This event is about the installation and can only be chosen by a provider administrator.",
    );
  }
}

async function findRule(tx: DbExecutor, tenantId: string, id: string): Promise<ReportRule> {
  const [row] = await tx
    .select()
    .from(reportRules)
    .where(and(eq(reportRules.tenantId, tenantId), eq(reportRules.id, id)));
  if (!row) {
    throw new ProblemError(404, "Report rule not found");
  }
  return row;
}

export async function reportCatalog(
  db: Database,
  options: { providerAdmin?: boolean } = {},
): Promise<ReportCatalogDto> {
  return {
    events: REPORT_EVENTS.filter(
      (name) => options.providerAdmin === true || !isInstallationReportEvent(name),
    ).map((name) => ({ name, ...REPORT_EVENT_INFO[name] })),
    sections: [...REPORT_SECTIONS],
    periods: [...REPORT_PERIOD_DAYS],
    scheduledAvailable: await featureEnabled(db, "reports.timed"),
  };
}

export async function listRules(db: Database, tenantId: string): Promise<ReportRuleDto[]> {
  const scheduledAvailable = await featureEnabled(db, "reports.timed");
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(reportRules)
      .where(eq(reportRules.tenantId, tenantId))
      .orderBy(reportRules.trigger, reportRules.name);
    if (rows.length === 0) return [];
    const last = await tx
      .selectDistinctOn([reportDeliveries.ruleId])
      .from(reportDeliveries)
      .where(
        and(eq(reportDeliveries.tenantId, tenantId), sql`${reportDeliveries.ruleId} IS NOT NULL`),
      )
      .orderBy(reportDeliveries.ruleId, desc(reportDeliveries.createdAt));
    // A webhook alert counts by what the receiver answered, not by being handed over.
    const dtos = await deliveryDtos(tx, last);
    const byRule = new Map(
      last.map((row, index) => [
        row.ruleId,
        { at: row.createdAt, status: dtos[index]?.status ?? row.status },
      ]),
    );
    return rows.map((row) => toRuleDto(row, scheduledAvailable, byRule.get(row.id) ?? null));
  });
}

export async function createRule(
  db: Database,
  tenantId: string,
  input: CreateReportRuleInput,
  actor: ReportActor,
  now: Date,
): Promise<ReportRuleDto> {
  const shape: RuleShape = {
    trigger: input.trigger,
    events: input.trigger === "event" ? input.events : [],
    intervalMinutes: input.trigger === "schedule" ? (input.intervalMinutes ?? null) : null,
    cron: input.trigger === "schedule" ? (input.cron ?? null) : null,
    timezone: input.timezone,
    sections: input.trigger === "schedule" ? input.sections : [],
    emailRecipients: input.emailRecipients,
    inApp: input.trigger === "schedule" ? input.inApp : false,
    webhookId: input.webhookId,
    overdueAfterHours: input.overdueAfterHours ?? null,
  };
  assertInstallationEventsAllowed(shape.events, actor);
  assertRuleShape(shape, now);
  await assertScheduledAllowed(db, input.trigger);
  return withTenantTx(db, tenantId, async (tx) => {
    await assertWebhook(tx, tenantId, shape.webhookId);
    const [row] = await tx
      .insert(reportRules)
      .values({
        tenantId,
        name: input.name,
        enabled: input.enabled,
        ...shape,
        events: [...shape.events],
        sections: [...shape.sections],
        emailRecipients: [...shape.emailRecipients],
        throttleMinutes: input.throttleMinutes,
        periodDays: input.periodDays,
        language: input.language,
        nextRunAt: firstRun(shape, now),
        createdBy: actor.userId,
      })
      .returning();
    if (!row) throw new Error("report rule insert returned no row");
    await audit(
      tx,
      auditEvent(tenantId, actor, REPORT_AUDIT_ACTIONS.created, row.id, ruleDefinition(row)),
    );
    return toRuleDto(row, true);
  });
}

export async function updateRule(
  db: Database,
  tenantId: string,
  id: string,
  requested: UpdateReportRuleInput,
  actor: ReportActor,
  now: Date,
): Promise<ReportRuleDto> {
  const scheduledAvailable = await featureEnabled(db, "reports.timed");
  return withTenantTx(db, tenantId, async (tx) => {
    const before = await findRule(tx, tenantId, id);
    let patch = requested;
    if (requested.events !== undefined && actor.providerAdmin !== true) {
      // The tenant's editor never lists installation events. The ones a provider administrator
      // put into the rule stay when a tenant administrator saves it; adding one is refused.
      const kept = before.events.filter(isInstallationReportEvent) as ReportEvent[];
      assertInstallationEventsAllowed(
        requested.events.filter((event) => !kept.includes(event)),
        actor,
      );
      patch = {
        ...requested,
        events: [...requested.events.filter((event) => !isInstallationReportEvent(event)), ...kept],
      };
    }
    if (before.trigger === "schedule" && !scheduledAvailable) {
      // A locked rule may still be switched off or deleted, nothing else.
      const onlyDisabling =
        Object.keys(patch).every((key) => key === "enabled") && patch.enabled === false;
      if (!onlyDisabling) {
        await assertScheduledAllowed(tx, "schedule");
      }
    }
    if (before.recipientCategory !== null && patch.emailRecipients !== undefined) {
      // The addresses of a rule that carries a category of the notification recipients come from
      // the recipients; changing them here would be undone by the next save over there.
      const key = (list: readonly string[]) =>
        [...new Set(list.map((email) => email.trim().toLowerCase()))].sort().join("\n");
      if (key(patch.emailRecipients) !== key(before.emailRecipients)) {
        throw reportRuleProblem(
          "emailRecipients",
          "recipients_managed",
          "The recipients of this rule are the notification recipients of the tenant; change them there.",
        );
      }
      patch = { ...patch, emailRecipients: undefined };
    }
    const after: ReportRule = {
      ...before,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    } as ReportRule;
    if (after.trigger === "event") {
      after.inApp = false;
      after.sections = [];
      after.intervalMinutes = null;
      after.cron = null;
    } else {
      after.events = [];
    }
    if (
      patch.overdueAfterHours === undefined &&
      (after.trigger !== "event" || !after.events.includes("backup.overdue"))
    ) {
      // The deadline belongs to backup.overdue: dropping the event drops it as well.
      after.overdueAfterHours = null;
    }
    if (patch.intervalMinutes !== undefined && patch.intervalMinutes !== null) after.cron = null;
    if (patch.cron !== undefined && patch.cron !== null) after.intervalMinutes = null;
    if (after.enabled) {
      assertRuleShape(after, now);
    } else {
      // A paused rule need not be able to fire, but a deadline without its event is refused.
      assertOverdueDeadline(after);
    }
    await assertWebhook(tx, tenantId, after.webhookId);
    const cadenceChanged =
      after.intervalMinutes !== before.intervalMinutes ||
      after.cron !== before.cron ||
      after.timezone !== before.timezone ||
      (after.enabled && !before.enabled);
    const [row] = await tx
      .update(reportRules)
      .set({
        name: after.name,
        enabled: after.enabled,
        events: after.events,
        throttleMinutes: after.throttleMinutes,
        intervalMinutes: after.intervalMinutes,
        cron: after.cron,
        timezone: after.timezone,
        periodDays: after.periodDays,
        sections: after.sections,
        emailRecipients: after.emailRecipients,
        inApp: after.inApp,
        webhookId: after.webhookId,
        language: after.language,
        overdueAfterHours: after.overdueAfterHours,
        nextRunAt: cadenceChanged && after.enabled ? firstRun(after, now) : before.nextRunAt,
        updatedAt: now,
      })
      .where(and(eq(reportRules.tenantId, tenantId), eq(reportRules.id, id)))
      .returning();
    if (!row) throw new Error("report rule update returned no row");
    await audit(
      tx,
      auditEvent(tenantId, actor, REPORT_AUDIT_ACTIONS.updated, row.id, {
        before: ruleDefinition(before),
        after: ruleDefinition(row),
      }),
    );
    return toRuleDto(row, scheduledAvailable);
  });
}

export async function deleteRule(
  db: Database,
  tenantId: string,
  id: string,
  actor: ReportActor,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    const before = await findRule(tx, tenantId, id);
    await tx
      .delete(reportRules)
      .where(and(eq(reportRules.tenantId, tenantId), eq(reportRules.id, id)));
    await audit(
      tx,
      auditEvent(tenantId, actor, REPORT_AUDIT_ACTIONS.deleted, id, ruleDefinition(before)),
    );
  });
}

/** A sample event for a test send: the rule's first event, about a made-up mailbox. */
export function testEventPayload(rule: Pick<ReportRule, "events">, now: Date) {
  const event = (rule.events[0] ?? "backup.failed") as ReportEvent;
  return {
    event,
    level: REPORT_EVENT_INFO[event]?.level ?? "info",
    message: "Test notification",
    details: { objectName: "test@example.com", test: true },
    occurredAt: now.toISOString(),
    test: true,
  };
}

/**
 * Queue a test of the rule on every channel it has, right now, marked as a
 * test. The dispatcher sends it within seconds; the log shows the outcome.
 */
export async function testRule(
  db: Database,
  tenantId: string,
  id: string,
  actor: ReportActor,
  now: Date,
): Promise<{ queued: number }> {
  const scheduledAvailable = await featureEnabled(db, "reports.timed");
  return withTenantTx(db, tenantId, async (tx) => {
    const rule = await findRule(tx, tenantId, id);
    if (rule.trigger === "schedule" && !scheduledAvailable) {
      await assertScheduledAllowed(tx, "schedule");
    }
    const kind = rule.trigger === "event" ? "event" : "summary";
    const payload =
      kind === "event"
        ? testEventPayload(rule, now)
        : {
            periodDays: rule.periodDays,
            periodStart: new Date(now.getTime() - rule.periodDays * 86_400_000).toISOString(),
            periodEnd: now.toISOString(),
            sections: [...rule.sections],
            test: true,
          };
    const rows: NewReportDelivery[] = plannedDeliveries(rule, kind).map((planned) => ({
      tenantId,
      ruleId: rule.id,
      ruleName: rule.name,
      kind,
      event: kind === "event" ? (payload as { event: string }).event : null,
      subjectKey: "test",
      payload,
      channel: planned.channel,
      recipient: planned.recipient,
      language: rule.language,
      status: "pending",
      nextAttemptAt: now,
    }));
    if (rows.length > 0) {
      await tx.insert(reportDeliveries).values(rows);
    }
    await audit(
      tx,
      auditEvent(tenantId, actor, REPORT_AUDIT_ACTIONS.testSent, rule.id, {
        channels: rows.map((row) => row.channel),
      }),
    );
    return { queued: rows.length };
  });
}

/** The filters of the delivery log as SQL; `status` is applied to the derived status afterwards. */
function deliveryConditions(query: ListDeliveriesQuery): SQL[] {
  const conditions: SQL[] = [];
  if (query.ruleId) conditions.push(eq(reportDeliveries.ruleId, query.ruleId));
  if (query.before) conditions.push(lt(reportDeliveries.createdAt, new Date(query.before)));
  if (query.status === "skipped") conditions.push(eq(reportDeliveries.status, "skipped"));
  else if (query.status === "pending" || query.status === "failed") {
    // A handed-over webhook alert stored as "sent" may still be pending or have failed.
    conditions.push(
      sql`(${reportDeliveries.status} = ${query.status} OR (${reportDeliveries.channel} = 'webhook' AND ${reportDeliveries.status} = 'sent'))`,
    );
  } else if (query.status === "sent") conditions.push(eq(reportDeliveries.status, "sent"));
  return conditions;
}

/** Rows read for one page; webhook rows whose derived status does not match are dropped after. */
async function readDeliveries(
  tx: DbExecutor,
  where: SQL | undefined,
  query: ListDeliveriesQuery,
  withTenant = false,
): Promise<ReportDeliveryDto[]> {
  const rows = await tx
    .select()
    .from(reportDeliveries)
    .where(where)
    .orderBy(desc(reportDeliveries.createdAt), desc(reportDeliveries.id))
    .limit(query.limit);
  const dtos = (await deliveryDtos(tx, rows)).map((dto, index) =>
    withTenant ? { ...dto, tenant: { id: rows[index]?.tenantId ?? "", name: "" } } : dto,
  );
  return query.status ? dtos.filter((dto) => dto.status === query.status) : dtos;
}

export async function listDeliveries(
  db: Database,
  tenantId: string,
  query: ListDeliveriesQuery,
): Promise<ReportDeliveryDto[]> {
  return withTenantTx(db, tenantId, (tx) =>
    readDeliveries(
      tx,
      and(eq(reportDeliveries.tenantId, tenantId), ...deliveryConditions(query)),
      query,
    ),
  );
}

/**
 * The delivery log across tenants for a provider administrator (Service Provider), each row
 * with its tenant, on the installation pool. `tenantIds` null: every tenant; otherwise only those
 * the administrator's team role covers.
 */
export async function listProviderDeliveries(
  installation: Database,
  tenantIds: readonly string[] | null,
  query: ListDeliveriesQuery,
): Promise<ReportDeliveryDto[]> {
  if (tenantIds !== null && tenantIds.length === 0) {
    return [];
  }
  const scope = tenantIds === null ? [] : [inArray(reportDeliveries.tenantId, [...tenantIds])];
  const dtos = await readDeliveries(
    installation,
    and(...scope, ...deliveryConditions(query)),
    query,
    true,
  );
  return withTenantNames(installation, dtos, (dto) => dto.tenant?.id ?? "");
}

async function withTenantNames<T extends { tenant?: { id: string; name: string } }>(
  installation: Database,
  items: T[],
  idOf: (item: T) => string,
): Promise<T[]> {
  const ids = [...new Set(items.map(idOf).filter((id) => id.length > 0))];
  if (ids.length === 0) return items;
  const names = await installation
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(inArray(tenants.id, ids));
  const byId = new Map(names.map((row) => [row.id, row.name]));
  return items.map((item) => {
    const id = idOf(item);
    return id ? { ...item, tenant: { id, name: byId.get(id) ?? id } } : item;
  });
}

/** Columns of the delivery log export, in order. */
export const DELIVERY_CSV_COLUMNS = [
  "createdAt",
  "tenant",
  "rule",
  "kind",
  "event",
  "target",
  "channel",
  "recipient",
  "status",
  "attempts",
  "sentAt",
  "lastError",
] as const;

/** The delivery log as CSV (the statistics' writer: BOM, header row, CRLF), for proof that a customer was told. */
export function deliveriesCsv(items: readonly ReportDeliveryDto[]): string {
  return toCsv(
    DELIVERY_CSV_COLUMNS,
    items.map((item) => [
      item.createdAt,
      item.tenant?.name ?? null,
      item.ruleName,
      item.kind,
      item.event,
      item.target,
      item.channel,
      item.recipient,
      item.status,
      item.attempts,
      item.sentAt,
      item.lastError,
    ]),
  );
}

// ---------------------------------------------------------------------------
// The bell
// ---------------------------------------------------------------------------

export interface NotificationDto {
  id: string;
  tenantId: string | null;
  /** Set in the lists across tenants: the tenant's name, for the entry and its links. */
  tenant?: { id: string; name: string };
  level: "info" | "warning" | "error";
  event: string;
  message: string;
  details: Record<string, unknown> | null;
  read: boolean;
  createdAt: string;
}

const BELL_LIMIT = 30;

/** The bell's list: the newest entries, how many are unread and how many of those need attention. */
export interface BellListDto {
  items: NotificationDto[];
  unread: number;
  /**
   * Of the unread ones, those that are not merely informational (a warning or
   * an error: a failed job, a failed restore check). The bell shows red only
   * for these; an unread "Restore completed" never makes it red.
   */
  unreadAttention: number;
}

/** What the unread count of the bell selects: all unread rows and those above "info". */
const UNREAD_COUNTS = {
  unread: sql<number>`count(*)::int`,
  unreadAttention: sql<number>`(count(*) filter (where ${notifications.level} <> 'info'))::int`,
};

export interface NotificationScope {
  /**
   * The installation pool. Given for provider administrators, whose bell also
   * carries the installation-level notifications (no tenant: an update is
   * available, an update finished), which Row Level Security hides from a
   * tenant-pinned session.
   */
  installation?: Database;
}

function toNotificationDto(row: typeof notifications.$inferSelect): NotificationDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    level: row.level,
    event: row.event,
    message: row.message,
    details: row.details ?? null,
    read: row.readAt !== null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The installation-level notifications alone (no tenant: an update is available, an update
 * finished) and how many are unread, for a provider administrator who has no tenant open. On
 * the installation pool: Row Level Security hides these rows from a tenant-pinned session.
 */
export async function listInstallationNotifications(installation: Database): Promise<BellListDto> {
  const rows = await installation
    .select()
    .from(notifications)
    .where(isNull(notifications.tenantId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(BELL_LIMIT);
  const [count] = await installation
    .select(UNREAD_COUNTS)
    .from(notifications)
    .where(and(isNull(notifications.tenantId), isNull(notifications.readAt)));
  return {
    items: rows.map(toNotificationDto),
    unread: count?.unread ?? 0,
    unreadAttention: count?.unreadAttention ?? 0,
  };
}

/** Mark installation-level notifications read (some by id, or all). */
export async function markInstallationNotificationsRead(
  installation: Database,
  input: MarkNotificationsReadInput,
  now: Date,
): Promise<{ updated: number }> {
  const target =
    input.all === true
      ? isNull(notifications.tenantId)
      : and(isNull(notifications.tenantId), inArray(notifications.id, input.ids ?? []));
  const rows = await installation
    .update(notifications)
    .set({ readAt: now })
    .where(and(target, isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return { updated: rows.length };
}

export interface NotificationPageDto {
  items: NotificationDto[];
  /** Pass as `before` for the next older page; null at the end. */
  next: string | null;
}

/** Older notifications than `before`, filtered: the notifications page behind the bell. */
function notificationFilters(query: ListNotificationsQuery): SQL[] {
  const filters: SQL[] = [];
  if (query.before) filters.push(lt(notifications.createdAt, new Date(query.before)));
  if (query.level === "attention") filters.push(ne(notifications.level, "info"));
  else if (query.level) filters.push(eq(notifications.level, query.level));
  if (query.unread) filters.push(isNull(notifications.readAt));
  return filters;
}

function notificationPage(
  rows: (typeof notifications.$inferSelect)[],
  limit: number,
): NotificationPageDto {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(toNotificationDto),
    next: rows.length > limit && last ? last.createdAt.toISOString() : null,
  };
}

/** The tenant's notification history, newest first, a page at a time (beyond the bell's 30). */
export async function listNotificationHistory(
  db: Database,
  tenantId: string,
  query: ListNotificationsQuery,
): Promise<NotificationPageDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(notifications)
      .where(and(eq(notifications.tenantId, tenantId), ...notificationFilters(query)))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(query.limit + 1);
    return notificationPage(rows, query.limit);
  });
}

/**
 * Every covered tenant's notifications in one list, each with its tenant, for a provider
 * administrator under "All tenants" (the bell and the notifications page). On the installation
 * pool; `tenantIds` null covers every tenant. Installation-level entries (no tenant) are part of it.
 */
export async function listProviderNotifications(
  installation: Database,
  tenantIds: readonly string[] | null,
  query: ListNotificationsQuery,
): Promise<NotificationPageDto & { unread: number; unreadAttention: number }> {
  const scope =
    tenantIds === null
      ? undefined
      : tenantIds.length === 0
        ? isNull(notifications.tenantId)
        : sql`(${notifications.tenantId} IS NULL OR ${inArray(notifications.tenantId, [...tenantIds])})`;
  const rows = await installation
    .select()
    .from(notifications)
    .where(and(scope, ...notificationFilters(query)))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(query.limit + 1);
  const [count] = await installation
    .select(UNREAD_COUNTS)
    .from(notifications)
    .where(and(scope, isNull(notifications.readAt)));
  const page = notificationPage(rows, query.limit);
  const items = await withTenantNames(
    installation,
    page.items as (NotificationDto & { tenant?: { id: string; name: string } })[],
    (item) => item.tenantId ?? "",
  );
  return {
    items,
    next: page.next,
    unread: count?.unread ?? 0,
    unreadAttention: count?.unreadAttention ?? 0,
  };
}

/** Mark notifications of the covered tenants read across tenants (some by id, or all). */
export async function markProviderNotificationsRead(
  installation: Database,
  tenantIds: readonly string[] | null,
  input: MarkNotificationsReadInput,
  now: Date,
): Promise<{ updated: number }> {
  const scope =
    tenantIds === null
      ? undefined
      : tenantIds.length === 0
        ? isNull(notifications.tenantId)
        : sql`(${notifications.tenantId} IS NULL OR ${inArray(notifications.tenantId, [...tenantIds])})`;
  const target =
    input.all === true ? scope : and(scope, inArray(notifications.id, input.ids ?? []));
  const rows = await installation
    .update(notifications)
    .set({ readAt: now })
    .where(and(target, isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return { updated: rows.length };
}

/** The newest notifications of the tenant, and how many are unread. */
export async function listNotifications(
  db: Database,
  tenantId: string,
  scope: NotificationScope = {},
): Promise<BellListDto> {
  const own = await withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(notifications)
      .where(eq(notifications.tenantId, tenantId))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(BELL_LIMIT);
    const [count] = await tx
      .select(UNREAD_COUNTS)
      .from(notifications)
      .where(and(eq(notifications.tenantId, tenantId), isNull(notifications.readAt)));
    return {
      rows,
      unread: count?.unread ?? 0,
      unreadAttention: count?.unreadAttention ?? 0,
    };
  });
  if (!scope.installation) {
    return {
      items: own.rows.map(toNotificationDto),
      unread: own.unread,
      unreadAttention: own.unreadAttention,
    };
  }
  const installationRows = await scope.installation
    .select()
    .from(notifications)
    .where(isNull(notifications.tenantId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(BELL_LIMIT);
  const [installationCount] = await scope.installation
    .select(UNREAD_COUNTS)
    .from(notifications)
    .where(and(isNull(notifications.tenantId), isNull(notifications.readAt)));
  const merged = [...own.rows, ...installationRows]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
    .slice(0, BELL_LIMIT);
  return {
    items: merged.map(toNotificationDto),
    unread: own.unread + (installationCount?.unread ?? 0),
    unreadAttention: own.unreadAttention + (installationCount?.unreadAttention ?? 0),
  };
}

export async function markNotificationsRead(
  db: Database,
  tenantId: string,
  input: MarkNotificationsReadInput,
  now: Date,
  scope: NotificationScope = {},
): Promise<{ updated: number }> {
  const own = await withTenantTx(db, tenantId, async (tx) => {
    const target =
      input.all === true
        ? eq(notifications.tenantId, tenantId)
        : and(eq(notifications.tenantId, tenantId), inArray(notifications.id, input.ids ?? []));
    const rows = await tx
      .update(notifications)
      .set({ readAt: now })
      .where(and(target, isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return rows.length;
  });
  if (!scope.installation) {
    return { updated: own };
  }
  const target =
    input.all === true
      ? isNull(notifications.tenantId)
      : and(isNull(notifications.tenantId), inArray(notifications.id, input.ids ?? []));
  const rows = await scope.installation
    .update(notifications)
    .set({ readAt: now })
    .where(and(target, isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return { updated: own + rows.length };
}
