import * as React from "react";

/**
 * The windows the start page's charts offer and the viewer's remembered
 * choice of each.
 *
 * The storage growth chart covers a week, a month, three months or a year of
 * history and estimates as far ahead (the API clamps both to the history that
 * exists, apps/api/src/features/dashboard/growth.ts). The capacity planning
 * page is meant to offer the same choice with the same control
 * (components/storage-range-toggle.tsx).
 *
 * A choice is remembered per browser and per signed-in person in
 * localStorage. Storage can be missing or throw (private mode, blocked site
 * data), so every access is guarded: a failure means "nothing remembered",
 * never a crash.
 */

export const STORAGE_RANGES = ["7d", "30d", "90d", "365d"] as const;
export type StorageRange = (typeof STORAGE_RANGES)[number];

/** The window the API answers when the request names none. */
export const DEFAULT_STORAGE_RANGE: StorageRange = "30d";

const STORAGE_RANGE_DAYS: Readonly<Record<StorageRange, number>> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "365d": 365,
};

export function storageRangeDays(range: StorageRange): number {
  return STORAGE_RANGE_DAYS[range];
}

/**
 * The query parameters of a range: the history and the horizon of the
 * estimate (the same length unless one is given). The default range sends
 * none, so the plain request stays canonical.
 */
export function storageRangeParams(
  range: StorageRange,
  horizon: StorageRange = range,
): Record<string, string> {
  if (range === DEFAULT_STORAGE_RANGE && horizon === range) {
    return {};
  }
  return {
    storageDays: String(storageRangeDays(range)),
    ...(horizon === range ? {} : { forecastDays: String(storageRangeDays(horizon)) }),
  };
}

/** The part of the Storage API used here (injectable for tests). */
export type ChoiceStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): ChoiceStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The localStorage key of one remembered choice of one person. */
export function choiceKey(name: string, userId: string | null): string {
  return `restow.dashboard.${name}.${userId ?? "anon"}`;
}

/** The remembered choice, or `fallback` when none is stored or it is not offered (any more). */
export function readChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
  storage: ChoiceStorage | null = defaultStorage(),
): T {
  try {
    const raw = storage?.getItem(key);
    return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Remember a choice; silently does nothing when storage fails. */
export function writeChoice(
  key: string,
  value: string,
  storage: ChoiceStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // The choice still applies until the page is reloaded.
  }
}

/**
 * A choice among `allowed`, remembered under `name` for the signed-in person
 * (`userId`). Another person in the same browser gets their own.
 */
export function useRememberedChoice<T extends string>(
  name: string,
  userId: string | null,
  allowed: readonly T[],
  fallback: T,
): readonly [T, (next: T) => void] {
  const key = choiceKey(name, userId);
  const [state, setState] = React.useState(() => ({
    key,
    value: readChoice(key, allowed, fallback),
  }));
  let current = state;
  if (state.key !== key) {
    // Another person signed in: read their choice while rendering, so the old one never shows.
    current = { key, value: readChoice(key, allowed, fallback) };
    setState(current);
  }
  const choose = React.useCallback(
    (next: T) => {
      setState({ key, value: next });
      writeChoice(key, next);
    },
    [key],
  );
  return [current.value, choose] as const;
}
