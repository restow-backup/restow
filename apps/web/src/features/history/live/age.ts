/**
 * How long ago the channel last heard from the server, in the three steps the indicator words.
 * The server speaks at least every fifteen seconds (changes, or a keep-alive), so on a healthy
 * connection this stays at "just now"; it only grows when something is wrong.
 */

export type AgeStep =
  | { unit: "now" }
  | { unit: "seconds"; count: number }
  | { unit: "minutes"; count: number };

/** Silence up to here still counts as "just now": a keep-alive is due every 15 s. */
export const JUST_NOW_MS = 20_000;

export function ageStep(ms: number): AgeStep {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (safe < JUST_NOW_MS) {
    return { unit: "now" };
  }
  if (safe < 60_000) {
    return { unit: "seconds", count: Math.floor(safe / 1000) };
  }
  return { unit: "minutes", count: Math.floor(safe / 60_000) };
}

/**
 * The countdown to a moment: `m:ss` under an hour ("17:42"), `h:mm:ss` from an hour on; null once
 * it is over. Whole seconds, rounded up, so "0:01" is the last thing shown before it happens.
 */
export function countdownText(targetMs: number, nowMs: number): string | null {
  const remaining = Math.ceil((targetMs - nowMs) / 1000);
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return null;
  }
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;
  const pair = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pair(minutes)}:${pair(seconds)}` : `${minutes}:${pair(seconds)}`;
}

/** A countdown is shown (instead of "in 3 hours") when the moment is this close. */
export const COUNTDOWN_WITHIN_MS = 60 * 60_000;
