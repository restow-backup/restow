import type { UploadItem } from "./types";

/**
 * Transfer speed over a sliding window. Feed it `(time, total bytes done)`
 * samples; the speed is the slope across the window, so a stall shows up as a
 * falling speed after a few seconds instead of an average over the whole run.
 */
export class SpeedMeter {
  private samples: Array<{ at: number; bytes: number }> = [];

  constructor(private readonly windowMs = 10_000) {}

  reset(): void {
    this.samples = [];
  }

  record(at: number, bytes: number): void {
    const last = this.samples[this.samples.length - 1];
    // Bytes only grow while a batch runs; a smaller value means a new batch.
    if (last && bytes < last.bytes) {
      this.samples = [];
    }
    if (last && last.at === at && bytes === last.bytes) {
      return;
    }
    this.samples.push({ at, bytes });
    const cutoff = at - this.windowMs;
    while (this.samples.length > 2 && (this.samples[1] as { at: number }).at <= cutoff) {
      this.samples.shift();
    }
  }

  /** Bytes per second, or null while there are not enough samples for an honest number. */
  bytesPerSecond(now: number): number | null {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || first === last) {
      return null;
    }
    // A pause since the last sample counts as time without progress.
    const span = Math.max(now, last.at) - first.at;
    if (span < 1_000) {
      return null;
    }
    const speed = ((last.bytes - first.bytes) / span) * 1000;
    return speed > 0 ? speed : null;
  }
}

export interface OverallProgress {
  /** Files that take part in the batch (not cancelled, not removed). */
  files: number;
  filesDone: number;
  filesFailed: number;
  totalBytes: number;
  uploadedBytes: number;
  /** 0..1 */
  ratio: number;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  /** Something is still being transferred, opened or completed. */
  busy: boolean;
}

const FINISHED: ReadonlySet<UploadItem["status"]> = new Set(["ready", "refused"]);
const BUSY: ReadonlySet<UploadItem["status"]> = new Set([
  "queued",
  "opening",
  "uploading",
  "completing",
]);

/** Progress of the whole batch from the items and the measured speed. */
export function overallProgress(
  items: readonly UploadItem[],
  bytesPerSecond: number | null,
): OverallProgress {
  let files = 0;
  let filesDone = 0;
  let filesFailed = 0;
  let totalBytes = 0;
  let uploadedBytes = 0;
  let busy = false;
  for (const item of items) {
    if (item.status === "cancelled") {
      continue;
    }
    files += 1;
    totalBytes += item.size;
    if (FINISHED.has(item.status)) {
      filesDone += 1;
      uploadedBytes += item.size;
    } else {
      uploadedBytes += Math.min(item.size, item.uploadedBytes);
    }
    if (item.status === "failed") {
      filesFailed += 1;
    }
    if (BUSY.has(item.status)) {
      busy = true;
    }
  }
  const remaining = Math.max(0, totalBytes - uploadedBytes);
  return {
    files,
    filesDone,
    filesFailed,
    totalBytes,
    uploadedBytes,
    ratio: totalBytes > 0 ? Math.min(1, uploadedBytes / totalBytes) : 0,
    bytesPerSecond: busy ? bytesPerSecond : null,
    etaSeconds:
      busy && bytesPerSecond && bytesPerSecond > 0 && remaining > 0
        ? Math.ceil(remaining / bytesPerSecond)
        : null,
    busy,
  };
}

/** Share of one item (0..1). */
export function itemRatio(item: UploadItem): number {
  if (FINISHED.has(item.status)) {
    return 1;
  }
  return item.size > 0 ? Math.min(1, item.uploadedBytes / item.size) : 0;
}
