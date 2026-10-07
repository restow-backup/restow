import { useTranslation } from "react-i18next";

import type { ReportRule } from "@/features/reports/api";
import { useReportRules } from "@/features/reports/hooks";

/** The tenant's alert and report rules that send to this webhook. */
export function rulesUsingWebhook(rules: readonly ReportRule[], webhookId: string): ReportRule[] {
  return rules.filter((rule) => rule.webhookId === webhookId);
}

/**
 * Which rules send to a webhook, for the delete question: a rule whose only channel is this
 * webhook keeps running after it is gone but reaches nobody, so the question names them.
 */
export function WebhookRulesNotice({ webhookId }: { webhookId: string }) {
  const { t } = useTranslation("integrations");
  const rules = useReportRules();
  const using = rulesUsingWebhook(rules.data ?? [], webhookId);
  if (using.length === 0) {
    return null;
  }
  const alone = using.filter((rule) => rule.emailRecipients.length === 0 && !rule.inApp);
  return (
    <div className="space-y-1.5 text-sm" data-slot="webhook-rules">
      <p>{t("webhooks.deleteConfirm.rules", { count: using.length })}</p>
      <ul className="list-disc space-y-0.5 pl-5">
        {using.map((rule) => (
          <li key={rule.id}>{rule.name}</li>
        ))}
      </ul>
      {alone.length > 0 ? (
        <p className="text-warning-foreground">
          {t("webhooks.deleteConfirm.rulesAlone", { count: alone.length })}
        </p>
      ) : null}
    </div>
  );
}

/** How many rules send to a webhook besides its own events (the form says so). */
export function useRuleCount(webhookId: string | undefined): number {
  const rules = useReportRules();
  return webhookId ? rulesUsingWebhook(rules.data ?? [], webhookId).length : 0;
}
