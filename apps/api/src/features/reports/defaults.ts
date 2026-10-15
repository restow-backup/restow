import {
  catalogEventsOf,
  isInstallationReportEvent,
  isReportEvent,
  nextRunAt,
  REPORT_EVENT_INFO,
  type ReportEvent,
  type ReportEventLevel,
} from "@restow/core";
import { type NewReportRule, type ReportRule, reportRules } from "@restow/db";
import { createI18n } from "@restow/i18n";
import { and, eq, isNull } from "drizzle-orm";
import type { DbExecutor } from "../../lib/tenant-context.js";

/**
 * The notification recipients of a tenant and the rules that carry them. Each recipient has a
 * column in the notification matrix: the events it is mailed about, plus `report.weekly` for the
 * weekly report (`tenant_notification_recipients.events`). The rules are what sends: the worker
 * raises an event, every enabled rule that lists it queues its deliveries
 * (apps/worker/src/reporting.ts), and a delivery to a recipient whose column has the event off is
 * left out there (plannedDeliveries in packages/core). Saving the recipients brings the rules
 * marked with `recipientCategory` up to date in the same transaction:
 *
 *   jobFailures, readinessRed  the two rules the 0010 migration made from the earlier flags, kept
 *                              with their events (an administrator may have changed them); their
 *                              addresses are the recipients who want any of those events;
 *   weeklyReport               the weekly summary, for the recipients with `report.weekly`;
 *   errors, warnings, notices  every other event some recipient wants, one rule per severity, so
 *                              that a success notice never throttles an error about the same
 *                              mailbox; their events follow the recipients.
 *
 * The wizard's categories (and the API's) are shortcuts for sets of events.
 */

/** The categories a recipient could choose before the matrix; still accepted as shortcuts. */
export type WizardCategory = "jobFailures" | "weeklyReport" | "readinessRed" | "licenseUpdates";

/** A recipient's entry for the weekly report (the report is no event). */
export const WEEKLY_REPORT_ENTRY = "report.weekly";

/** The categories that have a rule. */
export const RECIPIENT_RULE_CATEGORIES = [
  "jobFailures",
  "readinessRed",
  "weeklyReport",
  "errors",
  "warnings",
  "notices",
] as const;
export type RecipientRuleCategory = (typeof RECIPIENT_RULE_CATEGORIES)[number];

/** The rules for whatever the two fixed event rules do not cover, by severity. */
const LEVEL_CATEGORIES: readonly {
  category: "errors" | "warnings" | "notices";
  level: ReportEventLevel;
}[] = [
  { category: "errors", level: "error" },
  { category: "warnings", level: "warning" },
  { category: "notices", level: "info" },
];

export interface WizardRecipient {
  readonly email: string;
  /** Catalog events and {@link WEEKLY_REPORT_ENTRY}. */
  readonly events: readonly string[];
}

const WEEKLY_CRON = "0 7 * * 1";

/** The events the two fixed event categories listen for (when they make their rule). */
export const RECIPIENT_RULE_EVENTS = {
  jobFailures: ["backup.failed", "restore.failed", "archive.failed", "directory.failed"],
  readinessRed: ["verify.red", "scrub.corrupt"],
} as const satisfies Record<string, readonly ReportEvent[]>;

/** The events a category stands for ("licence and update notices" never had any). */
export const CATEGORY_EVENTS: Readonly<Record<WizardCategory, readonly string[]>> = {
  jobFailures: RECIPIENT_RULE_EVENTS.jobFailures,
  readinessRed: RECIPIENT_RULE_EVENTS.readinessRed,
  weeklyReport: [WEEKLY_REPORT_ENTRY],
  licenseUpdates: [],
};

/** Whether `value` may be in a recipient's column. */
export function isRecipientEntry(value: string): boolean {
  return value === WEEKLY_REPORT_ENTRY || isReportEvent(value);
}

/** A recipient's column, in catalog order and without duplicates or unknown names. */
export function normalizeRecipientEvents(events: readonly string[]): string[] {
  return [
    ...catalogEventsOf(events),
    ...(events.includes(WEEKLY_REPORT_ENTRY) ? [WEEKLY_REPORT_ENTRY] : []),
  ];
}

/** The events of the chosen categories. */
export function eventsOfCategories(categories: readonly WizardCategory[]): string[] {
  return normalizeRecipientEvents(categories.flatMap((category) => CATEGORY_EVENTS[category]));
}

/** The categories whose events a column holds completely (the view of older clients). */
export function categoriesOfEvents(events: readonly string[]): WizardCategory[] {
  return (["jobFailures", "weeklyReport", "readinessRed"] as const).filter((category) =>
    CATEGORY_EVENTS[category].every((event) => events.includes(event)),
  );
}

