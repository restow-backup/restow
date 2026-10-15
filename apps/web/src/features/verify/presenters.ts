import type { StatusTone } from "@/components/kit";
import type { Failure } from "@/features/failures/api";
import type {
  EndpointReadinessRow,
  GcResult,
  GuestReadinessRow,
  ObjectReadiness,
  ObjectState,
  Reason,
  RunVerifyResult,
  ShareReadinessRow,
  SnapshotVerification,
  StorageState,
  VerificationState,
  VerifyObject,
} from "@/features/verify/api";
import { ApiError, errorMessageKey } from "@/lib/api";

/**
 * Pure presentation rules for the readiness pages: ordering, badge colours
 * and the translation key (plus values) for every stored code. Components
 * only call `t(key, values)`.
 */

export interface Message {
  key: string;
  values?: Record<string, unknown>;
}

/** A backup without a verified restore counts as failed, so it looks like one. */
export const STATE_BADGE: Record<ObjectState, StatusTone> = {
  green: "success",
  yellow: "warning",
  red: "destructive",
  unverified: "destructive",
  no_backup: "destructive",
};

/**
 * The tone of one backup's verification in the snapshot lists. Only a check
 * that passed is a success; a backup no check has read back yet is a warning
 * (it is not known to be broken, but it is not proven either).
 */
export const SNAPSHOT_VERIFICATION_TONE: Record<VerificationState, StatusTone> = {
  green: "success",
  yellow: "warning",
  red: "destructive",
  unverified: "warning",
};

export interface SnapshotVerificationView {
  tone: StatusTone;
  /** The badge label. */
  label: Message;
  /** The tooltip: when the backup was checked, or why it counts as not proven. */
  hint: Message;
}

/**
 * How a snapshot list shows one backup's verification. `formatDate` turns
 * the check time into the absolute, localized date for the tooltip.
 */
export function snapshotVerificationView(
  verification: SnapshotVerification,
  formatDate: (iso: string) => string,
): SnapshotVerificationView {
  const tone = SNAPSHOT_VERIFICATION_TONE[verification.state] ?? "warning";
  const label = { key: `snapshot.state.${verification.state}` };
  if (verification.state === "unverified" || !verification.checkedAt) {
    return { tone, label, hint: { key: "snapshot.hint.unverified" } };
  }
  return {
    tone,
    label,
    hint: { key: "snapshot.hint.checked", values: { date: formatDate(verification.checkedAt) } },
  };
}

export const STORAGE_BADGE: Record<StorageState, StatusTone> = {
  ok: "success",
  repaired: "warning",
  corrupt: "destructive",
  never: "muted",
};

const URGENCY: Record<ObjectState, number> = {
  red: 0,
  unverified: 1,
  no_backup: 2,
  yellow: 3,
  green: 4,
};

/**
 * The object's name for messages and sorting: its display name, else its
 * address, else (only for `imap`, where it is the login, or as a last
 * resort) the raw external id. The "Object" column never shows that last
 * resort as the primary label — see `objects-table.tsx`.
 */
export function objectName(
  object: Pick<VerifyObject, "displayName" | "email" | "externalId">,
): string {
  return object.displayName?.trim() || object.email?.trim() || object.externalId;
}

/**
 * The address next to the name, when it says something the name does not:
 * the IMAP login, or the linked user's email/UPN for a mailbox or OneDrive.
 * Never the opaque Entra object id or drive id that `externalId` holds for
 * those two kinds.
 */
export function objectAddress(
  object: Pick<VerifyObject, "kind" | "displayName" | "externalId" | "email" | "upn">,
): string | null {
  const candidate =
    object.kind === "imap" ? object.externalId : (object.email ?? object.upn ?? null);
  return candidate && candidate !== objectName(object) ? candidate : null;
}

/**
 * A fresh "no_backup" object is not a problem yet: it only needs attention
 * once the API's `overdue` says the first-backup grace period passed (the
 * single place that rule lives, see apps/api/.../verify/summary.ts). Every
 * other state needs attention as soon as it is not green, or its check is stale.
 */
export function needsAttention(item: Pick<ObjectReadiness, "state" | "overdue">): boolean {
  if (item.state === "no_backup") {
    return item.overdue;
  }
  return item.state !== "green" || item.overdue;
}

/** A "no_backup" object still inside its first-backup grace period: not a fault, just new. */
export function isWaitingForFirstBackup(item: Pick<ObjectReadiness, "state" | "overdue">): boolean {
  return item.state === "no_backup" && !item.overdue;
}

