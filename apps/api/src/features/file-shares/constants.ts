/**
 * Paths, audit actions and problem types of the file share feature (docs/FILESHARES.md).
 * Phase B serves only the runner's internal routes; the tenant routes follow in Phase C.
 */

/** The runner routes restow-share calls (5.2), on the internal `runners` network only. */
export const FILE_SHARE_RUNNER_PATH = "/internal/file-shares/v1";

/** Audit actions of Phase B (9.2 lists the rest, Phase C). */
export const FILE_SHARE_AUDIT_ACTIONS = {
  repositoryDenied: "file_share.repository.denied",
} as const;

export const FILE_SHARE_PROBLEMS = {
  quotaExceeded: "urn:restow:problem:file-share-quota-exceeded",
  runFinished: "urn:restow:problem:file-share-run-finished",
} as const;
