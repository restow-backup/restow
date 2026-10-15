/**
 * What is known about each failure code besides its texts: where it comes
 * from, whether waiting is enough, whether a retry makes sense, and which
 * steps an operator can take (with the place in the UI to take them).
 *
 * The texts (headline, explanation, step wording) live in
 * packages/i18n/resources/{en,de}/failures.json under
 * `cause.<code>.{title,why}` and `steps.<stepId>`; a test in apps/api fails
 * for any code or step without both languages.
 */
import {
  FAILURE_CODES,
  type FailureCategory,
  type FailureCode,
  type FailureParams,
  type FailureStep,
  type FailureStepId,
  type FailureTarget,
} from "./types.js";

export interface FailureCatalogEntry {
  readonly category: FailureCategory;
  /** Waiting is enough by default: the run is retried automatically. */
  readonly transient: boolean;
  /**
   * A manual "Retry now" is sensible: once the cause is fixed (or at once, for
   * transient causes). False where retrying can only fail the same way until
   * the object or the configuration changes.
   */
  readonly retryable: boolean;
  readonly steps: (params: FailureParams) => readonly FailureStep[];
}

function step(id: FailureStepId, target: FailureTarget | null = null): FailureStep {
  return { id, target };
}

const READ_DETAILS = step("read_technical_details");

/** Steps for the network codes, by the kind of host that could not be reached. */
function networkSteps(kind: "unreachable" | "dns" | "timeout" | "tls") {
  return (params: FailureParams): readonly FailureStep[] => {
    const role = params.role;
    const steps: FailureStep[] = [];
    if (kind === "dns") {
      steps.push(step("check_dns"));
    } else if (kind === "tls") {
      steps.push(step("check_tls_certificate"));
    } else {
      steps.push(step("check_host_reachable"));
    }
    if (role === "imap") {
      steps.push(step(kind === "tls" ? "check_imap_security" : "check_source_settings", "source"));
    }
    if (kind === "timeout") {
      steps.push(step("wait_automatic"));
    }
    return steps;
  };
}

