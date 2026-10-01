/** Export formats the product offers and why some are not available. */

export type ExportFormatId = "eml_zip" | "mbox" | "msg_zip" | "pst";

export interface ExportFormatInfo {
  readonly id: ExportFormatId;
  readonly available: boolean;
  /** True for a format that is on the roadmap. */
  readonly planned?: boolean;
  /** English note for the API; the web app shows its own translated text. */
  readonly reason?: string;
}

/**
 * `msg_zip` is NOT offered in 0.1.0. A writer existed and passed a round trip
 * against `@kenjiuno/msgreader` (`@tutao/oxmsg`, evaluated 2026-09-30), but its
 * license is contradictory: package.json and the npm registry say MIT while the
 * LICENSE file in the package and in its repository is the GNU GPL-3.0. Shipping
 * a dependency whose terms are unclear in the image is not acceptable, so the
 * format stays off until the license is clarified or a permissively licensed
 * writer exists. The database enum keeps the value for that day.
 */
export const EXPORT_FORMATS: readonly ExportFormatInfo[] = [
  { id: "eml_zip", available: true },
  { id: "mbox", available: true },
  {
    id: "msg_zip",
    available: false,
    reason:
      "no MSG writer with a clear permissive license is available (the only candidate has a contradictory license)",
  },
  {
    id: "pst",
    available: false,
    planned: true,
    reason: "PST export is planned for a later release",
  },
];

export function findExportFormat(id: string): ExportFormatInfo | undefined {
  return EXPORT_FORMATS.find((format) => format.id === id);
}

export function isExportFormatAvailable(id: string): boolean {
  return findExportFormat(id)?.available === true;
}

/** File extension (with dot) and media type of the file an export format produces. */
export function exportFileInfo(
  id: ExportFormatId,
): { extension: string; contentType: string } | null {
  switch (id) {
    case "eml_zip":
    case "msg_zip":
      return { extension: ".zip", contentType: "application/zip" };
    case "mbox":
      return { extension: ".mbox", contentType: "application/mbox" };
    default:
      return null;
  }
}
