/**
 * Paths, audit actions and problem types of the file share feature (docs/FILESHARES.md): the
 * runner's internal routes (Phase B) and the tenant routes under /api/v1/file-shares (Phase C).
 */

/** The runner routes restow-share calls (5.2), on the internal `runners` network only. */
export const FILE_SHARE_RUNNER_PATH = "/internal/file-shares/v1";

/** The runner's audit action (the restic route); the tenant routes' actions are in audit.ts. */
export const FILE_SHARE_RUNNER_AUDIT_ACTIONS = {
  repositoryDenied: "file_share.repository.denied",
} as const;

/** Problem types of the feature (9.1). */
export const FILE_SHARE_PROBLEMS = {
  quotaExceeded: "urn:restow:problem:file-share-quota-exceeded",
  runFinished: "urn:restow:problem:file-share-run-finished",
  nameTaken: "urn:restow:problem:file-share-name-taken",
  hostNotAllowed: "urn:restow:problem:file-share-host-not-allowed",
  restoreNotAllowed: "urn:restow:problem:file-share-restore-not-allowed",
  busy: "urn:restow:problem:file-share-busy",
  mounterUnavailable: "urn:restow:problem:file-share-mounter-unavailable",
  copyUnsafeTarget: "urn:restow:problem:file-share-copy-unsafe-target",
  copyConfirm: "urn:restow:problem:file-share-copy-confirm",
  invalid: "urn:restow:problem:file-share-invalid",
  locationChange: "urn:restow:problem:file-share-location-change",
  confirmName: "urn:restow:problem:file-share-confirm-name",
  retired: "urn:restow:problem:file-share-retired",
  nothingToTest: "urn:restow:problem:file-share-nothing-to-test",
  catalogUnavailable: "urn:restow:problem:file-share-catalog-unavailable",
  pathNotFound: "urn:restow:problem:file-share-path-not-found",
  downloadGone: "urn:restow:problem:file-share-download-gone",
  repositoryUnavailable: "urn:restow:problem:file-share-repository-unavailable",
  providerOnly: "urn:restow:problem:file-share-provider-only",
} as const;
