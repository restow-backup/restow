/**
 * The capture ways this build has (./ways.ts). One line per way:
 *
 *   graph_sync  Microsoft Graph (./graph.ts)
 *   imap_sync   IMAP (./imap.ts)
 *
 * A stream whose way is not listed stays `pending` and the capture status names the way
 * as unavailable in this build; nothing fails.
 */
import { createImapCaptureWay } from "./imap.js";
import type { CaptureWay, MailboxWay } from "./ways.js";

export const CAPTURE_WAYS: Partial<Record<MailboxWay, CaptureWay>> = {
  imap_sync: createImapCaptureWay(),
};

/** The way registered for `way` (tests replace the table through `ways` options instead). */
export function captureWay(
  way: MailboxWay,
  ways: Partial<Record<MailboxWay, CaptureWay>> = CAPTURE_WAYS,
): CaptureWay | null {
  return ways[way] ?? null;
}
