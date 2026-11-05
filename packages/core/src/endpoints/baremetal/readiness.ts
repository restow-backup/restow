/**
 * The bare metal rating of a machine (docs/BAREMETAL.md 12.4), shown next to the Recovery
 * Readiness of its files and never mixed into it. Up to M2 the best a machine reaches is
 * `layout_checked`: stage 1 found the newest whole machine snapshot restorable by its layout and
 * boot chain. `green` and `overdue` need a passed boot probe (M5); the type knows them already,
 * this function does not produce them yet.
 */

export const BAREMETAL_STATES = [
  "not_enabled",
  "not_possible",
  "no_layout",
  "unverified",
  "layout_checked",
  "green",
  "red",
  "overdue",
] as const;
export type BaremetalReadinessState = (typeof BAREMETAL_STATES)[number];

/** Why bare metal is not possible for a machine. */
export const BAREMETAL_NOT_POSSIBLE = [
  "container",
  "windows",
  "darwin_later",
  "arm64_later",
  "agent_too_old",
  "unsupported",
] as const;
export type BaremetalNotPossibleReason = (typeof BAREMETAL_NOT_POSSIBLE)[number];

/** What the rating adds to a state: a yellow stage 1 report says it could not finish. */
export type BaremetalStateDetail = "incomplete" | null;

export interface BaremetalReadinessInput {
  /** The machine's job backs it up as a whole. */
  enabled: boolean;
  os: string;
  arch: string | null;
  virtualization: string | null;
  /** The agent is older than the whole machine backup (only matters when enabled). */
  agentTooOld: boolean;
  /** The machine's newest layout, or null when no snapshot recorded one. */
  latestLayout: { verdict: string } | null;
  /** The newest stage 1 report of the newest layout's snapshot, or null when none ran. */
  latestReport: { readiness: "green" | "yellow" | "red" | null } | null;
}

export interface BaremetalReadiness {
  state: BaremetalReadinessState;
  notPossible: BaremetalNotPossibleReason | null;
  detail: BaremetalStateDetail;
}

function notPossibleOf(input: BaremetalReadinessInput): BaremetalNotPossibleReason | null {
  if (input.os === "windows") return "windows";
  if (input.os === "darwin") return "darwin_later";
  if (input.virtualization === "container") return "container";
  if (input.arch === "arm64") return "arm64_later";
  if (input.enabled && input.agentTooOld) return "agent_too_old";
  if (input.latestLayout?.verdict === "unsupported") return "unsupported";
  return null;
}

/**
 * The rating (table 12.4). `not_possible` wins over everything, also over a red report: the
 * report of an unsupported layout is red for the record (L2), but there is nothing to fix in the
 * backup, the machine's storage stack is what Restow cannot restore.
 */
export function baremetalReadiness(input: BaremetalReadinessInput): BaremetalReadiness {
  const notPossible = notPossibleOf(input);
  if (notPossible) {
    return { state: "not_possible", notPossible, detail: null };
  }
  if (!input.latestLayout) {
    return { state: input.enabled ? "no_layout" : "not_enabled", notPossible: null, detail: null };
  }
  switch (input.latestReport?.readiness) {
    case "green":
      return { state: "layout_checked", notPossible: null, detail: null };
    case "red":
      return { state: "red", notPossible: null, detail: null };
    case "yellow":
      return { state: "unverified", notPossible: null, detail: "incomplete" };
    default:
      return { state: "unverified", notPossible: null, detail: null };
  }
}
