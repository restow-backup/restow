import type { PveGuest, PveNode, PveVerifyFact } from "./api.js";

/**
 * The state of a guest, in one place (VMs & containers, 0.4.3): what the table's State cell
 * shows as ONE badge, what the detail panel lists in full, what the state filter and the
 * "Problems only" filter match, and how the State column sorts.
 *
 * Every fact about a guest becomes a {@link GuestStatus}; `guestStatuses` returns them by
 * priority (the order of {@link GUEST_STATUS_ORDER}), the first one is the badge of the row.
 * What happens right now comes first (it changes in seconds and the admin just asked for it),
 * then what failed, then what only warns, then the quiet states.
 *
 * Adding a state is three steps: a key in {@link GUEST_STATUS_ORDER} at its priority, its tone
 * and filter group in {@link GUEST_STATUS_META}, and a label `guests.status.<key>` in en and de
 * (packages/i18n/resources/<lang>/pve.json).
 *
 * A restore check that a locked repository (or a stopped check) kept out is never green and
 * never red: while the worker tries again it is `verify_postponed` (amber, beside the earlier
 * result, which still stands); once it gave up (`lastVerify.state` "yellow") it is
 * `verify_not_checked` (amber, a problem). A restore check state the server sends that this
 * build does not know yet also shows as `verify_not_checked`, never as passed.
 *
 * Green is proof (green-is-proof.test.ts): only `verified`, a restore check that read the
 * newest restore point back, is green. A backup that merely succeeded is the neutral outline.
 */

/** Every state, highest priority first. The table shows the first one that applies. */
export const GUEST_STATUS_ORDER = [
  "cancelling",
  "running",
  "waiting_offline",
  "waiting",
  // Excluded on purpose: what the row says first, whatever its old runs said.
  "excluded",
  "failed",
  "verify_failed",
  "verify_not_checked",
  "verify_postponed",
  "incomplete",
  "warnings",
  "restow_server",
  "no_job",
  "never",
  "cancelled",
  "template",
  "absent",
  "verified",
  "succeeded",
  "unknown",
] as const;

export type GuestStatusKey = (typeof GUEST_STATUS_ORDER)[number];

/** Badge variants a state may use (components/ui/badge.tsx). */
export type GuestStatusTone = "success" | "outline" | "info" | "warning" | "destructive" | "muted";

/**
 * The groups of the state filter (`?state=` of the page). `problems` is not a group of its
 * own: it matches every state whose meta says `problem`.
 */
export const GUEST_STATE_FILTERS = [
  "problems",
  "failed",
  "warnings",
  "verify",
  "waiting",
  "running",
  "no_backup",
  "excluded",
  "ok",
] as const;
export type GuestStateFilter = (typeof GUEST_STATE_FILTERS)[number];

interface StatusMeta {
  tone: GuestStatusTone;
  /** Counts as a problem ("Problems only"). */
  problem: boolean;
  /** The group of the state filter it belongs to; null: only "all" shows it. */
  group: Exclude<GuestStateFilter, "problems"> | null;
}

export const GUEST_STATUS_META: Record<GuestStatusKey, StatusMeta> = {
  cancelling: { tone: "warning", problem: false, group: "running" },
  running: { tone: "info", problem: false, group: "running" },
  // Waiting for a node that is disconnected or whose queue is paused: nothing starts.
  waiting_offline: { tone: "warning", problem: true, group: "waiting" },
  waiting: { tone: "muted", problem: false, group: "waiting" },
  failed: { tone: "destructive", problem: true, group: "failed" },
  verify_failed: { tone: "destructive", problem: true, group: "verify" },
  // The restore check could not run for two hours (repository locked, check stopped): amber.
  verify_not_checked: { tone: "warning", problem: true, group: "verify" },
  // The newest check could not run yet and is tried again shortly: amber, not yet a problem.
  verify_postponed: { tone: "warning", problem: false, group: "verify" },
  incomplete: { tone: "warning", problem: true, group: "warnings" },
  warnings: { tone: "warning", problem: true, group: "warnings" },
  restow_server: { tone: "warning", problem: false, group: null },
  no_job: { tone: "warning", problem: true, group: "no_backup" },
  never: { tone: "warning", problem: true, group: "no_backup" },
  // Excluded from backup by an administrator on purpose: not a problem, a filter of its own.
  excluded: { tone: "muted", problem: false, group: "excluded" },
  cancelled: { tone: "muted", problem: false, group: null },
  template: { tone: "muted", problem: false, group: null },
  absent: { tone: "muted", problem: false, group: null },
  verified: { tone: "success", problem: false, group: "ok" },
  succeeded: { tone: "outline", problem: false, group: "ok" },
  unknown: { tone: "muted", problem: false, group: null },
};

export interface GuestStatus {
  key: GuestStatusKey;
  tone: GuestStatusTone;
  problem: boolean;
}

type StatusGuest = Pick<
  PveGuest,
  | "kind"
  | "template"
  | "present"
  | "jobId"
  | "lastRunStatus"
  | "lastSuccessAt"
  | "activity"
  | "cancelling"
  | "lastRunWarnings"
  | "backups"
  | "lastVerify"
  | "restowServer"
  | "selfBackupConfirmedAt"
  | "excludedAt"
  | "attention"
