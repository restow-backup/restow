import {
  completeDeliveryModes,
  type DeliveryModes,
  FLOOR_REPORT_EVENTS,
  INSTALLATION_REPORT_EVENTS,
  isCriticalReportEvent,
  isInstallationReportEvent,
  isPlainEmail,
  isReportEvent,
  isSummaryEntry,
  nextRunAt,
  REPORT_CADENCES,
  REPORT_EVENT_INFO,
  REPORT_EVENTS,
  type ReportCadence,
  type ReportEvent,
  reportPeriod,
  SUMMARY_ENTRIES,
  storedDeliveryModes,
} from "@restow/core";
import {
  type Database,
  type ProviderNotificationRecipient,
  type ProviderReportRule,
  providerMembers,
  providerNotificationRecipients,
  providerReportRules,
  providers,
  reportDeliveries,
  user,
} from "@restow/db";
import { createI18n, defaultLanguage } from "@restow/i18n";
import { and, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../../lib/audit.js";
import { featureEnabled, requireFeature } from "../../lib/features.js";
import { loadInstallationTimeZone } from "../../lib/installation-time-zone.js";
import type { DbExecutor } from "../../lib/tenant-context.js";
import type { Notifier } from "../../notify.js";
import { ProblemError } from "../../problem.js";

/**
 * The provider's notification recipients and its summary reports across tenants (0.5.0,
 * docs/NOTIFICATIONS.md). In every edition:
 *
 *   - The owners of the provider team (a provider admin without a team row, or with the role
 *     `owner`) are recipients of their own (`kind = 'owner'`), kept in step with the team: they
 *     cannot be removed while they are owners.
 *   - The owners and the recipients an owner marked `mandatory` are the floor: they always get the
 *     critical events and the failed deliveries, whatever their column says, so an alert can never
 *     end with nobody.
 *   - Each recipient has a column of events (catalog events, installation events and the summary
 *     reports `report.daily|weekly|monthly`) and a digest mode per severity.
 *
 * The summary reports across tenants need `reports.timed` (Business). The dispatcher fans every
 * event out to these recipients (features/reports/fanout.ts); their deliveries carry no tenant,
 * so no tenant session can ever see the provider's addresses (Row Level Security).
 */

export const PROVIDER_RECIPIENT_AUDIT_ACTIONS = {
  updated: "provider_notifications.recipients_updated",
  testSent: "provider_notifications.test_sent",
  summaryUpdated: "provider_notifications.summary_updated",
  summaryTestSent: "provider_notifications.summary_test_sent",
} as const;

export const INVALID_RECIPIENTS_PROBLEM = "urn:restow:problem:invalid-recipients";
export const MAX_PROVIDER_RECIPIENTS = 50;

export interface ProviderActor {
  readonly id: string;
  readonly email: string;
  readonly ip: string | null;
  /** The actor is an owner of the provider team (may set `mandatory`). */
  readonly owner: boolean;
}

const deliveryModeSchema = z.enum(["immediate", "hourly", "daily"]);
export const deliveryModesSchema = z
  .object({
    error: deliveryModeSchema.optional(),
    warning: deliveryModeSchema.optional(),
    info: deliveryModeSchema.optional(),
  })
  .strict();

export const providerRecipientsSchema = z
  .object({
    recipients: z
      .array(
        z
          .object({
            id: z.uuid().optional(),
            email: z.string().trim().toLowerCase().max(254),
            name: z.string().trim().max(200).nullable().optional(),
            mandatory: z.boolean().optional(),
            events: z.array(z.string().max(80)).max(200),
            delivery: deliveryModesSchema.optional(),
            language: z.enum(["de", "en"]).nullable().optional(),
          })
          .strict(),
      )
      .max(MAX_PROVIDER_RECIPIENTS),
  })
  .strict();

export type ProviderRecipientsInput = z.infer<typeof providerRecipientsSchema>;

export interface RecipientFailureDto {
  since: string;
  reason: string;
  detail: string | null;
}

export interface ProviderRecipientDto {
  id: string;
  email: string;
  name: string | null;
  kind: "owner" | "member";
  mandatory: boolean;
  userId: string | null;
  events: string[];
  delivery: Record<"error" | "warning" | "info", "immediate" | "hourly" | "daily">;
  language: "de" | "en" | null;
  /** Events this recipient gets whatever its column says (the floor's). */
  lockedEvents: ReportEvent[];
  failure: RecipientFailureDto | null;
}

export interface ProviderRecipientsView {
  events: {
    name: ReportEvent;
    group: string;
    level: string;
    critical: boolean;
    installation: boolean;
  }[];
  summaryAvailable: boolean;
  floorEvents: ReportEvent[];
  canEditMandatory: boolean;
  recipients: ProviderRecipientDto[];
}

/** Whether a recipient is on the floor (an owner, or marked mandatory). */
export function isFloorRecipient(row: Pick<ProviderNotificationRecipient, "kind" | "mandatory">) {
  return row.kind === "owner" || row.mandatory;
}

/** A recipient's column: catalog events (installation events included) and summary entries. */
export function normalizeProviderEvents(events: readonly string[]): string[] {
  return [
    ...REPORT_EVENTS.filter((event) => events.includes(event)),
    ...SUMMARY_ENTRIES.filter((entry) => events.includes(entry)),
  ];
}

/** What a new owner's column starts with: the floor and the installation events. */
export const OWNER_DEFAULT_EVENTS: readonly string[] = normalizeProviderEvents([
  ...FLOOR_REPORT_EVENTS,
  ...INSTALLATION_REPORT_EVENTS,
]);

async function providerIdOf(db: DbExecutor): Promise<string> {
  const [row] = await db.select({ id: providers.id }).from(providers).limit(1);
  if (!row) {
    throw new ProblemError(409, "Setup required", {
      type: "urn:restow:problem:setup-required",
      detail: "Finish the setup wizard first.",
    });
  }
  return row.id;
}

/** The owners of the provider team: provider admins without a team row, or with `owner`. */
export async function providerOwners(
  db: DbExecutor,
): Promise<{ id: string; email: string; name: string }[]> {
  return db
    .select({ id: user.id, email: user.email, name: user.name })
    .from(user)
    .leftJoin(providerMembers, eq(providerMembers.userId, user.id))
    .where(
      and(
        eq(user.role, "admin"),
        or(isNull(user.banned), eq(user.banned, false)),
        or(isNull(providerMembers.id), eq(providerMembers.role, "owner")),
      ),
    );
}

let lastOwnerSync = 0;

/**
 * Keep the owners' rows in step with the team: an owner without a row gets one (or takes over a
 * row with its address), a row whose person is no longer an owner becomes an ordinary recipient.
 * Runs on the installation pool after every change of the team, when the list is read or saved,
 * and at most once a minute before the dispatcher fans events out (`throttle`).
 */
export async function syncOwnerRecipients(
  db: DbExecutor,
  now: Date = new Date(),
  options: { throttle?: boolean } = {},
): Promise<void> {
  if (options.throttle && now.getTime() - lastOwnerSync < 60_000) {
    return;
  }
  lastOwnerSync = now.getTime();
  const [provider] = await db.select({ id: providers.id }).from(providers).limit(1);
  if (!provider) {
    return;
  }
  const owners = await providerOwners(db);
  const rows = await db.select().from(providerNotificationRecipients);
  const ownerIds = new Set(owners.map((owner) => owner.id));
  for (const row of rows) {
    if (row.kind === "owner" && (!row.userId || !ownerIds.has(row.userId))) {
      await db
        .update(providerNotificationRecipients)
        .set({ kind: "member", updatedAt: now })
        .where(eq(providerNotificationRecipients.id, row.id));
    }
  }
  for (const owner of owners) {
    const email = owner.email.trim().toLowerCase();
    if (!isPlainEmail(email)) {
      continue;
    }
    const byUser = rows.find((row) => row.userId === owner.id);
    const byEmail = rows.find((row) => row.email.trim().toLowerCase() === email);
    const existing = byUser ?? byEmail;
    if (existing) {
      if (existing.kind !== "owner" || existing.userId !== owner.id || existing.email !== email) {
        // Another row may already hold the new address: the owner's own row wins.
        if (byEmail && byUser && byEmail.id !== byUser.id) {
          await db
            .delete(providerNotificationRecipients)
            .where(eq(providerNotificationRecipients.id, byEmail.id));
        }
        await db
          .update(providerNotificationRecipients)
          .set({ kind: "owner", userId: owner.id, email, updatedAt: now })
          .where(eq(providerNotificationRecipients.id, existing.id));
      }
      continue;
    }
    await db
      .insert(providerNotificationRecipients)
      .values({
        providerId: provider.id,
        email,
        name: owner.name?.trim() || null,
        kind: "owner",
        userId: owner.id,
        events: [...OWNER_DEFAULT_EVENTS],
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
}

function recipientDto(row: ProviderNotificationRecipient): ProviderRecipientDto {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    kind: row.kind,
    mandatory: row.mandatory,
    userId: row.userId,
    events: normalizeProviderEvents(row.events),
    delivery: completeDeliveryModes(row.delivery as DeliveryModes),
    language: row.language,
    lockedEvents: isFloorRecipient(row) ? [...FLOOR_REPORT_EVENTS] : [],
    failure: row.failingSince
      ? {
          since: row.failingSince.toISOString(),
          reason: row.lastFailureReason ?? "transport_error",
          detail: null,
        }
      : null,
  };
}

/** GET /settings/notification-recipients. */
export async function getProviderRecipients(
  db: DbExecutor,
  viewerIsOwner: boolean,
): Promise<ProviderRecipientsView> {
  await syncOwnerRecipients(db);
  const rows = await db
    .select()
    .from(providerNotificationRecipients)
    .orderBy(
      sql`CASE WHEN ${providerNotificationRecipients.kind} = 'owner' THEN 0 ELSE 1 END`,
      providerNotificationRecipients.createdAt,
    );
  return {
    events: REPORT_EVENTS.map((name) => ({
      name,
      group: REPORT_EVENT_INFO[name].group,
      level: REPORT_EVENT_INFO[name].level,
      critical: isCriticalReportEvent(name),
      installation: isInstallationReportEvent(name),
    })),
    summaryAvailable: await featureEnabled("reports.timed", db),
    floorEvents: [...FLOOR_REPORT_EVENTS],
    canEditMandatory: viewerIsOwner,
    recipients: rows.map(recipientDto),
  };
}

function invalidRecipients(code: string, detail: string, extra: object = {}): ProblemError {
  return new ProblemError(422, "Invalid recipients", {
    type: INVALID_RECIPIENTS_PROBLEM,
    detail,
    extensions: { code, field: "recipients", ...extra },
  });
}

/** PUT /settings/notification-recipients: replace the list (the owners stay). */
export async function putProviderRecipients(
  db: Database,
  input: ProviderRecipientsInput,
  actor: ProviderActor,
  now: Date = new Date(),
): Promise<ProviderRecipientsView> {
  await syncOwnerRecipients(db, now);
  const providerId = await providerIdOf(db);
  const existing = await db.select().from(providerNotificationRecipients);
  const byId = new Map(existing.map((row) => [row.id, row]));
  const seen = new Set<string>();
  for (const entry of input.recipients) {
    if (!isPlainEmail(entry.email.trim().toLowerCase())) {
      throw invalidRecipients("invalid-email", `${entry.email} is not a valid address.`, {
        email: entry.email,
      });
    }
    const unknown = entry.events.filter((event) => !isReportEvent(event) && !isSummaryEntry(event));
    if (unknown.length > 0) {
      throw invalidRecipients("unknown-event", `Unknown events: ${unknown.join(", ")}.`, {
        unknown,
      });
    }
  }
  // The owners' rows are kept with their own addresses; a duplicate is any address twice.
  const resolved = input.recipients.map((entry) => {
    const row = entry.id ? byId.get(entry.id) : undefined;
    const email = row?.kind === "owner" ? row.email : entry.email.trim().toLowerCase();
    return { entry, row, email };
  });
  for (const { email } of resolved) {
    if (seen.has(email)) {
      throw invalidRecipients("duplicate", `${email} is listed twice.`, { email });
    }
    seen.add(email);
  }
  const keptIds = new Set(resolved.flatMap(({ row }) => (row ? [row.id] : [])));
  const missingOwner = existing.find((row) => row.kind === "owner" && !keptIds.has(row.id));
  if (missingOwner) {
    throw invalidRecipients(
      "owner-required",
      `${missingOwner.email} is an owner of the provider team and always receives alerts.`,
      { email: missingOwner.email },
    );
  }
  if (!actor.owner) {
    const ownerRequired = (email: string) =>
      new ProblemError(403, "Owner required", {
        type: "urn:restow:problem:owner-required",
        detail: "Only an owner of the provider team may make a recipient mandatory or release it.",
        extensions: { field: "mandatory", email },
      });
    for (const { entry, row, email } of resolved) {
      const before = row?.mandatory ?? false;
      if (entry.mandatory !== undefined && entry.mandatory !== before) {
        throw ownerRequired(email);
      }
      // Redirecting a mandatory recipient to another address releases it just the same.
      if (row?.mandatory && row.email !== email) {
        throw ownerRequired(row.email);
      }
    }
    // So does leaving it out of the list.
    const dropped = existing.find((row) => row.mandatory && !keptIds.has(row.id));
    if (dropped) {
      throw ownerRequired(dropped.email);
    }
  }
  await db.transaction(async (tx) => {
    const keep = [...keptIds];
    await tx
      .delete(providerNotificationRecipients)
      .where(
        and(
          eq(providerNotificationRecipients.kind, "member"),
          keep.length > 0 ? notInArray(providerNotificationRecipients.id, keep) : sql`true`,
        ),
      );
    for (const { entry, row, email } of resolved) {
      const values = {
        name: entry.name?.trim() || null,
        events: normalizeProviderEvents(entry.events),
        delivery: storedDeliveryModes(entry.delivery ?? (row?.delivery as DeliveryModes) ?? {}),
        language: entry.language === undefined ? (row?.language ?? null) : entry.language,
        mandatory: entry.mandatory ?? row?.mandatory ?? false,
        updatedAt: now,
      };
      if (row) {
        await tx
          .update(providerNotificationRecipients)
          .set({
            ...values,
            ...(row.kind === "owner" ? {} : { email }),
            // A changed address starts without the old one's failure episode.
            ...(row.email !== email
              ? { failingSince: null, failureAlertedAt: null, lastFailureReason: null }
              : {}),
          })
          .where(eq(providerNotificationRecipients.id, row.id));
      } else {
        await tx.insert(providerNotificationRecipients).values({
          providerId,
          email,
          kind: "member",
          ...values,
          createdAt: now,
        });
      }
    }
    await syncProviderReportRules(tx, now);
  });
  await audit(db, {
    tenantId: null,
    actor: actor.email,
    actorUserId: actor.id,
    action: PROVIDER_RECIPIENT_AUDIT_ACTIONS.updated,
    target: "provider",
    targetType: "notification_recipients",
    ip: actor.ip,
    details: {
      recipients: input.recipients.length,
      mandatory: resolved.filter(({ entry, row }) => entry.mandatory ?? row?.mandatory).length,
    },
  });
  return getProviderRecipients(db, actor.owner);
}

/** POST /settings/notification-recipients/:id/test: the test notification to one recipient. */
export async function sendProviderRecipientTest(
  db: DbExecutor,
  notifier: Notifier | null,
  id: string,
  actor: ProviderActor,
  fallbackLanguage: "de" | "en",
): Promise<{ to: string }> {
  const [row] = await db
    .select()
    .from(providerNotificationRecipients)
    .where(eq(providerNotificationRecipients.id, id))
    .limit(1);
  if (!row) {
    throw new ProblemError(404, "Recipient not found");
  }
  if (!notifier) {
    throw new ProblemError(409, "Mail transport not configured", {
      type: "urn:restow:problem:mail-not-configured",
      detail: "Configure a mail transport first.",
    });
  }
  const result = await notifier.sendTest(row.email, row.language ?? fallbackLanguage);
  if (!result.ok) {
    throw new ProblemError(502, "The test mail could not be sent", {
      type: "urn:restow:problem:mail-send-failed",
      detail: result.error ?? "The mail transport refused the message.",
      extensions: { reason: result.reason ?? null },
    });
  }
  await audit(db, {
    tenantId: null,
    actor: actor.email,
    actorUserId: actor.id,
    action: PROVIDER_RECIPIENT_AUDIT_ACTIONS.testSent,
    target: row.id,
    targetType: "notification_recipients",
    ip: actor.ip,
    details: {},
  });
  return { to: row.email };
}

// ---------------------------------------------------------------------------
// The provider's summary reports
// ---------------------------------------------------------------------------

/** The cron of a provider report of `cadence` at `hour` (the rule's time zone). */
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

/** The name a provider report is sent under: "Daily report", "Wochenbericht", ... */
export function providerReportName(cadence: ReportCadence, language: "de" | "en"): string {
  const i18n = createI18n({ lng: language });
  return String(i18n.t(`reports:defaultRules.${cadence}Report`));
}

/** The addresses of the provider recipients that chose `report.<cadence>`. */
async function addressesFor(db: DbExecutor, cadence: ReportCadence): Promise<string[]> {
  const rows = await db
    .select({ email: providerNotificationRecipients.email })
    .from(providerNotificationRecipients)
    .where(sql`${`report.${cadence}`} = ANY(${providerNotificationRecipients.events})`);
  return [...new Set(rows.map((row) => row.email.trim().toLowerCase()))];
}

/**
 * Keep each provider report's addresses in step with the recipients that chose it; a report some
 * recipient chose for the first time gets its rule (enabled, 07:00 installation time, with PDF).
 */
export async function syncProviderReportRules(db: DbExecutor, now: Date = new Date()) {
  const zone = (await loadInstallationTimeZone(db)).timeZone;
  const rules = await db.select().from(providerReportRules);
  for (const cadence of REPORT_CADENCES) {
    const addresses = await addressesFor(db, cadence);
    const rule = rules.find((candidate) => candidate.cadence === cadence);
    if (!rule) {
      if (addresses.length === 0) continue;
      await db.insert(providerReportRules).values({
        cadence,
        timezone: zone,
        sendHour: 7,
        emailRecipients: addresses,
        nextRunAt: nextRunAt({ cron: providerReportCron(cadence, 7), timezone: zone }, { now }),
        createdAt: now,
        updatedAt: now,
      });
      continue;
    }
    if (
      JSON.stringify([...rule.emailRecipients].sort()) !== JSON.stringify([...addresses].sort())
    ) {
      await db
        .update(providerReportRules)
        .set({ emailRecipients: addresses, updatedAt: now })
        .where(eq(providerReportRules.id, rule.id));
    }
  }
}

export interface ProviderSummaryReportDto {
  cadence: ReportCadence;
  enabled: boolean;
  attachPdf: boolean;
  sendHour: number;
  recipients: string[];
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastDelivery: { at: string; status: string } | null;
}

async function summaryDto(
  db: DbExecutor,
  cadence: ReportCadence,
  rule: ProviderReportRule | undefined,
): Promise<ProviderSummaryReportDto> {
  const [last] = rule
    ? await db
        .select({ at: reportDeliveries.updatedAt, status: reportDeliveries.status })
        .from(reportDeliveries)
        .where(eq(reportDeliveries.providerRuleId, rule.id))
        .orderBy(desc(reportDeliveries.createdAt))
        .limit(1)
    : [];
  return {
    cadence,
    enabled: rule?.enabled ?? false,
    attachPdf: rule?.attachPdf ?? true,
    sendHour: rule?.sendHour ?? 7,
    recipients: rule?.emailRecipients ?? (await addressesFor(db, cadence)),
    nextRunAt: rule?.nextRunAt?.toISOString() ?? null,
    lastRunAt: rule?.lastRunAt?.toISOString() ?? null,
    lastDelivery: last ? { at: last.at.toISOString(), status: last.status } : null,
  };
}

/** GET /settings/summary-reports: answers in every edition (`available` says whether it works). */
export async function getProviderSummaryReports(db: DbExecutor) {
  const rules = await db.select().from(providerReportRules);
  return {
    available: await featureEnabled("reports.timed", db),
    reports: await Promise.all(
      REPORT_CADENCES.map((cadence) =>
        summaryDto(
          db,
          cadence,
          rules.find((rule) => rule.cadence === cadence),
        ),
      ),
    ),
  };
}

export const summaryReportUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    attachPdf: z.boolean().optional(),
    sendHour: z.number().int().min(0).max(23).optional(),
  })
  .strict();

/** PUT /settings/summary-reports/:cadence (`reports.timed`). */
export async function putProviderSummaryReport(
  db: Database,
  cadence: ReportCadence,
  input: z.infer<typeof summaryReportUpdateSchema>,
  actor: ProviderActor,
  now: Date = new Date(),
): Promise<ProviderSummaryReportDto> {
  await requireFeature("reports.timed", db);
  const zone = (await loadInstallationTimeZone(db)).timeZone;
  const [rule] = await db
    .select()
    .from(providerReportRules)
    .where(eq(providerReportRules.cadence, cadence))
    .limit(1);
  const sendHour = input.sendHour ?? rule?.sendHour ?? 7;
  const timezone = rule?.timezone ?? zone;
  const next = nextRunAt({ cron: providerReportCron(cadence, sendHour), timezone }, { now });
  if (rule) {
    await db
      .update(providerReportRules)
      .set({
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.attachPdf === undefined ? {} : { attachPdf: input.attachPdf }),
        sendHour,
        nextRunAt: next,
        updatedAt: now,
      })
      .where(eq(providerReportRules.id, rule.id));
  } else {
    await db.insert(providerReportRules).values({
      cadence,
      enabled: input.enabled ?? true,
      attachPdf: input.attachPdf ?? true,
      sendHour,
      timezone,
      emailRecipients: await addressesFor(db, cadence),
      nextRunAt: next,
      createdAt: now,
      updatedAt: now,
    });
  }
  await audit(db, {
    tenantId: null,
    actor: actor.email,
    actorUserId: actor.id,
    action: PROVIDER_RECIPIENT_AUDIT_ACTIONS.summaryUpdated,
    target: cadence,
    targetType: "summary_report",
    ip: actor.ip,
    details: { cadence, ...input },
  });
  const [after] = await db
    .select()
    .from(providerReportRules)
    .where(eq(providerReportRules.cadence, cadence))
    .limit(1);
  return summaryDto(db, cadence, after);
}

