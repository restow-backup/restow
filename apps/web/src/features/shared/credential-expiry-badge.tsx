import "@/features/settings/i18n";

import { CircleAlert, CircleCheck, Clock, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { StatusBadge, type StatusTone } from "@/components/kit";
import { type ExpiryState, expiryState, formatDay } from "./credential-expiry";

/**
 * The expiry badge of a Microsoft 365 app credential, shared by the central app (Settings →
 * Microsoft 365) and a source's own app (the source's connection card). Its words live in the
 * `settings` namespace (`microsoftApp.expiry.*`), registered by the import above so a source
 * page that never opened the settings still has them.
 */

function expiryText(
  state: ExpiryState,
  language: string,
): { key: string; values?: Record<string, string | number> } {
  switch (state.kind) {
    case "expired":
      return { key: "microsoftApp.expiry.expired" };
    case "soon":
      return state.days === 0
        ? { key: "microsoftApp.expiry.today" }
        : { key: "microsoftApp.expiry.soon", values: { days: state.days } };
    case "valid":
      return {
        key: "microsoftApp.expiry.valid",
        values: { date: formatDay(state.date, language) },
      };
    case "unknown":
      return { key: "microsoftApp.status.expiryUnknown" };
  }
}

/** Tone and icon per state; `soon` is amber, and red like `expired` once it is urgent. */
function badgeOf(state: Exclude<ExpiryState, { kind: "unknown" }>): {
  tone: StatusTone;
  icon: LucideIcon;
} {
  switch (state.kind) {
    case "valid":
      return { tone: "neutral", icon: CircleCheck };
    case "soon":
      return state.urgent ? { tone: "destructive", icon: Clock } : { tone: "warning", icon: Clock };
    case "expired":
      return { tone: "destructive", icon: CircleAlert };
  }
}

/**
 * Expiry of the credential: neutral while valid, amber within 30 days, red within 7 and once
 * expired (the reminder stages of packages/core entra/expiry.ts). Unknown reads as a muted
 * line; `unknownText` replaces its words where the page has a better hint.
 */
export function ExpiryBadge({
  expiresAt,
  now,
  unknownText,
}: {
  expiresAt: string | null | undefined;
  now?: number;
  unknownText?: string;
}) {
  const { t, i18n } = useTranslation("settings");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const state = expiryState(expiresAt, now);
  if (state.kind === "unknown") {
    return (
      <span className="text-sm text-muted-foreground">
        {unknownText ?? t("microsoftApp.status.expiryUnknown")}
      </span>
    );
  }
  const { key, values } = expiryText(state, language);
  const { tone, icon } = badgeOf(state);
  return (
    <StatusBadge tone={tone} icon={icon}>
      {t(key, values)}
    </StatusBadge>
  );
}
