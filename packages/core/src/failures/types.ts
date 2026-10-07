/**
 * The vocabulary of failure explanations.
 *
 * An operator who sees a failed job, a failed item, a broken source or a red
 * verification needs three answers: what happened, why, and what to do. The
 * worker classifies every error it stores into a {@link FailureCause}: a
 * stable machine code plus a few scalar parameters, so the UI (and mails,
 * webhooks, integrations) can explain it in the operator's language without
 * parsing English error text. The raw, redacted detail stays available for a
 * support case (`technical`).
 *
 * Adding a code means: add it to {@link FAILURE_CODES}, give it an entry in
 * the catalog (./catalog.ts) and texts in both languages
 * (packages/i18n/resources/{en,de}/failures.json); a test fails until all
 * three exist.
 */

/** Where a failure comes from; groups the catalog and picks the right hint. */
export type FailureCategory =
  | "microsoft"
  | "imap"
  | "network"
  | "storage"
  | "crypto"
  | "verify"
  | "config"
  | "endpoint"
  | "system";

export const FAILURE_CODES = [
  // Microsoft 365 (Entra token endpoint and Microsoft Graph)
  "graph.consent_missing",
  "graph.app_credentials_invalid",
  "graph.tenant_not_found",
  "graph.token_rejected",
  "graph.permission_missing",
  "graph.access_denied",
  "graph.mailbox_not_licensed",
  "graph.user_not_found",
  "graph.onedrive_unavailable",
  "graph.throttled",
  "graph.service_unavailable",
  "graph.item_not_found",
  "graph.item_too_large",
  "graph.item_unreadable",
  "graph.item_incomplete",
  "graph.delta_expired",
  "graph.quota_exceeded",
  "graph.request_rejected",
  // IMAP
  "imap.auth_failed",
  "imap.oauth_failed",
  "imap.credential_missing",
  "imap.starttls_unavailable",
  "imap.address_blocked",
  "imap.config_invalid",
  "imap.command_failed",
  "imap.mailbox_full",
  "imap.connection_lost",
  "imap.message_missing",
  // Network (any remote host: Microsoft, an IMAP server, ...)
  "network.dns",
  "network.unreachable",
  "network.timeout",
  "network.tls",
  // Storage targets
  "storage.path_missing",
  "storage.not_writable",
  "storage.full",
  "storage.access_denied",
  "storage.credentials_invalid",
  "storage.bucket_missing",
  "storage.wrong_region",
  "storage.unreachable",
  "storage.timeout",
  "storage.tls",
  "storage.rate_limited",
  "storage.integrity",
  "storage.error",
  // Encryption
  "crypto.key_missing",
  "crypto.key_invalid",
  // Verification and readiness
  "verify.hash_mismatch",
  "verify.chunk_missing",
  "verify.pack_unreadable",
  "verify.storage_corrupt",
  "verify.restore_test_failed",
  "verify.manifest_unreadable",
  "verify.no_snapshot",
  "verify.snapshot_outdated",
  "verify.snapshot_stale",
  "verify.nothing_to_verify",
  "verify.restore_test_unconfirmed",
  "verify.incomplete",
  // Configuration the operator has to fix first
  "config.source_not_connected",
  "config.source_disabled",
  "config.object_excluded",
  "config.object_orphaned",
  "config.app_not_configured",
  "config.invalid",
  // Servers and clients backed up by the agent (docs/AGENT.md)
  "endpoint.no_paths",
  "endpoint.pre_hook_failed",
  "endpoint.post_hook_failed",
  "endpoint.hooks_not_allowed",
  "endpoint.timeout",
  "endpoint.target_not_empty",
  "endpoint.invalid_task",
  "endpoint.hash_mismatch",
  "endpoint.file_missing",
  "endpoint.file_not_regular",
  "endpoint.read_error",
  "endpoint.restic_failed",
  "endpoint.repository_locked",
  "endpoint.repository_missing",
  "endpoint.repository_password",
  "endpoint.repository_refused",
  "endpoint.repository_damaged",
  "endpoint.network",
  "endpoint.agent_stopped",
  "endpoint.interrupted",
  "endpoint.silent",
  "endpoint.backup_overdue",
  // Mail export (docs/IMPORT.md)
  "export.quota_exceeded",
  // The platform itself
  "database.unavailable",
  "database.error",
  "directory.conflict",
  "job.interrupted",
  "unknown",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === "string" && (FAILURE_CODES as readonly string[]).includes(value);
}

