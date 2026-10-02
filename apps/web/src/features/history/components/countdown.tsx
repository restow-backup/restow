import { useTranslation } from "react-i18next";

import { RelativeTime } from "@/components/kit";
import { formatDateTime } from "@/lib/format";

import { COUNTDOWN_WITHIN_MS, countdownText } from "../live/age";
import { useSecondClock } from "../live/clock";

/**
 * A moment that is coming: "in 17:42" counting down once a second when it is less than an
 * hour away, the usual relative time ("in 3 hours") beyond that. It counts on the browser's
 * own clock; nothing asks the server, and the exact time is in the tooltip. Once the moment is
 * reached the countdown ends and the time reads as relative again ("2 minutes ago") until the
 * server sends the next one.
 */
export function Countdown({ at }: { at: string }) {
  const { t, i18n } = useTranslation("history");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const target = Date.parse(at);
  const close = Number.isFinite(target) && target - Date.now() <= COUNTDOWN_WITHIN_MS;
  const now = useSecondClock(close);
  const text = close ? countdownText(target, now) : null;
  if (text === null) {
    return <RelativeTime value={at} focusable={false} />;
  }
  return (
    <time
      dateTime={at}
      title={formatDateTime(at, language) ?? undefined}
      className="font-mono tabular-nums"
    >
      {t("live.countdown", { time: text })}
    </time>
  );
}
