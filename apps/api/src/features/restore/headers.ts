/** Response header helpers for the download route (pure, tested). */

/** RFC 6266 `Content-Disposition` with a plain ASCII fallback for older clients. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
