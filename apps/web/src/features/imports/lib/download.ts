import type { ImportDetail } from "../types";

/** Save text as a file through a temporary link. */
export function downloadTextFile(fileName: string, text: string, mime = "application/json"): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** `import-report-<name>-<date>.json`, safe on every file system. */
export function reportFileName(name: string, when: Date): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .toLowerCase();
  const day = when.toISOString().slice(0, 10);
  return `import-report-${slug || "mailbox"}-${day}.json`;
}

/** The report of an import as JSON: the request and its outcome, the way the API reported them. */
export function buildReportJson(detail: ImportDetail): string {
  return JSON.stringify(
    {
      id: detail.id,
      name: detail.name,
      objectId: detail.objectId,
      sourceId: detail.sourceId,
      status: detail.status,
      archive: detail.archive,
      createdAt: detail.createdAt,
      startedAt: detail.startedAt,
      completedAt: detail.completedAt,
      errorMessage: detail.errorMessage,
      files: detail.files,
      report: detail.report,
    },
    null,
    2,
  );
}