/** Tone and label key of the readiness badge; the one place that combines state and overdue. */
export function stateBadgeView(item: Pick<ObjectReadiness, "state" | "overdue">): {
  tone: StatusTone;
  key: string;
} {
  if (item.state === "no_backup") {
    return isWaitingForFirstBackup(item)
      ? { tone: "warning", key: "state.waitingForFirstBackup" }
      : { tone: "destructive", key: "state.no_backup" };
  }
  return { tone: STATE_BADGE[item.state], key: `state.${item.state}` };
}

/** Worst first; overdue before current within a state; then by name. */
export function sortByUrgency(items: readonly ObjectReadiness[]): ObjectReadiness[] {
  return [...items].sort(
    (a, b) =>
      URGENCY[a.state] - URGENCY[b.state] ||
      Number(b.overdue) - Number(a.overdue) ||
      objectName(a.object).localeCompare(objectName(b.object)),
  );
}

/**
 * One line of the readiness table: a mailbox, OneDrive or IMAP account, or a
 * server or client backed up by the agent. The tenant summary (and with it
 * the banner above the table) counts both kinds, so the table lists both: the
 * numbers on the page always describe the rows below them.
 */
export type ReadinessRow =
  | { type: "object"; id: string; item: ObjectReadiness }
  | { type: "endpoint"; id: string; endpoint: EndpointReadinessRow }
  | { type: "guest"; id: string; guest: GuestReadinessRow }
  | { type: "share"; id: string; share: ShareReadinessRow };

/**
 * The rows of the table: the mail objects, the machines, the VMs and containers of Proxmox VE,
 * then the file shares (the order is settled by `sortRowsByUrgency`).
 */
export function readinessRows(
  objects: readonly ObjectReadiness[],
  endpoints: readonly EndpointReadinessRow[] = [],
  guests: readonly GuestReadinessRow[] = [],
  shares: readonly ShareReadinessRow[] = [],
): ReadinessRow[] {
  return [
    ...objects.map((item): ReadinessRow => ({ type: "object", id: item.object.id, item })),
    ...endpoints.map((endpoint): ReadinessRow => ({ type: "endpoint", id: endpoint.id, endpoint })),
    ...guests.map((guest): ReadinessRow => ({ type: "guest", id: guest.id, guest })),
    ...shares.map((share): ReadinessRow => ({ type: "share", id: share.id, share })),
  ];
}

/** The rating of a row: what the filters and the order look at, whatever the kind of object. */
export function rowRating(row: ReadinessRow): Pick<ObjectReadiness, "state" | "overdue"> {
  switch (row.type) {
    case "object":
      return row.item;
    case "endpoint":
      return row.endpoint;
    case "guest":
      return row.guest;
    case "share":
      return row.share;
  }
}

/** The name a guest goes by: its PVE name, else "VM 101" or "CT 101". */
export function guestRowName(guest: Pick<GuestReadinessRow, "name" | "kind" | "vmid">): string {
  return guest.name?.trim() || `${guest.kind === "vm" ? "VM" : "CT"} ${guest.vmid}`;
}

/** The name a row is ordered by. */
export function rowName(row: ReadinessRow): string {
  switch (row.type) {
    case "object":
      return objectName(row.item.object);
    case "endpoint":
      return row.endpoint.displayName?.trim() || row.endpoint.hostname;
    case "guest":
      return guestRowName(row.guest);
    case "share":
      return row.share.name;
  }
}

/** Worst first across mailboxes and machines alike; overdue before current; then by name. */
export function sortRowsByUrgency(rows: readonly ReadinessRow[]): ReadinessRow[] {
  return [...rows].sort((a, b) => {
    const left = rowRating(a);
    const right = rowRating(b);
    return (
      URGENCY[left.state] - URGENCY[right.state] ||
      Number(right.overdue) - Number(left.overdue) ||
      rowName(a).localeCompare(rowName(b))
    );
  });
}

const KNOWN_REASONS = new Set([
  "no_snapshot",
  "manifest_unreadable",
  "items_missing",
  "items_unreadable",
  "items_mismatched",
  "storage_corrupt",
  "test_restore_failed",
  "snapshot_outdated",
  "snapshot_stale",
  "nothing_to_verify",
  "test_restore_unconfirmed",
]);