/** Which subsystem a failing call belongs to, when the caller knows. */
export type FailureRole = "microsoft" | "imap" | "storage" | "database";

/**
 * Scalars an explanation text or a step may interpolate: the permission that
 * is missing, the host that is unreachable, the seconds Microsoft asked to
 * wait. Never secrets, never message bodies.
 */
export type FailureParams = Record<string, string | number | boolean | null>;

/**
 * What a support case needs (all redacted): HTTP status, Graph error code,
 * request and client-request id, server time, the endpoint (no query string),
 * the IMAP response text. Rendered as a plain key/value list.
 */
export type FailureTechnical = Record<string, string | number>;

/** A classified error. */
export interface FailureCause {
  code: FailureCode;
  /** Retrying by itself may help; the job is retried automatically while budget remains. */
  transient: boolean;
  params: FailureParams;
  technical: FailureTechnical;
}

/** Automatic retry state of a job whose run failed but is queued again. */
export interface FailureRetry {
  /** The attempt that just failed (1 = first run). */
  attempt: number;
  /** Attempts the queue allows in total. */
  limit: number;
  /** When the next attempt starts at the earliest-to-latest estimate; null when unknown. */
  nextAttemptAt: string | null;
}

/** What is stored next to `jobs.error_message` and `item_failures.reason` (jsonb). */
export interface FailureRecord extends FailureCause {
  /** Format version; readers ignore what they do not understand. */
  v: 1;
  /** ISO 8601 time the error happened. */
  occurredAt: string;
  /** The step the job was in (engine phase such as "download"), when known. */
  step: string | null;
  retry: FailureRetry | null;
}

export const FAILURE_RECORD_VERSION = 1;

/** Pages an operator can be sent to; the UI maps them to routes. */
export type FailureTarget =
  | "settings_microsoft"
  | "sources"
  | "source"
  | "directory"
  | "storage"
  | "verify"
  | "jobs";

/** One thing to do, with an optional place in the UI to do it. */
export interface FailureStep {
  /** Key under `failures:steps.<id>` in the translations. */
  id: FailureStepId;
  target: FailureTarget | null;
}

export const FAILURE_STEP_IDS = [
  "regrant_consent",
  "verify_permissions",
  "grant_permission",
  "check_app_credentials",
  "configure_app",
  "check_tenant_id",
  "check_server_clock",
  "assign_license",
  "exclude_object",
  "include_object",
  "assign_onedrive_license",
  "sync_directory",
  "check_access_policy",
  "wait_automatic",
  "wait_throttled",
  "check_service_health",
  "open_item_at_source",
  "contact_microsoft_support",
  "item_stays_failed",
  "free_target_space",
  "check_app_password",
  "enable_imap_access",
  "reauthorize_oauth",
  "set_object_password",
  "check_host_reachable",
  "check_dns",
  "check_tls_certificate",
  "check_imap_security",
  "approve_private_network",
  "check_server_limits",
  "check_source_settings",
  "enable_source",
  "reconnect_source",
  "check_storage_path",
  "free_storage_space",
  "check_storage_credentials",
  "check_storage_permissions",
  "check_bucket",
  "check_storage_endpoint",
  "check_storage_health",
  "check_master_key",
  "restore_key_backup",
  "run_backup_again",
  "run_health_check",
  "restore_from_copy",
  "check_test_target",
  "check_endpoint_paths",
  "check_endpoint_hooks",
  "allow_endpoint_hooks",
  "check_endpoint_agent",
  "check_endpoint_file_access",
  "choose_empty_restore_folder",
  "wait_endpoint_retry",
  "wait_for_exports_to_expire",
  "export_less_mail",
  "raise_export_limit",
  "check_database",
  "worker_resources",
  "read_technical_details",
] as const;

export type FailureStepId = (typeof FAILURE_STEP_IDS)[number];
