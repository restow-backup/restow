import { ApiError, NetworkError } from "@/lib/api";

import type { MaintenanceView, PublicStatus, RunOutcome, UpdaterPhase } from "../api";
import { clockOffset, isMaintenanceActive, remainingSeconds } from "../presenters";

/**
 * The logic of the maintenance shell, free of React: how the two sources
 * (the api and the edge's public status) merge, how often to poll, when the
 * page announces or reloads and which terminal state a person still has to
 * see. The provider (use-maintenance.tsx) and the components only wire it up.
 */

/** Polling cadence: relaxed while nothing is going on, close while an update is announced or running. */
export const IDLE_POLL_MS = 30_000;
export const ACTIVE_POLL_MS = 2_000;

/** A reload after `succeeded` waits this long, so "Updated to X" is seen. */
export const SUCCESS_RELOAD_DELAY_MS = 2_500;

/** Never reload twice within this window, whatever the tokens say. */
export const RELOAD_COOLDOWN_MS = 60_000;

/** A failed run older than this is not announced to a page that never saw it happen. */
export const STALE_FAILURE_MS = 24 * 60 * 60 * 1000;

export interface MaintenanceSnapshot {
  /** What the page knows: the api's answer, or the merge with the edge status while the api is away. */
  view: MaintenanceView;
  /** The api answered the last poll. */
  apiReachable: boolean;
  /** Server clock minus client clock in milliseconds (add it to `Date.now()`). */
  offsetMs: number;
  /** The last few measurements `offsetMs` was chosen from (see {@link smoothOffset}). */
  offsetSamples: number[];
  /** Client time at which the snapshot was taken. */
  receivedAt: number;
}

const OFFSET_SAMPLES = 8;

/**
 * The clock skew from the last few answers. An answer's timestamp is taken
 * before it travels, so a measurement is the true skew minus that travel time;
 * the largest of a few measurements (the fastest answer) is the best estimate,
 * and it keeps the countdown from flickering with every poll's latency.
 */
export function smoothOffset(
  previous: readonly number[] | undefined,
  measured: number,
): { offsetMs: number; samples: number[] } {
  const samples = [...(previous ?? []), measured].slice(-OFFSET_SAMPLES);
  return { offsetMs: Math.max(...samples), samples };
}

// --- Polling --------------------------------------------------------------------------------------

/**
 * A failure that says "the server is restarting", not "something is wrong":
 * the connection failed, or a gateway in front of the stopped api answered.
 */
export function isMaintenanceGap(error: unknown): boolean {
  return (
    error instanceof NetworkError ||
    (error instanceof ApiError &&
      (error.status === 502 || error.status === 503 || error.status === 504))
  );
}

export interface PollDeps {
  fetchApi: () => Promise<MaintenanceView>;
  fetchEdge: () => Promise<PublicStatus | null>;
  now: () => number;
}

/** A message of the edge, with the `version` parameter it leaves out filled in from what is known. */
function withKnownVersion(
  message: PublicStatus["message"],
  targetVersion: string | null,
  fromVersion: string | null,
): PublicStatus["message"] {
  if (!message || "version" in message.params) {
    return message;
  }
  const version = message.code === "rollback.restarting" ? fromVersion : targetVersion;
  return version ? { ...message, params: { ...message.params, version } } : message;
}

function fromEdge(
  edge: PublicStatus,
  previous: MaintenanceSnapshot,
  receivedAt: number,
): MaintenanceSnapshot {
  const { offsetMs, samples } = smoothOffset(
    previous.offsetSamples,
    clockOffset(edge.serverTime, receivedAt),
  );
  // The edge names no versions (they are for signed-in users): the ones the api told
  // this page about the same run stay, also in the messages that mention them.
  const sameRun = edge.runId !== null && edge.runId === previous.view.runId;
  const targetVersion = edge.targetVersion ?? (sameRun ? previous.view.targetVersion : null);
  const fromVersion = edge.fromVersion ?? (sameRun ? previous.view.fromVersion : null);
  return {
    view: {
      ...edge,
      targetVersion,
      fromVersion,
      message: withKnownVersion(edge.message, targetVersion, fromVersion),
      runningVersion: null,
    },
    apiReachable: false,
    offsetMs,
    offsetSamples: samples,
    receivedAt,
  };
}

/**
 * One poll. The api first. When it fails as a restart does (connection error,
 * 502/503/504) while a maintenance is announced or running, or while the api
 * has been away since, this is "maintenance in progress", not an error: the
 * edge's public status is asked as well and merged in. Its idle answer counts
 * for nothing (the edge also answers idle when no updater runs); only a real
 * phase replaces what the page knew. Any other failure, and any failure while
 * idle, is thrown for the query to swallow silently.
 */
