/**
 * The problem types of the endpoint feature (RFC 7807 `type`; the table in
 * docs/AGENT.md, "Problem types", lists them with their status codes). The
 * web app words a failed request by its `type`, never by its title, so every
 * refusal an admin can act on has a type of its own.
 *
 * The session API of this feature is not part of the integration API's
 * OpenAPI document (it serves the web app only), so these types are
 * documented in docs/AGENT.md and not there.
 */
export const ENDPOINT_PROBLEMS = {
  /** 422: the operating system is not supported (Windows is planned, not shipped). */
  unsupportedOs: "urn:restow:problem:unsupported-os",
  /** 401 to an agent with a revoked endpoint's credentials, 409 for an admin change or task on it. */
  revoked: "urn:restow:problem:endpoint-revoked",
  /** 409: a restore test was asked for, but the endpoint has no good backup to test. */
  nothingToTest: "urn:restow:problem:endpoint-nothing-to-test",
  /** 503: the public address of this installation is not set, so no install command can be built. */
  instanceUnknown: "urn:restow:problem:endpoint-instance-unknown",
  /** 503: the worker has not created its job queues yet. */
  queueNotReady: "urn:restow:problem:endpoint-queue-not-ready",
  /** 404: a selected path is not a file or folder of the snapshot. */
  pathNotFound: "urn:restow:problem:endpoint-path-not-found",
  /** 409: the enrollment token was used or revoked already. */
  tokenSettled: "urn:restow:problem:endpoint-token-settled",
  /** 404: a prepared download is unknown, expired or was used already. */
  downloadGone: "urn:restow:problem:endpoint-download-gone",
  /** 413: the selection of a download is too large to send (too many or too long paths). */
  downloadTooLarge: "urn:restow:problem:endpoint-download-too-large",
  /** 400: a browse cursor is not one this endpoint issued. */
  invalidCursor: "urn:restow:problem:endpoint-invalid-cursor",
  /** 503: the repository is locked by a running backup or maintenance job. */
  repositoryLocked: "urn:restow:problem:endpoint-repository-locked",
  /** 409 or 500: the repository, or its password, is not available. */
  repositoryUnavailable: "urn:restow:problem:endpoint-repository-unavailable",
  /** 502: restic failed in a way with no more specific type. */
  resticFailed: "urn:restow:problem:restic-failed",
  /** 503: the restic binary is missing on the server. */
  resticUnavailable: "urn:restow:problem:restic-unavailable",
  /** 429: too many snapshot reads run at once. */
  resticBusy: "urn:restow:problem:restic-busy",
  /**
   * 403 to an agent's upload: the storage budget of the endpoint or of all the
   * tenant's endpoints is used up (@restow/core QUOTA_EXCEEDED_PROBLEM).
   */
  quotaExceeded: "urn:restow:problem:endpoint-quota-exceeded",
  /**
   * 409: hooks were set for a machine whose agent does not allow hooks from
   * the server (the local policy is off, or the agent does not report one).
   */
  hooksNotAllowed: "urn:restow:problem:endpoint-hooks-not-allowed",
  /** 422: the machine only runs named scripts from its hooks folder, and a hook is not such a name. */
  hookNotAScript: "urn:restow:problem:endpoint-hook-not-a-script",
} as const;
