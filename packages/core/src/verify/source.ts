/**
 * What the source's own size signal says about an empty backup (0.5.0, docs/MICROSOFT.md,
 * "Leere Objekte: Nachweis durch Microsoft 365").
 *
 * A backup run records how much the source holds by Graph's own count (manifest
 * `sourceSignal`): for a OneDrive the root folder's `size` and `folder.childCount`, for a
 * mailbox the `totalItemCount` of the folders the backup plans. It measures at the start of
 * the run and, when the snapshot about to be committed holds no content, once more at its
 * end. The verdict here is the single home of the rules:
 *
 *   empty    both measurements say empty: the object is empty by Microsoft 365 and by the
 *            backup, nothing to restore, no admin confirmation needed
 *   content  both measurements say content (for a mailbox: items in folders that are not
 *            hidden): the backup misses what the source holds, red
 *   unknown  no signal, one measurement missing, the two disagree (something was added or
 *            deleted while the run went), only hidden folders hold items, or the mailbox has
 *            or may have an online archive the backup does not reach: the confirmation flow
 *            applies
 *
 * The thresholds are exact (0). `quota.used` is deliberately not a signal: for OneDrive for
 * Business it counts the whole personal site (version history, recycle bins, the
 * Preservation Hold Library), so a never-used drive reports a few KB and a drive whose files
 * were deleted under a hold reports gigabytes for years. It is recorded for display only.
 */
import type { DriveMeasure, MailMeasure, SourceSignal } from "../manifest.js";

export type SourceVerdict = "empty" | "content" | "unknown";

export interface SourceEvidence {
  readonly service: SourceSignal["service"];
  readonly verdict: SourceVerdict;
  /** OneDrive: bytes the root holds by Graph (the smaller of both measurements). */
  readonly bytes?: number;
  /** Mailbox: items Graph counts in folders that are not hidden (the smaller of both). */
  readonly items?: number;
}

function driveEmpty(measure: DriveMeasure): boolean {
  // Empty folders hold no bytes: the backup keeps them as folders and has nothing to restore
  // either. `rootChildren` is recorded for the details view only.
  return measure.rootBytes === 0;
}

function driveContent(measure: DriveMeasure): boolean {
  return measure.rootBytes > 0;
}

function mailEmpty(measure: MailMeasure): boolean {
  return measure.visibleItems === 0 && measure.hiddenItems === 0;
}

function mailContent(measure: MailMeasure): boolean {
  return measure.visibleItems > 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validDrive(measure: DriveMeasure | null | undefined): DriveMeasure | null {
  return measure && finite(measure.rootBytes) && finite(measure.rootChildren) ? measure : null;
}

function validMail(measure: MailMeasure | null | undefined): MailMeasure | null {
  return measure && finite(measure.visibleItems) && finite(measure.hiddenItems) ? measure : null;
}

/** The verdict of a recorded signal; null when the snapshot carries none. */
export function sourceEvidence(signal: SourceSignal | null | undefined): SourceEvidence | null {
  if (!signal || typeof signal !== "object") {
    return null;
  }
  if (signal.service === "onedrive") {
    const before = validDrive(signal.before);
    const after = validDrive(signal.after);
    if (!before || !after) {
      return { service: "onedrive", verdict: "unknown" };
    }
    if (driveEmpty(before) && driveEmpty(after)) {
      return { service: "onedrive", verdict: "empty", bytes: 0 };
    }
    if (driveContent(before) && driveContent(after)) {
      return {
        service: "onedrive",
        verdict: "content",
        bytes: Math.min(before.rootBytes, after.rootBytes),
      };
    }
    return { service: "onedrive", verdict: "unknown" };
  }
  if (signal.service === "mailbox") {
    const before = validMail(signal.before);
    const after = validMail(signal.after);
    if (!before || !after) {
      return { service: "mailbox", verdict: "unknown" };
    }
    if (mailContent(before) && mailContent(after)) {
      return {
        service: "mailbox",
        verdict: "content",
        items: Math.min(before.visibleItems, after.visibleItems),
      };
    }
    // An online archive may hold everything and Graph v1.0 does not show it, so "empty"
    // needs the probe to have shown there is none; "unknown" keeps the confirmation flow.
    if (signal.archive !== "none") {
      return { service: "mailbox", verdict: "unknown" };
    }
    if (mailEmpty(before) && mailEmpty(after)) {
      return { service: "mailbox", verdict: "empty", items: 0 };
    }
    return { service: "mailbox", verdict: "unknown" };
  }
  return null;
}