export async function pollMaintenance(
  deps: PollDeps,
  previous: MaintenanceSnapshot | null,
): Promise<MaintenanceSnapshot> {
  try {
    const view = await deps.fetchApi();
    const receivedAt = deps.now();
    const { offsetMs, samples } = smoothOffset(
      previous?.offsetSamples,
      clockOffset(view.serverTime, receivedAt),
    );
    return { view, apiReachable: true, offsetMs, offsetSamples: samples, receivedAt };
  } catch (error) {
    const inGap =
      previous !== null && (isMaintenanceActive(previous.view.phase) || !previous.apiReachable);
    if (!inGap || !isMaintenanceGap(error) || previous === null) {
      throw error;
    }
    const edge = await deps.fetchEdge();
    const receivedAt = deps.now();
    if (edge && edge.phase !== "idle") {
      return fromEdge(edge, previous, receivedAt);
    }
    return { ...previous, apiReachable: false, receivedAt };
  }
}

/** How long to wait before the next poll. */
export function pollIntervalMs(snapshot: MaintenanceSnapshot | undefined): number {
  if (!snapshot) {
    return IDLE_POLL_MS;
  }
  return isMaintenanceActive(snapshot.view.phase) || !snapshot.apiReachable
    ? ACTIVE_POLL_MS
    : IDLE_POLL_MS;
}

// --- Phase --------------------------------------------------------------------------------------------

/**
 * The phase to act on. A countdown that ran out while the api is away means
 * the update has started (it stops the api first), even when no edge status
 * arrived to say so.
 */
export function effectivePhase(snapshot: MaintenanceSnapshot, nowMs: number): UpdaterPhase {
  const { view } = snapshot;
  if (view.phase === "scheduled" && !snapshot.apiReachable) {
    const left = remainingSeconds(view.startsAt, nowMs, snapshot.offsetMs);
    if (left !== null && left <= 0) {
      return "running";
    }
  }
  return view.phase;
}

// --- Announcing ----------------------------------------------------------------------------------------

/** Whether a phase change is the announcement of a maintenance (idle or finished, then scheduled). */
export function isAnnouncement(previous: UpdaterPhase | null, next: UpdaterPhase): boolean {
  return (
    next === "scheduled" && previous !== null && previous !== "scheduled" && previous !== "running"
  );
}

// --- Reloading ---------------------------------------------------------------------------------------------

export interface ReloadInput {
  snapshot: MaintenanceSnapshot;
  /** The version the api reported when this page first heard from it. */
  baselineVersion: string | null;
  /** This page saw the current run announced or running. */
  sawActiveRun: boolean;
}

export type ReloadDecision =
  | { action: "none" }
  | { action: "reload"; delayMs: number; token: string };

/**
 * Whether to reload so the browser picks up the new web assets: the api
 * answers with another version than the one this page loaded with (at once),
 * or the run this page watched succeeded and the api answers (after a short
 * moment). Never while the api is unreachable.
 */
export function decideReload(input: ReloadInput): ReloadDecision {
  const { snapshot, baselineVersion, sawActiveRun } = input;
  if (!snapshot.apiReachable) {
    return { action: "none" };
  }
  const { runningVersion, phase, runId } = snapshot.view;
  if (runningVersion && baselineVersion && runningVersion !== baselineVersion) {
    return { action: "reload", delayMs: 0, token: `version:${runningVersion}` };
  }
  if (phase === "succeeded" && sawActiveRun && runId) {
    return { action: "reload", delayMs: SUCCESS_RELOAD_DELAY_MS, token: `run:${runId}` };
  }
  return { action: "none" };
}

/** What the reload guard remembers across the reload itself (sessionStorage). */
export interface ReloadRecord {
  tokens: string[];
  at: number;
}

const tokenKind = (token: string) => token.split(":", 1)[0];

/**
 * True when this token was reloaded for already, or a reload for the same kind
 * of reason just happened (two version changes, or two runs, within the
 * cooldown look like flapping). A reload for a finished run right after the
 * reload for the version change is how an update ends by design: the api
 * answers first and the web edge is replaced last, so the page loaded at the
 * version change may still hold the old assets.
 */
export function reloadIsBlocked(
  record: ReloadRecord | null,
  token: string,
  nowMs: number,
): boolean {
  if (!record) {
    return false;
  }
  if (record.tokens.includes(token)) {
    return true;
  }
  const last = record.tokens.at(-1);
  return (
    last !== undefined &&
    tokenKind(last) === tokenKind(token) &&
    nowMs - record.at < RELOAD_COOLDOWN_MS
  );
}