export const FAILURE_CATALOG: Readonly<Record<FailureCode, FailureCatalogEntry>> = {
  // --- Microsoft 365 -----------------------------------------------------------------------
  "graph.consent_missing": {
    category: "microsoft",
    transient: false,
    retryable: true,
    steps: () => [
      step("regrant_consent", "source"),
      step("verify_permissions", "source"),
      step("check_app_credentials", "settings_microsoft"),
    ],
  },
  "graph.app_credentials_invalid": {
    category: "microsoft",
    transient: false,
    retryable: true,
    steps: () => [step("check_app_credentials", "settings_microsoft"), READ_DETAILS],
  },
  "graph.tenant_not_found": {
    category: "microsoft",
    transient: false,
    retryable: true,
    steps: () => [step("check_tenant_id", "source"), step("regrant_consent", "source")],
  },
  "graph.token_rejected": {
    category: "microsoft",
    transient: true,
    retryable: true,
    steps: () => [
      step("wait_automatic"),
      step("check_server_clock"),
      step("check_app_credentials", "settings_microsoft"),
    ],
  },
  "graph.permission_missing": {
    category: "microsoft",
    transient: false,
    retryable: true,
    steps: () => [step("grant_permission", "source"), step("verify_permissions", "source")],
  },
  "graph.access_denied": {
    category: "microsoft",
    transient: false,
    retryable: true,
    steps: () => [
      step("verify_permissions", "source"),
      step("check_access_policy"),
      step("exclude_object", "directory"),
    ],
  },
  "graph.mailbox_not_licensed": {
    category: "microsoft",
    transient: false,
    retryable: true,
    steps: () => [step("assign_license"), step("exclude_object", "directory")],
  },
  "graph.user_not_found": {
    category: "microsoft",
    transient: false,
    retryable: false,
    steps: () => [step("sync_directory", "directory"), step("exclude_object", "directory")],
  },
  "graph.onedrive_unavailable": {
    category: "microsoft",
    transient: false,
    retryable: true,
    steps: () => [step("assign_onedrive_license"), step("exclude_object", "directory")],
  },
  "graph.throttled": {
    category: "microsoft",
    transient: true,
    retryable: true,
    steps: () => [step("wait_throttled")],
  },
  "graph.service_unavailable": {
    category: "microsoft",
    transient: true,
    retryable: true,
    steps: () => [step("wait_automatic"), step("check_service_health")],
  },
  "graph.item_not_found": {
    category: "microsoft",
    transient: true,
    retryable: true,
    steps: () => [step("wait_automatic")],
  },
  "graph.item_too_large": {
    category: "microsoft",
    transient: false,
    retryable: false,
    steps: () => [step("item_stays_failed")],
  },
  "graph.item_unreadable": {
    category: "microsoft",
    transient: false,
    retryable: false,
    steps: () => [step("open_item_at_source"), step("contact_microsoft_support")],
  },
  "graph.item_incomplete": {
    category: "microsoft",
    transient: true,
    retryable: true,
    steps: () => [step("wait_automatic"), step("open_item_at_source")],
  },
  "graph.delta_expired": {
    category: "microsoft",
    transient: true,
    retryable: true,
    steps: () => [step("wait_automatic")],
  },
  "graph.quota_exceeded": {
    category: "microsoft",
    transient: false,
    retryable: true,
    steps: () => [step("free_target_space")],
  },
  "graph.request_rejected": {
    category: "microsoft",
    transient: false,
    retryable: true,
    steps: () => [READ_DETAILS, step("contact_microsoft_support")],
  },

  // --- IMAP --------------------------------------------------------------------------------
  "imap.auth_failed": {
    category: "imap",
    transient: false,
    retryable: true,
    steps: () => [
      step("check_app_password", "source"),
      step("enable_imap_access"),
      step("set_object_password", "directory"),
    ],
  },
  "imap.oauth_failed": {
    category: "imap",
    transient: false,
    retryable: true,
    steps: () => [step("reauthorize_oauth", "source")],
  },
  "imap.credential_missing": {
    category: "imap",
    transient: false,
    retryable: true,
    steps: () => [
      step("set_object_password", "directory"),
      step("check_source_settings", "source"),
    ],
  },
  "imap.starttls_unavailable": {
    category: "imap",
    transient: false,
    retryable: true,
    steps: () => [step("check_imap_security", "source")],
  },
  "imap.address_blocked": {
    category: "imap",
    transient: false,
    retryable: true,
    steps: () => [
      step("approve_private_network", "source"),
      step("check_source_settings", "source"),
    ],
  },
  "imap.config_invalid": {
    category: "imap",
    transient: false,
    retryable: true,
    steps: () => [step("check_source_settings", "source"), READ_DETAILS],
  },
  "imap.command_failed": {
    category: "imap",
    transient: false,
    retryable: true,
    steps: () => [READ_DETAILS, step("check_source_settings", "source")],
  },
  "imap.mailbox_full": {
    category: "imap",
    transient: false,
    retryable: true,
    steps: () => [step("free_target_space")],
  },
  "imap.connection_lost": {
    category: "imap",
    transient: true,
    retryable: true,
    steps: () => [step("wait_automatic"), step("check_server_limits")],
  },
  "imap.message_missing": {
    category: "imap",
    transient: true,
    retryable: true,
    steps: () => [step("wait_automatic"), step("check_server_limits")],
  },

  // --- Network -----------------------------------------------------------------------------
  "network.dns": {
    category: "network",
    transient: true,
    retryable: true,
    steps: networkSteps("dns"),
  },
  "network.unreachable": {
    category: "network",
    transient: true,
    retryable: true,
    steps: networkSteps("unreachable"),
  },
  "network.timeout": {
    category: "network",
    transient: true,
    retryable: true,
    steps: networkSteps("timeout"),
  },
  "network.tls": {
    category: "network",
    transient: false,
    retryable: true,
    steps: networkSteps("tls"),
  },

  // --- Storage -----------------------------------------------------------------------------
  "storage.path_missing": {
    category: "storage",
    transient: false,
    retryable: true,
    steps: () => [step("check_storage_path", "storage")],
  },
  "storage.not_writable": {
    category: "storage",
    transient: false,
    retryable: true,
    steps: () => [step("check_storage_path", "storage")],
  },
  "storage.full": {
    category: "storage",
    transient: false,
    retryable: true,
    steps: () => [step("free_storage_space", "storage")],
  },
  "storage.access_denied": {
    category: "storage",
    transient: false,
    retryable: true,
    steps: () => [
      step("check_storage_permissions", "storage"),
      step("check_storage_credentials", "storage"),
    ],
  },
  "storage.credentials_invalid": {
    category: "storage",
    transient: false,
    retryable: true,
    steps: () => [step("check_storage_credentials", "storage")],
  },
  "storage.bucket_missing": {
    category: "storage",
    transient: false,
    retryable: true,
    steps: () => [step("check_bucket", "storage"), step("check_storage_endpoint", "storage")],
  },
  "storage.wrong_region": {
    category: "storage",
    transient: false,
    retryable: true,
    steps: () => [step("check_storage_endpoint", "storage")],
  },
  "storage.unreachable": {
    category: "storage",
    transient: true,
    retryable: true,
    steps: () => [step("check_storage_endpoint", "storage"), step("check_host_reachable")],
  },
  "storage.timeout": {
    category: "storage",
    transient: true,
    retryable: true,
    steps: () => [step("wait_automatic"), step("check_storage_endpoint", "storage")],
  },
  "storage.tls": {
    category: "storage",
    transient: false,
    retryable: true,
    steps: () => [step("check_tls_certificate"), step("check_storage_endpoint", "storage")],
  },
  "storage.rate_limited": {
    category: "storage",
    transient: true,
    retryable: true,
    steps: () => [step("wait_automatic")],
  },
  "storage.integrity": {
    category: "storage",
    transient: false,
    retryable: true,
    steps: () => [step("check_storage_health", "storage"), step("run_health_check", "verify")],
  },
  "storage.error": {
    category: "storage",
    transient: true,
    retryable: true,
    steps: () => [step("check_storage_health", "storage"), READ_DETAILS],
  },

  // --- Encryption --------------------------------------------------------------------------
  "crypto.key_missing": {
    category: "crypto",
    transient: false,
    retryable: true,
    steps: () => [step("check_master_key"), step("restore_key_backup")],
  },
  "crypto.key_invalid": {
    category: "crypto",
    transient: false,
    retryable: true,
    steps: () => [step("check_master_key"), step("restore_key_backup")],
  },

  // --- Verification ------------------------------------------------------------------------
  "verify.hash_mismatch": {
    category: "verify",
    transient: false,
    retryable: true,
    steps: () => [
      step("run_backup_again", "jobs"),
      step("restore_from_copy", "storage"),
      step("run_health_check", "verify"),
    ],
  },
  "verify.chunk_missing": {
    category: "verify",
    transient: false,
    retryable: true,
    steps: () => [step("run_backup_again", "jobs"), step("restore_from_copy", "storage")],
  },
  "verify.pack_unreadable": {
    category: "verify",
    transient: false,
    retryable: true,
    steps: () => [
      step("check_storage_health", "storage"),
      step("restore_from_copy", "storage"),
      step("check_master_key"),
    ],
  },
  "verify.storage_corrupt": {
    category: "verify",
    transient: false,
    retryable: true,
    steps: () => [step("restore_from_copy", "storage"), step("run_backup_again", "jobs")],
  },
  "verify.restore_test_failed": {
    category: "verify",
    transient: false,
    retryable: true,
    steps: () => [step("check_test_target", "source"), READ_DETAILS],
  },
  "verify.manifest_unreadable": {
    category: "verify",
    transient: false,
    retryable: true,
    steps: () => [
      step("check_storage_health", "storage"),
      step("check_master_key"),
      step("restore_from_copy", "storage"),
    ],
  },
  "verify.no_snapshot": {
    category: "verify",
    transient: false,
    retryable: false,
    steps: () => [step("run_backup_again", "jobs")],
  },
  "verify.snapshot_outdated": {
    category: "verify",
    transient: false,
    retryable: false,
    steps: () => [step("run_backup_again", "jobs")],
  },
  "verify.snapshot_stale": {
    category: "verify",
    transient: false,
    retryable: false,
    steps: () => [step("run_backup_again", "jobs")],
  },
  "verify.nothing_to_verify": {
    category: "verify",
    transient: false,
    retryable: false,
    steps: () => [step("run_backup_again", "jobs")],
  },
  "verify.restore_test_unconfirmed": {
    category: "verify",
    transient: false,
    retryable: true,
    steps: () => [step("check_test_target", "source")],
  },
  // A check that could not read the data back for a reason that proves nothing (an error
  // nobody could classify); a known cause (storage unreachable, ...) is reported as itself.
  "verify.incomplete": {
    category: "verify",
    transient: true,
    retryable: true,
    steps: () => [step("check_storage_health", "storage"), READ_DETAILS],
  },

  // --- Configuration -----------------------------------------------------------------------
  "config.source_not_connected": {
    category: "config",
    transient: false,
    retryable: true,
    steps: () => [step("reconnect_source", "source")],
  },
  "config.source_disabled": {
    category: "config",
    transient: false,
    retryable: true,
    steps: () => [step("enable_source", "source")],
  },
  "config.object_excluded": {
    category: "config",
    transient: false,
    retryable: false,
    steps: () => [step("include_object", "directory")],
  },
  "config.object_orphaned": {
    category: "config",
    transient: false,
    retryable: false,
    steps: () => [step("sync_directory", "directory")],
  },
  "config.app_not_configured": {
    category: "config",
    transient: false,
    retryable: true,
    steps: () => [step("configure_app", "settings_microsoft")],
  },
  "config.invalid": {
    category: "config",
    transient: false,
    retryable: true,
    steps: () => [step("check_source_settings", "source"), READ_DETAILS],
  },

  // --- Servers and clients (the agent) -----------------------------------------------------
  "endpoint.no_paths": {
    category: "endpoint",
    transient: false,
    retryable: true,
    steps: () => [step("check_endpoint_paths")],
  },
  "endpoint.pre_hook_failed": {
    category: "endpoint",
    transient: false,
    retryable: true,
    steps: () => [step("check_endpoint_hooks"), READ_DETAILS],
  },
  "endpoint.hooks_not_allowed": {
    category: "endpoint",
    transient: false,
    retryable: true,
    steps: () => [step("allow_endpoint_hooks")],
  },
  "endpoint.post_hook_failed": {
    category: "endpoint",
    transient: false,
    retryable: true,
    steps: () => [step("check_endpoint_hooks"), READ_DETAILS],
  },
  "endpoint.timeout": {
    category: "endpoint",
    transient: true,
    retryable: true,
    steps: () => [step("wait_endpoint_retry"), step("check_endpoint_agent")],
  },
  "endpoint.target_not_empty": {
    category: "endpoint",
    transient: false,
    retryable: true,
    steps: () => [step("choose_empty_restore_folder")],
  },
  "endpoint.invalid_task": {
    category: "endpoint",
    transient: false,
    retryable: true,
    steps: () => [READ_DETAILS],
  },
  "endpoint.hash_mismatch": {
    category: "endpoint",
    transient: false,
    retryable: true,
    steps: () => [step("run_backup_again", "jobs"), step("run_health_check", "verify")],
  },
  "endpoint.file_missing": {
    category: "endpoint",
    transient: false,
    retryable: true,
    steps: () => [step("run_backup_again", "jobs"), READ_DETAILS],
  },
  "endpoint.file_not_regular": {
    category: "endpoint",
    transient: false,
    retryable: false,
    steps: () => [READ_DETAILS],
  },
  "endpoint.read_error": {
    category: "endpoint",
    transient: false,
    retryable: true,
    steps: () => [step("check_endpoint_file_access"), step("check_endpoint_hooks")],
  },
  "endpoint.restic_failed": {
    category: "endpoint",
    transient: false,
    retryable: true,
    steps: () => [step("check_endpoint_agent"), READ_DETAILS],
  },
  "endpoint.repository_locked": {
    category: "endpoint",
    transient: true,
    retryable: true,
    steps: () => [step("wait_endpoint_retry")],
  },
  "endpoint.repository_missing": {
    category: "endpoint",
    transient: false,
    retryable: true,
    steps: () => [step("check_storage_health", "storage"), READ_DETAILS],
  },
  "endpoint.repository_damaged": {
    category: "endpoint",
    transient: false,
    retryable: true,
    steps: () => [step("check_storage_health", "storage"), step("run_backup_again"), READ_DETAILS],
  },
  "endpoint.repository_password": {
    category: "endpoint",
    transient: false,
    retryable: false,
    steps: () => [step("check_master_key"), READ_DETAILS],
  },
  "endpoint.repository_refused": {
    category: "endpoint",
    transient: false,
    retryable: false,
    steps: () => [READ_DETAILS],
  },
  "endpoint.network": {
    category: "endpoint",
    transient: true,
    retryable: true,
    steps: () => [step("check_endpoint_agent"), step("wait_endpoint_retry")],
  },
  "endpoint.agent_stopped": {
    category: "endpoint",
    transient: true,
    retryable: true,
    steps: () => [step("check_endpoint_agent"), step("wait_endpoint_retry")],
  },
  "endpoint.interrupted": {
    category: "endpoint",
    transient: true,
    retryable: false,
    steps: () => [step("wait_endpoint_retry")],
  },
  "endpoint.silent": {
    category: "endpoint",
    transient: false,
    retryable: false,
    steps: () => [step("check_endpoint_agent")],
  },
  "endpoint.backup_overdue": {
    category: "endpoint",
    transient: false,
    retryable: true,
    steps: () => [step("check_endpoint_agent"), step("check_endpoint_paths")],
  },

  // --- File shares (docs/FILESHARES.md section 11) -----------------------------------------
  "share.auth_failed": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("check_share_account", "file_share"), READ_DETAILS],
  },
  "share.unreachable": {
    category: "share",
    transient: true,
    retryable: true,
    steps: () => [step("check_share_server"), step("wait_automatic")],
  },
  "share.not_found": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("check_share_path", "file_share"), READ_DETAILS],
  },
  "share.version_mismatch": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("choose_share_version", "file_share")],
  },
  "share.permission_denied": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("grant_share_read")],
  },
  "share.client_missing": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("install_share_client")],
  },
  "share.mount_failed": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [READ_DETAILS],
  },
  "share.address_blocked": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("approve_private_network", "file_share")],
  },
  "share.wrong_filesystem": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [READ_DETAILS],
  },
  "share.empty_source": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("check_share_content"), step("back_up_empty_share_once", "file_share")],
  },
  "share.include_missing": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("check_share_path", "jobs")],
  },
  "share.locked_files": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("run_backup_again", "jobs")],
  },
  "share.read_errors": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("grant_share_read"), READ_DETAILS],
  },
  "share.files_dropped": {
    category: "share",
    transient: false,
    retryable: false,
    steps: () => [step("check_share_content")],
  },
  "share.acl_partial": {
    category: "share",
    transient: false,
    retryable: false,
    steps: () => [step("grant_share_read")],
  },
  "share.offline_skipped": {
    category: "share",
    transient: false,
    retryable: false,
    steps: () => [READ_DETAILS],
  },
  "share.restore_not_allowed": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("allow_share_restore", "file_share")],
  },
  "share.copy_no_verified_point": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("wait_share_restore_check", "verify")],
  },
  "share.copy_unsafe_target": {
    category: "share",
    transient: false,
    retryable: false,
    steps: () => [step("check_copy_target", "jobs")],
  },
  "share.copy_empty_source": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("check_share_content"), step("check_copy_target", "jobs")],
  },
  "share.restore_partial": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("grant_share_read"), READ_DETAILS],
  },
  "share.repository_locked": {
    category: "share",
    transient: true,
    retryable: true,
    steps: () => [step("wait_automatic")],
  },
  "share.repository_damaged": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("check_storage_health", "storage"), READ_DETAILS],
  },
  "share.quota_exceeded": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("raise_share_budget", "file_share")],
  },
  "share.out_of_memory": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("raise_runner_memory", "file_share_runners")],
  },
  "share.timeout": {
    category: "share",
    transient: false,
    retryable: true,
    steps: () => [step("raise_run_hours", "file_share_runners")],
  },
  "share.mounter_unavailable": {
    category: "share",
    transient: true,
    retryable: true,
    steps: () => [step("start_mounter", "file_share_runners"), step("wait_automatic")],
  },
  "share.runner_failed": {
    category: "share",
    transient: true,
    retryable: true,
    steps: () => [step("wait_automatic"), READ_DETAILS],
  },
  "share.runner_lost": {
    category: "share",
    transient: true,
    retryable: true,
    steps: () => [step("start_mounter", "file_share_runners"), step("wait_automatic")],
  },
  "share.runner_stalled": {
    category: "share",
    transient: true,
    retryable: true,
    steps: () => [step("check_share_server"), step("wait_automatic")],
  },

  // --- Platform ----------------------------------------------------------------------------
  "database.unavailable": {
    category: "system",
    transient: true,
    retryable: true,
    steps: () => [step("wait_automatic"), step("check_database")],
  },
  "database.error": {
    category: "system",
    transient: false,
    retryable: true,
    steps: () => [step("check_database"), READ_DETAILS],
  },
  "directory.conflict": {
    category: "system",
    transient: true,
    retryable: true,
    steps: () => [step("wait_automatic")],
  },
  // --- Mail export ---------------------------------------------------------------------------
  "export.quota_exceeded": {
    category: "storage",
    transient: false,
    retryable: true,
    steps: () => [
      step("wait_for_exports_to_expire"),
      step("export_less_mail"),
      step("raise_export_limit"),
    ],
  },
  "job.interrupted": {
    category: "system",
    transient: true,
    retryable: true,
    steps: () => [step("wait_automatic"), step("worker_resources")],
  },
  unknown: {
    category: "system",
    transient: false,
    retryable: true,
    steps: () => [READ_DETAILS],
  },
};

/** The catalog entry of a code, or null for a code this build does not know (a newer version wrote it). */
export function catalogEntry(code: string): FailureCatalogEntry | null {
  return (FAILURE_CATALOG as Readonly<Record<string, FailureCatalogEntry>>)[code] ?? null;
}

/** Every code has a catalog entry (guards the two lists against drifting apart). */
export function catalogCovers(): boolean {
  return FAILURE_CODES.every((code) => code in FAILURE_CATALOG);
}
