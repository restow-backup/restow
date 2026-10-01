import { nextRunAt } from "@restow/core";
import { type NewReportRule, reportRules } from "@restow/db";
import { createI18n } from "@restow/i18n";
import type { DbExecutor } from "../../lib/tenant-context.js";

/**
 * The rules the tenant wizard's notification step creates: the same three
 * rules the 0010 migration made from the earlier recipient flags, so a tenant
 * created now and one upgraded look alike. "Licence and update notices" have
 * no event yet and create nothing.
 */

export type WizardCategory = "jobFailures" | "weeklyReport" | "readinessRed" | "licenseUpdates";

export interface WizardRecipient {
  readonly email: string;
  readonly categories: readonly WizardCategory[];
}

const WEEKLY_CRON = "0 7 * * 1";

/** The rules for `recipients`, grouped per category; pure, so the grouping is tested alone. */
export function rulesFromRecipients(input: {
  tenantId: string;
  recipients: readonly WizardRecipient[];
  language: "de" | "en" | null;
  timeZone: string | null;
  createdBy: string | null;
  /** Whether time-triggered reports are on (`reports.timed`, lib/features.ts). */
  scheduledAllowed: boolean;
  now: Date;
}): NewReportRule[] {
  // The rule names are stored with the rule, in the tenant's language (the
  // translation files carry them, `reports:defaultRules.*`).
  const i18n = createI18n({ lng: input.language === "de" ? "de" : "en" });
  const nameOf = (category: "jobFailures" | "readinessRed" | "weeklyReport") =>
    String(i18n.t(`reports:defaultRules.${category}`));
  const who = (category: WizardCategory) => {
    const seen = new Set<string>();
    return input.recipients
      .filter((recipient) => recipient.categories.includes(category))
      .map((recipient) => recipient.email.trim().toLowerCase())
      .filter((email) => email.length > 0 && !seen.has(email) && Boolean(seen.add(email)));
  };
  const rules: NewReportRule[] = [];
  const jobFailures = who("jobFailures");
  if (jobFailures.length > 0) {
    rules.push({
      tenantId: input.tenantId,
      name: nameOf("jobFailures"),
      trigger: "event",
      events: ["backup.failed", "restore.failed", "archive.failed", "directory.failed"],
      emailRecipients: jobFailures,
      createdBy: input.createdBy,
    });
  }
  const readiness = who("readinessRed");
  if (readiness.length > 0) {
    rules.push({
      tenantId: input.tenantId,
      name: nameOf("readinessRed"),
      trigger: "event",
      events: ["verify.red", "scrub.corrupt"],
      emailRecipients: readiness,
      createdBy: input.createdBy,
    });
  }
  const weekly = who("weeklyReport");
  if (weekly.length > 0 && input.scheduledAllowed) {
    const timezone = input.timeZone?.trim() || "UTC";
    rules.push({
      tenantId: input.tenantId,
      name: nameOf("weeklyReport"),
      trigger: "schedule",
      cron: WEEKLY_CRON,
      timezone,
      periodDays: 7,
      sections: ["backups", "readiness", "failures", "storage", "restores"],
      emailRecipients: weekly,
      nextRunAt: nextRunAt({ cron: WEEKLY_CRON, timezone }, { now: input.now }),
      createdBy: input.createdBy,
    });
  }
  return rules;
}

/** Insert the wizard's rules inside the tenant-creation transaction. */
export async function insertWizardRules(
  tx: DbExecutor,
  rules: readonly NewReportRule[],
): Promise<number> {
  if (rules.length === 0) return 0;
  const inserted = await tx
    .insert(reportRules)
    .values([...rules])
    .returning({ id: reportRules.id });
  return inserted.length;
}
