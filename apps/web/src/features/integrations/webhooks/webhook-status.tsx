import { Loader2, LockOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { DELIVERY_STATUS_VARIANT, HEALTH_VARIANT, eventKey, webhookHealth } from "../presenters";
import type { DeliveryStatus, Webhook } from "../types";

/** How the webhook is doing, judged by its last delivery. */
export function WebhookHealthBadge({ webhook }: { webhook: Pick<Webhook, "active" | "stats"> }) {
  const { t } = useTranslation("integrations");
  const health = webhookHealth(webhook);
  return (
    <Badge variant={HEALTH_VARIANT[health]}>
      {health === "retrying" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
      {t(`webhooks.health.${health}`)}
    </Badge>
  );
}

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const { t } = useTranslation("integrations");
  return (
    <Badge variant={DELIVERY_STATUS_VARIANT[status]}>
      {status === "pending" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
      {t(`deliveries.status.${status}`)}
    </Badge>
  );
}

/** Marks plain-http targets, with the reason on hover or focus. */
export function InsecureBadge() {
  const { t } = useTranslation("integrations");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md bg-warning/20 px-2 py-0.5 text-xs font-medium text-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-warning"
        >
          <LockOpen className="size-3" aria-hidden="true" />
          {t("webhooks.insecure")}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{t("webhooks.insecureHint")}</TooltipContent>
    </Tooltip>
  );
}

/** An event's name in the operator's language. */
export function EventLabel({ event }: { event: string }) {
  const { t } = useTranslation("integrations");
  return <>{t(`events.${eventKey(event)}.label`)}</>;
}

/** Queued and recent outcomes in one quiet line; nothing when all is zero. */
export function WebhookStatsLine({ webhook }: { webhook: Pick<Webhook, "stats"> }) {
  const { t } = useTranslation("integrations");
  const { pending, failedLast24h, deliveredLast24h } = webhook.stats;
  const parts = [
    pending > 0 ? t("webhooks.stats.pending", { count: pending }) : null,
    failedLast24h > 0 ? t("webhooks.stats.failed", { count: failedLast24h }) : null,
    deliveredLast24h > 0 ? t("webhooks.stats.delivered", { count: deliveredLast24h }) : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) {
    return null;
  }
  return <span className="text-xs text-muted-foreground">{parts.join(" · ")}</span>;
}