/** POST /settings/summary-reports/:cadence/test: queue the report for the signed-in user. */
export async function sendProviderSummaryTest(
  db: Database,
  cadence: ReportCadence,
  actor: ProviderActor,
  now: Date = new Date(),
): Promise<{ to: string }> {
  await requireFeature("reports.timed", db);
  const zone = (await loadInstallationTimeZone(db)).timeZone;
  const period = reportPeriod({ cadence }, now, zone);
  const [rule] = await db
    .select()
    .from(providerReportRules)
    .where(eq(providerReportRules.cadence, cadence))
    .limit(1);
  await db.insert(reportDeliveries).values({
    tenantId: null,
    ruleId: null,
    providerRuleId: rule?.id ?? null,
    ruleName: providerReportName(cadence, rule?.language ?? defaultLanguage),
    kind: "summary",
    payload: {
      scope: "provider",
      cadence,
      periodStart: period.start.toISOString(),
      periodEnd: period.end.toISOString(),
      attachPdf: rule?.attachPdf ?? true,
      test: true,
    },
    channel: "email",
    recipient: actor.email,
    status: "pending",
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await audit(db, {
    tenantId: null,
    actor: actor.email,
    actorUserId: actor.id,
    action: PROVIDER_RECIPIENT_AUDIT_ACTIONS.summaryTestSent,
    target: cadence,
    targetType: "summary_report",
    ip: actor.ip,
    details: { cadence },
  });
  return { to: actor.email };
}

/** The provider recipients with these ids (the dispatcher's lookups). */
export async function providerRecipientsById(db: DbExecutor, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(providerNotificationRecipients)
    .where(inArray(providerNotificationRecipients.id, [...ids]));
}
