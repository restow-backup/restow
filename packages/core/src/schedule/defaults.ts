// The recommended schedules, in one place so the maintainer can change them.
//
// Every tenant gets this set once, as soon as it has an active source (the
// scheduler applies it; administrators can apply missing entries again from
// the schedules page). Intervals start at once and then repeat; cron entries
// run at their wall-clock time in the tenant's zone.

/** The zone recommended schedules use when the request names none. */
export const DEFAULT_SCHEDULE_TIMEZONE = "Europe/Berlin";

/**
 * One recommended schedule. `slot` tells entries of the same kind apart (the
 * weekly sampled scrub and the monthly full scrub are both `scrub`).
 */
export interface RecommendedScheduleDefault {
  readonly slot: RecommendedSlot;
  readonly kind: "backup" | "directory" | "verify" | "scrub" | "retention";
  readonly intervalMinutes: number | null;
  readonly cron: string | null;
  /** Only recommended when the tenant has a Microsoft 365 source (directory sync). */
  readonly requiresMicrosoftSource: boolean;
}

export type RecommendedSlot =
  | "backup"
  | "directory"
  | "verify"
  | "scrub_sample"
  | "scrub_full"
  | "retention";

export const RECOMMENDED_SCHEDULE_DEFAULTS: readonly RecommendedScheduleDefault[] = [
  // Back up every protected object every 8 hours.
  {
    slot: "backup",
    kind: "backup",
    intervalMinutes: 8 * 60,
    cron: null,
    requiresMicrosoftSource: false,
  },
  // Read users, mailboxes and OneDrives from Entra ID every 6 hours.
  {
    slot: "directory",
    kind: "directory",
    intervalMinutes: 6 * 60,
    cron: null,
    requiresMicrosoftSource: true,
  },
  // Weekly restore proof, Sunday 03:00. An enabled verify schedule also has
  // every backup followed by a sampled verification of the new snapshot.
  {
    slot: "verify",
    kind: "verify",
    intervalMinutes: null,
    cron: "0 3 * * 0",
    requiresMicrosoftSource: false,
  },
  // Sampled pack integrity check, Saturday 04:00.
  {
    slot: "scrub_sample",
    kind: "scrub",
    intervalMinutes: null,
    cron: "0 4 * * 6",
    requiresMicrosoftSource: false,
  },
  // Full pack integrity check on the 1st of every month, 05:00 (a day-of-month
  // expression makes the scrub a full one).
  {
    slot: "scrub_full",
    kind: "scrub",
    intervalMinutes: null,
    cron: "0 5 1 * *",
    requiresMicrosoftSource: false,
  },
  // Apply the retention policies daily at 04:30.
  {
    slot: "retention",
    kind: "retention",
    intervalMinutes: null,
    cron: "30 4 * * *",
    requiresMicrosoftSource: false,
  },
];