export function nextReloadRecord(
  record: ReloadRecord | null,
  token: string,
  nowMs: number,
): ReloadRecord {
  return { tokens: [...(record?.tokens ?? []), token].slice(-8), at: nowMs };
}

const RELOAD_STORAGE_KEY = "restow.maintenance.reload";

function parseReloadRecord(raw: string | null): ReloadRecord | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ReloadRecord>;
    if (Array.isArray(parsed.tokens) && typeof parsed.at === "number") {
      return {
        tokens: parsed.tokens.filter((token): token is string => typeof token === "string"),
        at: parsed.at,
      };
    }
  } catch {
    // A damaged record counts as none.
  }
  return null;
}

/** The reload guard's storage; `null` when the browser gives no session storage. */
export function readReloadRecord(): { record: ReloadRecord | null } | null {
  try {
    return { record: parseReloadRecord(window.sessionStorage.getItem(RELOAD_STORAGE_KEY)) };
  } catch {
    return null;
  }
}

/** Remember the reload; false when it could not be remembered (then it must not happen). */
export function writeReloadRecord(record: ReloadRecord): boolean {
  try {
    window.sessionStorage.setItem(RELOAD_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

// --- Terminal states --------------------------------------------------------------------------------------

const DISMISSED_STORAGE_KEY = "restow.maintenance.dismissed";

/** The run whose result this browser already dismissed. */
export function readDismissedRun(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function rememberDismissedRun(runId: string): void {
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, runId);
  } catch {
    // Without storage the dismissal lasts for this page load only.
  }
}

export type ModalState =
  | { kind: "none" }
  | { kind: "running"; unreachable: boolean }
  | { kind: "succeeded" }
  | { kind: "failed"; outcome: RunOutcome | null };

export interface ModalInput {
  snapshot: MaintenanceSnapshot | null;
  nowMs: number;
  /** This page saw the current run announced or running. */
  sawActiveRun: boolean;
  dismissedRunId: string | null;
  isProviderAdmin: boolean;
  /** The person is on Settings, Updates, where the details are. */
  onUpdatesTab: boolean;
}

/** Whether the full-screen modal shows, and what it says. */
export function modalStateOf(input: ModalInput): ModalState {
  const { snapshot, nowMs, sawActiveRun, dismissedRunId, isProviderAdmin, onUpdatesTab } = input;
  if (!snapshot) {
    return { kind: "none" };
  }
  const phase = effectivePhase(snapshot, nowMs);
  const { view } = snapshot;
  const dismissed = view.runId !== null && view.runId === dismissedRunId;

  switch (phase) {
    case "running":
      return { kind: "running", unreachable: !snapshot.apiReachable };
    case "succeeded":
      return sawActiveRun && !dismissed ? { kind: "succeeded" } : { kind: "none" };
    case "failed": {
      const attention = view.outcome === "needs_attention";
      if (attention && isProviderAdmin) {
        // Not dismissable; the tab itself carries the recovery steps.
        return onUpdatesTab ? { kind: "none" } : { kind: "failed", outcome: view.outcome };
      }
      if (dismissed) {
        return { kind: "none" };
      }
      if (!sawActiveRun && !attention && isStale(view, nowMs)) {
        return { kind: "none" };
      }
      return { kind: "failed", outcome: view.outcome };
    }
    default:
      return { kind: "none" };
  }
}

function isStale(view: MaintenanceView, nowMs: number): boolean {
  if (!view.finishedAt) {
    return false;
  }
  const finished = Date.parse(view.finishedAt);
  return Number.isFinite(finished) && nowMs - finished > STALE_FAILURE_MS;
}

/** The banner above the top bar: what it shows for this phase, or nothing. */
export type BannerState =
  | { kind: "none" }
  | { kind: "scheduled" }
  | { kind: "running" }
  | { kind: "attention" };

export function bannerStateOf(input: {
  snapshot: MaintenanceSnapshot | null;
  nowMs: number;
  isProviderAdmin: boolean;
}): BannerState {
  const { snapshot, nowMs, isProviderAdmin } = input;
  if (!snapshot) {
    return { kind: "none" };
  }
  const phase = effectivePhase(snapshot, nowMs);
  if (phase === "scheduled") {
    return { kind: "scheduled" };
  }
  if (phase === "running") {
    return { kind: "running" };
  }
  if (phase === "failed" && snapshot.view.outcome === "needs_attention" && isProviderAdmin) {
    return { kind: "attention" };
  }
  return { kind: "none" };
}
