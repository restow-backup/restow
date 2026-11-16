const GIB = 1024 ** 3;
/** A disk is low below a tenth of its size, and never with less than 5 GiB (a quarter on a small one). */
export const DISK_LOW_SHARE = 0.1;
export const DISK_LOW_MIN_BYTES = 5 * GIB;

/** The free space below which a disk of `totalBytes` counts as low. */
export function diskThreshold(totalBytes: number): number {
  return Math.ceil(
    Math.max(totalBytes * DISK_LOW_SHARE, Math.min(DISK_LOW_MIN_BYTES, totalBytes * 0.25)),
  );
}