/**
 * The addresses of the recipients who want any of `events`: trimmed, lowercased and unique, in
 * the order they were given.
 */
export function addressesFor(
  recipients: readonly WizardRecipient[],
  events: readonly string[],
): string[] {
  const seen = new Set<string>();
  return recipients
    .filter((recipient) => recipient.events.some((event) => events.includes(event)))
    .map((recipient) => recipient.email.trim().toLowerCase())
    .filter((email) => email.length > 0 && !seen.has(email) && Boolean(seen.add(email)));
}

interface RuleContext {
  tenantId: string;
  language: "de" | "en" | null;
  timeZone: string | null;
  createdBy: string | null;
  now: Date;
}

/** The rule that carries `category`, for `addresses` (and, for an event rule, `events`). */
export function recipientRuleFor(
  category: RecipientRuleCategory,
  addresses: readonly string[],
  context: RuleContext,
  events?: readonly string[],
): NewReportRule {
  // The rule names are stored with the rule, in the tenant's language (the
  // translation files carry them, `reports:defaultRules.*`).
  const i18n = createI18n({ lng: context.language === "de" ? "de" : "en" });
  const name = String(i18n.t(`reports:defaultRules.${category}`));
  const common = {
    tenantId: context.tenantId,
    name,
    recipientCategory: category,
    emailRecipients: [...addresses],
    createdBy: context.createdBy,
  };
  if (category === "weeklyReport") {
    const timezone = context.timeZone?.trim() || "UTC";
    return {
      ...common,
      trigger: "schedule",
      cron: WEEKLY_CRON,
      timezone,
      periodDays: 7,
      sections: ["backups", "readiness", "failures", "storage", "restores"],
      nextRunAt: nextRunAt({ cron: WEEKLY_CRON, timezone }, { now: context.now }),
    };
  }
  const listened =
    category === "jobFailures" || category === "readinessRed"
      ? RECIPIENT_RULE_EVENTS[category]
      : (events ?? []);
  return {
    ...common,
    trigger: "event",
    events: [...listened],
    // A notice (a backup succeeded, a restore is ready) is worth every message.
    ...(category === "notices" ? { throttleMinutes: 0 } : {}),
  };
}

/** The events of `level` the recipients want and no rule in `covered` listens for. */
function levelEvents(
  recipients: readonly WizardRecipient[],
  level: ReportEventLevel,
  covered: ReadonlySet<string>,
): ReportEvent[] {
  return catalogEventsOf(recipients.flatMap((recipient) => recipient.events)).filter(
    (event) => REPORT_EVENT_INFO[event].level === level && !covered.has(event),
  );
}

/** The rules for `recipients` when none exists yet (a new tenant); pure, so the grouping is tested alone. */
export function rulesFromRecipients(
  input: RuleContext & {
    recipients: readonly WizardRecipient[];
    /** Whether time-triggered reports are on (`reports.timed`, lib/features.ts). */
    scheduledAllowed: boolean;
  },
): NewReportRule[] {
  const rules: NewReportRule[] = [];
  const covered = new Set<string>();
  for (const category of ["jobFailures", "readinessRed"] as const) {
    const events = RECIPIENT_RULE_EVENTS[category];
    const addresses = addressesFor(input.recipients, events);
    if (addresses.length > 0) {
      rules.push(recipientRuleFor(category, addresses, input));
      for (const event of events) covered.add(event);
    }
  }
  const weekly = addressesFor(input.recipients, [WEEKLY_REPORT_ENTRY]);
  if (weekly.length > 0 && input.scheduledAllowed) {
    rules.push(recipientRuleFor("weeklyReport", weekly, input));
  }
  for (const { category, level } of LEVEL_CATEGORIES) {
    const events = levelEvents(input.recipients, level, covered);
    const addresses = addressesFor(input.recipients, events);
    if (addresses.length > 0) {
      rules.push(recipientRuleFor(category, addresses, input, events));
    }
  }
  return rules;
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((entry) => left.has(entry));
};

/** Whether an unmarked rule is the one this category used to make by hand or by the wizard. */
function looksLikeRuleOf(category: RecipientRuleCategory, rule: ReportRule): boolean {
  if (category === "weeklyReport") {
    return rule.trigger === "schedule" && rule.cron === WEEKLY_CRON;
  }
  if (category === "jobFailures" || category === "readinessRed") {
    return rule.trigger === "event" && sameSet(rule.events, RECIPIENT_RULE_EVENTS[category]);
  }
  return false;
}