>;

type StatusNode = Pick<PveNode, "online" | "queuePausedAt"> | null | undefined;

/**
 * The state of a restore check as a guest state: red is a failed check, green the proof, no
 * state an unchecked point, yellow a check that could not run (the worker gave up after two
 * hours; servers from 0.4.3). Any other state a newer server may send is a check that did not
 * come to a result either: amber, never green.
 */
export function verifyStatusKey(
  verify: Pick<PveVerifyFact, "state"> | null | undefined,
): GuestStatusKey | null {
  const state = (verify?.state ?? null) as string | null;
  if (state === null) {
    return null;
  }
  if (state === "red") {
    return "verify_failed";
  }
  if (state === "green") {
    return "verified";
  }
  return "verify_not_checked";
}

/**
 * Every restore check state of a guest: the result ({@link verifyStatusKey}) and, while the
 * newest check could not run yet but is tried again (`notChecked` without `gaveUp`), the
 * amber `verify_postponed` beside the earlier result, which still stands.
 */
export function verifyStatusKeys(
  verify: Pick<PveVerifyFact, "state" | "notChecked"> | null | undefined,
): GuestStatusKey[] {
  const keys: GuestStatusKey[] = [];
  const result = verifyStatusKey(verify);
  if (result) {
    keys.push(result);
  }
  if (verify?.notChecked && !verify.notChecked.gaveUp && result !== "verify_not_checked") {
    keys.push("verify_postponed");
  }
  return keys;
}

/** Every state that applies to the guest, highest priority first (never empty). */
export function guestStatuses(guest: StatusGuest, node?: StatusNode): GuestStatus[] {
  const keys = new Set<GuestStatusKey>();
  if (guest.activity && guest.cancelling) {
    keys.add("cancelling");
  } else if (guest.activity === "running") {
    keys.add("running");
  } else if (guest.activity === "queued") {
    keys.add(node && (!node.online || node.queuePausedAt) ? "waiting_offline" : "waiting");
  }
  if (guest.kind === "vm" && guest.template) {
    keys.add("template");
  }
  if (!guest.present) {
    keys.add("absent");
  }
  if (guest.restowServer && !guest.selfBackupConfirmedAt) {
    keys.add("restow_server");
  }
  const excluded = Boolean(guest.excludedAt);
  if (excluded) {
    keys.add("excluded");
  }
  // Excluded guests are not "not backed up yet" or "in no job": that is what was asked for.
  const backable = guest.present && !(guest.kind === "vm" && guest.template) && !excluded;
  if (backable && (guest.attention ?? []).includes("no_job")) {
    keys.add("no_job");
  }
  if (guest.lastRunStatus === "failed") {
    keys.add("failed");
  } else if (guest.lastRunStatus === "cancelled" && !guest.activity) {
    keys.add("cancelled");
  }
  if ((guest.backups?.last?.unreadable ?? 0) > 0) {
    keys.add("incomplete");
  }
  if (guest.lastRunStatus === "succeeded" && (guest.lastRunWarnings ?? []).length > 0) {
    keys.add("warnings");
  }
  for (const key of verifyStatusKeys(guest.lastVerify)) {
    keys.add(key);
  }
  if (backable && !guest.lastSuccessAt && guest.jobId && guest.lastRunStatus !== "failed") {
    keys.add("never");
  }
  // A backup with warnings or gaps is not called plainly "backed up".
  if (guest.lastRunStatus === "succeeded" && !keys.has("warnings") && !keys.has("incomplete")) {
    keys.add("succeeded");
  }
  if (keys.size === 0) {
    keys.add(backable && !guest.lastSuccessAt ? "never" : "unknown");
  }
  return GUEST_STATUS_ORDER.filter((key) => keys.has(key)).map((key) => ({
    key,
    tone: GUEST_STATUS_META[key].tone,
    // What an excluded guest's old runs and checks said is no problem to act on any more.
    problem: GUEST_STATUS_META[key].problem && !excluded,
  }));
}

/** The badge of the table row: the state with the highest priority. */
export function primaryStatus(guest: StatusGuest, node?: StatusNode): GuestStatus {
  return guestStatuses(guest, node)[0] as GuestStatus;
}

/** Whether a guest matches a state filter. */
export function matchesStateFilter(statuses: readonly GuestStatus[], filter: GuestStateFilter) {
  if (filter === "problems") {
    return statuses.some((status) => status.problem);
  }
  if (filter === "ok") {
    return !statuses.some((status) => status.problem) && statuses[0]?.key !== "unknown"
      ? statuses.some((status) => GUEST_STATUS_META[status.key].group === "ok")
      : false;
  }
  return statuses.some((status) => GUEST_STATUS_META[status.key].group === filter);
}

/** Sort rank of a guest's state: its primary state's priority (lower is more urgent). */
export function statusRank(status: GuestStatus): number {
  return GUEST_STATUS_ORDER.indexOf(status.key);
}
