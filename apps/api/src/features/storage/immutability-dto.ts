import {
  type ImmutabilityMode,
  type ImmutabilitySettings,
  parseImmutabilitySettings,
  RENEWAL_BUFFER_DAYS,
  renewalOverdue,
} from "@restow/core";
import type { StorageTarget, StorageTargetImmutabilityState } from "@restow/db";

/**
 * The immutability of a repository as the web interface shows it (pure; see
 * immutability.ts for the changes and docs/STORAGE.md, "Immutable backups").
 */

export interface ImmutabilityDto {
  mode: ImmutabilityMode | null;
  days: number;
  /** `object_lock`: enforced and reported by the storage (S3); `deletion_delay`: by Restow only. */
  kind: "object_lock" | "deletion_delay";
  /** When the current setting was made. */
  since: string | null;
  renewalBufferDays: number;
  /** Start of the last complete renewal (Object Lock only). */
  renewedAt: string | null;
  /** The renewal is older than the buffer: reused data may be locked for less than the period. */
  renewalOverdue: boolean;
  renewal: StorageTargetImmutabilityState["renewal"] | null;
  verification: StorageTargetImmutabilityState["verification"] | null;
  /** Deletions the storage refused because the object was still locked, still pending. */
  deferredDeletions: number;
  /** Earlier settings, newest first (at most ten). */
  history: { since: string; days: number; mode: ImmutabilityMode | null }[];
  /** Whether the viewer may lower or switch it off (provider owner; a recent sign-in is asked then). */
  canLower: boolean;
}

/** The setting of a row, read leniently. */
export function settingsOf(row: Pick<StorageTarget, "immutability">): ImmutabilitySettings | null {
  return parseImmutabilitySettings(row.immutability);
}

export function toImmutabilityDto(
  row: Pick<StorageTarget, "kind" | "immutability" | "immutabilityState">,
  deferredDeletions: number,
  viewer: { readonly isProviderOwner?: boolean },
  now: Date = new Date(),
): ImmutabilityDto {
  const settings = settingsOf(row);
  const state = row.immutabilityState ?? {};
  const history = settings?.history ?? [];
  const current = history.at(-1) ?? null;
  const objectLock = row.kind === "s3";
  const active = !!settings?.mode;
  const renewedAt = state.renewedAt ?? null;
  return {
    mode: settings?.mode ?? null,
    days: settings?.days ?? 0,
    kind: objectLock ? "object_lock" : "deletion_delay",
    since: current?.since ?? null,
    renewalBufferDays: RENEWAL_BUFFER_DAYS,
    renewedAt,
    renewalOverdue:
      objectLock &&
      active &&
      current !== null &&
      renewalOverdue(renewedAt ? new Date(renewedAt) : null, new Date(current.since), now),
    renewal: state.renewal ?? null,
    verification: state.verification ?? null,
    deferredDeletions,
    history: [...history].reverse().slice(0, 10),
    canLower: viewer.isProviderOwner === true,
  };
}
