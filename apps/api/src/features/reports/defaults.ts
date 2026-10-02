import { nextRunAt } from "@restow/core";
import { type NewReportRule, type ReportRule, reportRules } from "@restow/db";
import { createI18n } from "@restow/i18n";
import { and, eq, isNull } from "drizzle-orm";
import type { DbExecutor } from "../../lib/tenant-context.js";

/**
 * The notification recipients of a tenant and the rules that carry them. A recipient chooses
 * categories (failed jobs, a readiness turning red, the weekly report); each category is one rule
 * of the tenant, marked with `recipientCategory`, whose e-mail recipients are exactly the
 * recipients who chose it. The rules are what sends: the worker raises an event, every enabled rule
 * that lists it queues its deliveries (apps/worker/src/reporting.ts), so saving the recipients
 * changes who is mailed from the next alert on. The same three rules the 0010 migration made from
 * the earlier recipient flags. "Licence and update notices" have no event yet and create nothing.
 */

export type WizardCategory = "jobFailures" | "weeklyReport" | "readinessRed" | "licenseUpdates";

/** The categories that have a rule. */
export const RECIPIENT_RULE_CATEGORIES = ["jobFailures", "readinessRed", "weeklyReport"] as const;
export type RecipientRuleCategory = (typeof RECIPIENT_RULE_CATEGORIES)[number];

export interface WizardRecipient {
  readonly email: string;
  readonly categories: readonly WizardCategory[];
}

const WEEKLY_CRON = "0 7 * * 1";

/** The events each event category listens for. */
export const RECIPIENT_RULE_EVENTS = {
  jobFailures: ["backup.failed", "restore.failed", "archive.failed", "directory.failed"],
  readinessRed: ["verify.red", "scrub.corrupt"],
} as const;

/**
 * The addresses of the recipients who chose `category`: trimmed, lowercased and unique, in the
 * order they were given.
 */
export function addressesFor(
  recipients: readonly WizardRecipient[],
  category: WizardCategory,
): string[] {
  const seen = new Set<string>();
  return recipients
    .filter((recipient) => recipient.categories.includes(category))
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

/** The rule that carries `category`, for `addresses`; null when the category has no rule. */
export function recipientRuleFor(
  category: RecipientRuleCategory,
  addresses: readonly string[],
  context: RuleContext,
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
  return { ...common, trigger: "event", events: [...RECIPIENT_RULE_EVENTS[category]] };
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
  for (const category of RECIPIENT_RULE_CATEGORIES) {
    const addresses = addressesFor(input.recipients, category);
    if (addresses.length === 0 || (category === "weeklyReport" && !input.scheduledAllowed)) {
      continue;
    }
    rules.push(recipientRuleFor(category, addresses, input));
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
  return rule.trigger === "event" && sameSet(rule.events, RECIPIENT_RULE_EVENTS[category]);
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
 * e-mail recipients are replaced (nothing else of the rule is touched, so an administrator can
 * still change its events, throttle or add a webhook). A rule an earlier release made for the
 * category, unmarked, is taken over when every address on it was a recipient before or is one now,
 * so that nothing an administrator typed into it is lost and nobody is mailed twice. A category
 * nobody chose any more loses its addresses; the rule goes with them unless it still has a
 * webhook or the bell to serve. The weekly report needs `reports.timed`; without it that rule is
 * neither created nor changed, and the recipients keep their choice for when it becomes available.
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
  for (const category of RECIPIENT_RULE_CATEGORIES) {
    if (category === "weeklyReport" && !input.scheduledAllowed) {
      continue;
    }
    const addresses = addressesFor(input.recipients, category);
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
    if (!rule) {
      if (addresses.length > 0) {
        await tx.insert(reportRules).values(recipientRuleFor(category, addresses, input));
        change.created += 1;
      }
      continue;
    }
    if (addresses.length === 0 && !rule.webhookId && !(rule.trigger === "schedule" && rule.inApp)) {
      await tx.delete(reportRules).where(eq(reportRules.id, rule.id));
      change.removed += 1;
      continue;
    }
    if (
      !sameSet(
        rule.emailRecipients.map((email) => email.trim().toLowerCase()),
        addresses,
      )
    ) {
      await tx
        .update(reportRules)
        .set({ emailRecipients: addresses, updatedAt: input.now })
        .where(eq(reportRules.id, rule.id));
      change.updated += 1;
    }
  }
  return change;
}