/** The translation of a stored finding; codes from a newer worker get a generic text. */
export function reasonMessage(reason: Omit<Reason, "failure">): Message {
  if (!KNOWN_REASONS.has(reason.code)) {
    return { key: "reason.unknown", values: { code: reason.code } };
  }
  const hours = reason.ageHours ?? 0;
  return {
    key: `reason.${reason.code}`,
    values: { count: reason.count ?? 0, hours, days: Math.floor(hours / 24) },
  };
}

/** "Primary storage" for target 0, "Copy n" for the copies. */
export function targetLabel(target: number): Message {
  return target === 0
    ? { key: "storage.target.primary" }
    : { key: "storage.target.copy", values: { index: target } };
}

const TARGET_STATUSES = new Set([
  "ok",
  "missing",
  "unreadable",
  "size_mismatch",
  "hash_mismatch",
  "malformed",
  "foreign_tenant",
  "index_mismatch",
]);

export function targetStatusKey(status: string): string {
  return TARGET_STATUSES.has(status)
    ? `storage.targetStatus.${status}`
    : "storage.targetStatus.other";
}

const GC_SKIP_REASONS = new Set([
  "sample_run",
  "disabled",
  "partial_manifest_unreadable",
  "backup_running",
  "restore_running",
  "verify_running",
]);

/** What the latest storage check did about unreferenced data; null when there is nothing to say. */
export function gcMessage(
  gc: GcResult | null,
  formatBytes: (bytes: number) => string,
): Message | null {
  if (!gc) {
    return null;
  }
  if (gc.status === "skipped") {
    // A sample run never cleans up; that is the plan, not news.
    if (gc.reason === "sample_run") {
      return null;
    }
    return GC_SKIP_REASONS.has(gc.reason)
      ? { key: `storage.gc.skipped.${gc.reason}` }
      : { key: "storage.gc.skipped.other" };
  }
  if (gc.interruptedBy) {
    return { key: "storage.gc.interrupted" };
  }
  return gc.bytesReclaimed > 0
    ? { key: "storage.gc.reclaimed", values: { bytes: formatBytes(gc.bytesReclaimed) } }
    : { key: "storage.gc.clean" };
}

function problemReason(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) {
    return null;
  }
  const reason = error.problem?.reason;
  return typeof reason === "string" ? reason : null;
}

/** The toast text for a failed "check now": specific for known conflicts, generic otherwise. */
export function startErrorMessage(error: unknown): Message {
  switch (problemReason(error)) {
    case "already_queued":
      return { key: "toast.alreadyQueued" };
    case "no_backup":
      return { key: "toast.noBackup" };
    case "excluded":
      return { key: "toast.excluded" };
    default:
      return { key: `common:${errorMessageKey(error)}` };
  }
}

/** The toast text after "check all now". */
export function runResultMessage(result: RunVerifyResult): Message {
  if (result.queued.length === 0) {
    return { key: "toast.nothingQueued" };
  }
  return result.skipped.length > 0
    ? {
        key: "toast.queuedWithSkipped",
        values: { count: result.queued.length, skipped: result.skipped.length },
      }
    : { key: "toast.queued", values: { count: result.queued.length } };
}

/** The toast text after "verify now" for the backups that are not verified yet. */
export function unverifiedRunMessage(result: RunVerifyResult): Message {
  return result.queued.length === 0
    ? { key: "toast.nothingUnverified" }
    : { key: "toast.unverifiedQueued", values: { count: result.queued.length } };
}

/** Red findings before yellow ones; the order the API sent is kept within each colour. */
export function orderReasons<T extends Pick<Reason, "severity">>(reasons: readonly T[]): T[] {
  return [
    ...reasons.filter((reason) => reason.severity === "red"),
    ...reasons.filter((reason) => reason.severity !== "red"),
  ];
}

/**
 * One piece of the findings list: a finding the server explained (shown as a
 * full explanation), or a run of findings it did not (a code from a newer
 * worker, or none), which keep the plain translated line.
 */
export type FindingBlock =
  | { kind: "explained"; reason: Reason; failure: Failure }
  | { kind: "plain"; reasons: Reason[] };

/** The findings in display order (red first), grouped into {@link FindingBlock}s. */
export function findingBlocks(reasons: readonly Reason[]): FindingBlock[] {
  const blocks: FindingBlock[] = [];
  for (const reason of orderReasons(reasons)) {
    const failure = reason.failure ?? null;
    if (failure) {
      blocks.push({ kind: "explained", reason, failure });
      continue;
    }
    const last = blocks.at(-1);
    if (last?.kind === "plain") {
      last.reasons.push(reason);
    } else {
      blocks.push({ kind: "plain", reasons: [reason] });
    }
  }
  return blocks;
}
