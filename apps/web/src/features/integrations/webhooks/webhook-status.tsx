import { Loader2, LockOpen, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { DELIVERY_STATUS_VARIANT, eventKey, HEALTH_VARIANT, webhookHealth } from "../presenters";
import type { DeliveryStatus, Webhook } from "../types";

/** How the webhook is doing, judged by its last delivery. */
export function WebhookHealthBadge({ webhook }: { webhook: Pick<Webhook, "active" | "stats"> }) {
  const { t } = useTranslation("integrations");
  const health = webhookHealth(webhook);
  return (
    <Badge variant={HEALTH_VARIANT[health]}>
      {health === "retrying" ? (
        <Loader2 className="motion-safe:animate-spin" aria-hidden="true" />
      ) : null}
      {t(`webhooks.health.${health}`)}
    </Badge>
  );
}

function localTime(iso: string | null, language: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(language, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * "Failing since ..." in the list (0.5.0): the worker marks a webhook whose attempts keep failing
 * and raises one alert about it through the other channels. Nothing while it delivers.
 */
export function WebhookFailingBadge({ webhook }: { webhook: Pick<Webhook, "health"> }) {
  const { t, i18n } = useTranslation("integrations");
  const health = webhook.health;
  if (health?.status !== "failing") {
    return null;
  }
  return (
    <Badge variant="destructive" data-slot="webhook-failing">
      <TriangleAlert aria-hidden="true" />
      {t("webhooks.failingSince", {
        since: localTime(health.failingSince, i18n.resolvedLanguage ?? i18n.language),
      })}
    </Badge>
  );
}

/**
 * The health banner of a webhook's page (0.5.0): failing since when, how many attempts in a
 * row, the last error, and when the alert about it went out through the other channels.
 */
export function WebhookHealthBanner({ webhook }: { webhook: Pick<Webhook, "health"> }) {
  const { t, i18n } = useTranslation("integrations");
  const health = webhook.health;
  if (health?.status !== "failing") {
    return null;
  }
  const language = i18n.resolvedLanguage ?? i18n.language;
  return (
    <Alert variant="destructive" data-slot="webhook-health-banner">
      <TriangleAlert />
      <AlertTitle>{t("detail.health.title")}</AlertTitle>
      <AlertDescription className="space-y-1">
        <p>
          {t("detail.health.since", {
            since: localTime(health.failingSince, language),
            count: health.consecutiveFailures,
          })}
        </p>
        {health.lastError ? (
          <p>
            {t("detail.health.lastError")}{" "}
            <code className="break-all font-mono text-xs">{health.lastError}</code>
          </p>
        ) : null}
        <p>
          {health.alertedAt
            ? t("detail.health.alerted", { at: localTime(health.alertedAt, language) })
            : t("detail.health.notAlerted")}
        </p>
      </AlertDescription>
    </Alert>
  );
}

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const { t } = useTranslation("integrations");
  return (
    <Badge variant={DELIVERY_STATUS_VARIANT[status]}>
      {status === "pending" ? (
        <Loader2 className="motion-safe:animate-spin" aria-hidden="true" />
      ) : null}
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