export interface RecipientRuleChange {
  created: number;
  updated: number;
  adopted: number;
  removed: number;
}

/**
 * Make the tenant's rules follow its recipients, inside the transaction that saves them.
 *
 * Each category with recipients has exactly one rule marked for it: created when missing, else its
 * e-mail recipients are replaced (nothing else of a fixed rule is touched, so an administrator can
 * still change its events, throttle or add a webhook; the severity rules' events follow the
 * recipients as well). A rule an earlier release made for a fixed category, unmarked, is taken over
 * when every address on it was a recipient before or is one now, so that nothing an administrator
 * typed into it is lost and nobody is mailed twice. A category nobody wants any more loses its
 * addresses; the rule goes with them unless it still has a webhook or the bell to serve. The
 * weekly report needs `reports.timed`; without it that rule is neither created nor changed, and
 * the recipients keep their choice for when it becomes available.
 */
export async function syncRecipientRules(
  tx: DbExecutor,
  input: RuleContext & {
    recipients: readonly WizardRecipient[];
    /** The recipients as they were before this save (empty for a new tenant). */
    previous: readonly WizardRecipient[];
    scheduledAllowed: boolean;
  },
): Promise<RecipientRuleChange> {
  const change: RecipientRuleChange = { created: 0, updated: 0, adopted: 0, removed: 0 };
  const known = new Set(
    [...input.previous, ...input.recipients].map((recipient) =>
      recipient.email.trim().toLowerCase(),
    ),
  );
  // The events a fixed rule (still) listens for, for the recipients who want them.
  const covered = new Set<string>();
  for (const category of RECIPIENT_RULE_CATEGORIES) {
    if (category === "weeklyReport" && !input.scheduledAllowed) {
      continue;
    }
    const rules = await tx
      .select()
      .from(reportRules)
      .where(eq(reportRules.tenantId, input.tenantId));
    let rule = rules.find((candidate) => candidate.recipientCategory === category) ?? null;
    if (!rule) {
      const taken = rules.find(
        (candidate) =>
          candidate.recipientCategory === null &&
          looksLikeRuleOf(category, candidate) &&
          candidate.emailRecipients.every((email) => known.has(email.trim().toLowerCase())),
      );
      if (taken) {
        await tx
          .update(reportRules)
          .set({ recipientCategory: category, updatedAt: input.now })
          .where(and(eq(reportRules.id, taken.id), isNull(reportRules.recipientCategory)));
        rule = { ...taken, recipientCategory: category };
        change.adopted += 1;
      }
    }
    const level = LEVEL_CATEGORIES.find((entry) => entry.category === category)?.level;
    let events: readonly string[];
    if (category === "weeklyReport") {
      events = [WEEKLY_REPORT_ENTRY];
    } else if (level) {
      events = levelEvents(input.recipients, level, covered);
    } else {
      events = rule?.events ?? RECIPIENT_RULE_EVENTS[category as "jobFailures" | "readinessRed"];
    }
    const addresses = addressesFor(input.recipients, events);
    if (!rule) {
      if (addresses.length > 0) {
        await tx.insert(reportRules).values(recipientRuleFor(category, addresses, input, events));
        change.created += 1;
        if (!level) for (const event of events) covered.add(event);
      }
      continue;
    }
    if (addresses.length === 0 && !rule.webhookId && !(rule.trigger === "schedule" && rule.inApp)) {
      await tx.delete(reportRules).where(eq(reportRules.id, rule.id));
      change.removed += 1;
      continue;
    }
    if (!level && addresses.length > 0) {
      for (const event of events) covered.add(event);
    }
    const patch: Partial<NewReportRule> = {};
    if (
      !sameSet(
        rule.emailRecipients.map((email) => email.trim().toLowerCase()),
        addresses,
      )
    ) {
      patch.emailRecipients = addresses;
    }
    if (level && events.length > 0 && !sameSet(rule.events, events)) {
      patch.events = [...events];
    }
    if (Object.keys(patch).length > 0) {
      await tx
        .update(reportRules)
        .set({ ...patch, updatedAt: input.now })
        .where(eq(reportRules.id, rule.id));
      change.updated += 1;
    }
  }
  return change;
}

/**
 * A recipient's column after a save by someone who may not choose installation events (a tenant
 * administrator): the installation events it had stay as they were, none is added.
 */
export function keepInstallationEvents(
  next: readonly string[],
  previous: readonly string[] | undefined,
): string[] {
  return normalizeRecipientEvents([
    ...next.filter((event) => !isInstallationReportEvent(event)),
    ...(previous ?? []).filter((event) => isInstallationReportEvent(event)),
  ]);
}
