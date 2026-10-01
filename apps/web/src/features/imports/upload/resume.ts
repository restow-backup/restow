import type { ImportUploadDto } from "../types";

/**
 * Earlier uploads that can still be continued: not finished with an import
 * and not refused. A browser cannot reopen a file by itself, so continuing
 * means the person picks the same file again; it is then matched by name and
 * size (the only things the server knows about it).
 */
export function resumableUploads(uploads: readonly ImportUploadDto[]): ImportUploadDto[] {
  return uploads.filter(
    (upload) => (upload.status === "uploading" || upload.status === "ready") && !upload.refusal,
  );
}

export interface PickedFile {
  name: string;
  size: number;
}

/**
 * Pair every picked file with the earlier upload it continues, if any. A
 * finished (`ready`) upload wins over a partial one; of several partial ones
 * the furthest wins; one upload continues one file only.
 */
export function assignResumes<T extends PickedFile>(
  files: readonly T[],
  candidates: readonly ImportUploadDto[],
): Array<{ file: T; resume: ImportUploadDto | null }> {
  const free = [...candidates];
  return files.map((file) => {
    const matches = free
      .filter((upload) => upload.fileName === file.name && upload.size === file.size)
      .sort((a, b) => rank(b) - rank(a));
    const best = matches[0] ?? null;
    if (best) {
      free.splice(free.indexOf(best), 1);
    }
    return { file, resume: best };
  });
}

function rank(upload: ImportUploadDto): number {
  return upload.status === "ready" ? Number.MAX_SAFE_INTEGER : upload.receivedSegments.length;
}

/** Share of an unfinished upload the server already holds (0..1). */
export function receivedRatio(upload: ImportUploadDto): number {
  if (upload.status === "ready") {
    return 1;
  }
  return upload.segmentCount > 0
    ? Math.min(1, upload.receivedSegments.length / upload.segmentCount)
    : 0;
}
