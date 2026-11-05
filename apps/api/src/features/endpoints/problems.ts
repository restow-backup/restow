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
  /**
   * 422: the time windows of the upload limit cannot be saved as sent (a window without days, a time
   * that is not HH:MM, windows that overlap). `issues[0].path` names the window and its field.
   */
  invalidBandwidthWindows: "urn:restow:problem:endpoint-invalid-bandwidth-windows",
  /**
   * 409: the machine belongs to a backup job, which decides its schedule, folders, exclusions,
   * hooks and bandwidth (and the retention when the job sets one). Change the job instead.
   */
  configManagedByJob: "urn:restow:problem:endpoint-config-managed-by-job",
  /**
   * 409: the machine is in no backup job, and backups run only in a job (release 0.2.1): a backup
   * on request, or a schedule other than `none`, is refused. Add the machine to a job instead.
   */
  noJob: "urn:restow:problem:endpoint-no-job",
  /**
   * 422: the person a machine was to be assigned to is not in the tenant's protection directory
   * (removed meanwhile, or of another tenant).
   */
  assigneeUnknown: "urn:restow:problem:endpoint-assignee-unknown",
  /**
   * 422: an agent policy (installation, tenant or a job's level) cannot be saved as sent (a backup
   * window without days, a time that is not HH:MM, retries out of range). `issues` names the
   * setting and the problem.
   */
  invalidAgentPolicy: "urn:restow:problem:agent-policy-invalid",
  /**
   * 409: a tenant or a job sets a setting of the agent policy that the installation locked;
   * `keys` lists them.
   */
  agentPolicyLocked: "urn:restow:problem:agent-policy-locked",
  /** 409: only a revoked machine can be removed (#65). */
  notRevoked: "urn:restow:problem:endpoint-not-revoked",
  /** 422: the hostname typed to confirm a removal is not the machine's. */
  confirmHostname: "urn:restow:problem:endpoint-confirm-hostname",
  /** 409: deleting a removed machine's backups now is refused while a legal hold covers the tenant. */
  removalLegalHold: "urn:restow:problem:endpoint-removal-legal-hold",
  /** 409: ... and while a suspicious restore point of the machine holds them. */
  removalSuspicionHold: "urn:restow:problem:endpoint-removal-suspicion-hold",
  /** 409: keeping the backups until they expire, but the machine's retention keeps everything. */
  removalNeverExpires: "urn:restow:problem:endpoint-removal-never-expires",
  /**
   * 422 or 403: a selected path is not handed out (docs/BAREMETAL.md 5.4). 422 with `reason:
   * "agent_state"` for the agent's state file (for everybody); 403 with `reason: "key_file"` for a
   * LUKS key file of the machine's layout and the restore role. `path` names it.
   */
  restorePathLocked: "urn:restow:problem:endpoint-restore-path-locked",
  /** 409: whole machine backups are a preview this installation has not switched on (RESTOW_BAREMETAL_PREVIEW). */
  baremetalPreviewOff: "urn:restow:problem:baremetal-preview-off",
  // Bare metal recovery (docs/BAREMETAL.md 9, 11): the recovery API of the ISO and the session API.
  /** 401: no code matches the proof (wrong code, or a code issued for another address). */
  recoveryCodeInvalid: "urn:restow:problem:recovery-code-invalid",
  /** 410: the code expired before it was redeemed. */
  recoveryCodeExpired: "urn:restow:problem:recovery-code-expired",
  /** 410: the code was revoked. */
  recoveryCodeRevoked: "urn:restow:problem:recovery-code-revoked",
  /** 409: the code was redeemed already (by another session secret, or too long ago). */
  recoveryCodeUsed: "urn:restow:problem:recovery-code-used",
  /** 426: the ISO is older than the server serves (`minRecoveryVersion`). */
  recoveryTooOld: "urn:restow:problem:recovery-too-old",
  /** 401: the session ended, was released, cancelled or expired (also the restic route's answer). */
  recoverySessionEnded: "urn:restow:problem:recovery-session-ended",
  /** 409: the session waits for an admin to release it. */
  recoveryNotApproved: "urn:restow:problem:recovery-not-approved",
  /** 409: the credentials were collected twice, or the window for the second time has passed. */
  recoveryCredentialsCollected: "urn:restow:problem:recovery-credentials-collected",
  /** 409: the session is in a state that does not allow this (`extensions.status`). */
  recoveryStateConflict: "urn:restow:problem:recovery-state-conflict",
  /**
   * 409: no recovery code for this machine (`extensions.reason`: `not_linux`, `removed`,
   * `no_layout`, `unsupported`, `iso_unverified`, `preview_off`, `snapshot_unknown`).
   */
  baremetalNotAvailable: "urn:restow:problem:baremetal-not-available",
  /** 409: three codes of this machine are open already. */
  recoveryLimitReached: "urn:restow:problem:recovery-limit-reached",
  /** 409: a recovery session reads the machine's backups; removing them waits for it. */
  recoveryActive: "urn:restow:problem:endpoint-recovery-active",
  /** 422: a rebind token was redeemed from another operating system than the machine's. */
  rebindOsMismatch: "urn:restow:problem:endpoint-rebind-os-mismatch",
} as const;
