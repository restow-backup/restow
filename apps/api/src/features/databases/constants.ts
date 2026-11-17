/** Session API of the module "Databases", mounted under /api/v1 (see app.ts). */
export const mountPath = "/databases";

/** Problem types of the module (application/problem+json `type`). */
export const DATABASE_PROBLEMS = {
  invalid: "urn:restow:problem:database-invalid",
  address: "urn:restow:problem:database-address",
  executor: "urn:restow:problem:database-executor",
  hostNotAllowed: "urn:restow:problem:database-host-not-allowed",
  probeRequired: "urn:restow:problem:database-probe-required",
  tlsMissing: "urn:restow:problem:database-tls-missing",
  targetIsRestow: "urn:restow:problem:database-target-is-restow",
  nameTaken: "urn:restow:problem:database-name-taken",
  probeLimit: "urn:restow:problem:database-probe-limit",
  probeUsed: "urn:restow:problem:database-probe-used",
  probeBusy: "urn:restow:problem:database-probe-busy",
  ownDatabaseUnknown: "urn:restow:problem:database-own-database-unknown",
  credentialsRequired: "urn:restow:problem:database-credentials-required",
  confirm: "urn:restow:problem:database-confirm",
} as const;

/**
 * The audit trail (docs/DATABASES.md 10), under `database_connection` (`database.*` is the
 * installation's own database): creating a connection, changing its credentials,
 * approving a private network, confirming a new TLS certificate or a new instance, every change
 * and every deletion. Details never hold a credential.
 */
export const DATABASE_AUDIT_ACTIONS = {
  connectionCreated: "database_connection.created",
  connectionUpdated: "database_connection.updated",
  connectionDeleted: "database_connection.deleted",
  credentialsChanged: "database_connection.credentials_changed",
  privateNetworkApproved: "database_connection.private_network_approved",
  tlsConfirmed: "database_connection.tls_confirmed",
  instanceConfirmed: "database_connection.instance_confirmed",
  tested: "database_connection.tested",
} as const;

/** How long an agent has to answer a test (heartbeat every 5 minutes, with jitter). */
export const AGENT_PROBE_TTL_MS = 15 * 60 * 1000;
/** A test of the Restow server: one step 5 s, the whole test 30 s. */
export const SERVER_PROBE_TIMEOUT_SECONDS = 30;
/**
 * At most this many tests per tenant in {@link PROBE_WINDOW_MS} (no port scanner), counted from
 * the stored tests, so a restart or another replica of the api does not reset it.
 */
export const PROBE_LIMIT = 30;
export const PROBE_WINDOW_MS = 10 * 60 * 1000;
/** Tests of the Restow server running at once in one api process, per tenant and in all. */
export const SERVER_PROBES_PER_TENANT = 2;
export const SERVER_PROBES_TOTAL = 16;
/** The credentials a test of unsaved settings used are kept this long for saving them. */
export const PROBE_CREDENTIALS_KEEP_MS = 30 * 60 * 1000;
/** Finished tests are kept this long (saving a connection takes its facts from one). */
export const PROBE_KEEP_MS = 24 * 60 * 60 * 1000;
