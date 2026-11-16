import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { type FailureRecordJson, timestamps } from "./_shared.js";
import { user } from "./auth.js";
import { recoveryReadinessEnum } from "./jobs.js";
import { secrets } from "./secrets.js";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * Endpoint backup: servers and clients backed up by the Restow agent with
 * restic (docs/AGENT.md). Every table here is tenant-scoped (RLS, sql/rls.sql).
 *
 * The agent writes to a restic repository that lives in the tenant's primary
 * storage target under `endpoints/<endpoint id>/`; the server initialises it,
 * keeps its password sealed in `secrets` (`endpoints.repository_secret_id`)
 * and is the only party that prunes and checks it.
 */

/** `server` = always-on machine (daily schedule); `client` = laptop/desktop (on connect). */
export const endpointProfileEnum = pgEnum("endpoint_profile", ["server", "client"]);

/**
 * The operating systems of the agent contract. Windows is part of the contract
 * (docs/AGENT.md) but is not offered in 0.1.0: enrollment refuses it.
 */
export const endpointOsEnum = pgEnum("endpoint_os", ["linux", "windows", "darwin"]);

export const endpointArchEnum = pgEnum("endpoint_arch", ["amd64", "arm64"]);

/** `revoked` endpoints are refused everywhere; their repository stays restorable. */
export const endpointStatusEnum = pgEnum("endpoint_status", ["active", "revoked"]);

/**
 * `sql`, `sql_restore`, `sql_verify` (W2a, docs/BAREMETAL-WINDOWS.md 5.1): the native SQL Server
 * backup of one instance, a restore of one database under a new name, and the check of a backup
 * restored from the repository with `DBCC CHECKDB`.
 */
export const endpointRunKindEnum = pgEnum("endpoint_run_kind", [
  "backup",
  "restore",
  "verify_sample",
  "sql",
  "sql_restore",
  "sql_verify",
]);

/** `partial` = a snapshot exists but some files could not be read. */
/** `cancelled` (0.4.2): stopped on request in the UI; neither a failure nor a backup. */
export const endpointRunStatusEnum = pgEnum("endpoint_run_status", [
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);

export const endpointTaskKindEnum = pgEnum("endpoint_task_kind", [
  "backup_now",
  "restore",
  "verify_sample",
  "update_config",
  "uninstall",
  // W2a (docs/BAREMETAL-WINDOWS.md 5.1): `sql_inventory` finishes on delivery, like `update_config`.
  "sql_restore",
  "sql_verify",
  "sql_inventory",
]);

/**
 * `pending` -> `delivered` (the agent got it in a heartbeat) -> `done` or `failed`; `cancelled`
 * (0.4.2) when an admin withdrew it.
 */
export const endpointTaskStatusEnum = pgEnum("endpoint_task_status", [
  "pending",
  "delivered",
  "done",
  "failed",
  "cancelled",
]);

/** What a server-side report records. */
export const endpointReportKindEnum = pgEnum("endpoint_report_kind", [
  "restore_test",
  "repository_check",
  "retention",
  // One database's backup restored from the repository and checked with DBCC CHECKDB (W2a).
  "sql_verify",
  // Bare metal stage 1 (docs/BAREMETAL.md 12.1): layout and boot chain of a whole machine snapshot.
  "baremetal_check",
  // Bare metal stage 2 (docs/BAREMETAL.md 12.3): the snapshot restored and booted in the lab.
  "boot_probe",
]);

export type EndpointProfile = (typeof endpointProfileEnum.enumValues)[number];
export type EndpointOs = (typeof endpointOsEnum.enumValues)[number];
export type EndpointArch = (typeof endpointArchEnum.enumValues)[number];
export type EndpointStatus = (typeof endpointStatusEnum.enumValues)[number];
export type EndpointRunKind = (typeof endpointRunKindEnum.enumValues)[number];
export type EndpointRunStatus = (typeof endpointRunStatusEnum.enumValues)[number];
export type EndpointTaskKind = (typeof endpointTaskKindEnum.enumValues)[number];
export type EndpointTaskStatus = (typeof endpointTaskStatusEnum.enumValues)[number];
export type EndpointReportKind = (typeof endpointReportKindEnum.enumValues)[number];

/** When the agent backs up (the `GET /agent/v1/config` contract). */
export type EndpointSchedule = {
  /**
   * `none` (release 0.2.1): the machine is in no backup job and backs up nothing until it is put
   * into one (the schedule enrollment writes, and the one a machine gets back when it leaves its
   * job).
   */
  kind: "interval" | "daily" | "on_connect" | "none";
  /** `interval`: minutes between backups; `on_connect`: the least minutes between two backups. */
  intervalMinutes?: number;
  /** `daily`: local time `HH:MM`. */
  timeOfDay?: string;
  /** IANA zone `timeOfDay` is read in. */
  timeZone: string;
};

/**
 * A time window of the week with its own upload limit (the rules are in @restow/core
 * backup-jobs/bandwidth.ts): the days it starts on (1 = Monday ... 7 = Sunday), local start and end
 * as `HH:MM` (the end may be on the next day), and the limit in kbit/s (0 = unlimited).
 */
export type EndpointBandwidthWindow = {
  days: number[];
  from: string;
  to: string;
  kbps: number;
};

/** What the agent is told to back up and how (the agent contract, docs/AGENT.md). */
export type EndpointConfig = {
  profile: EndpointProfile;
  schedule: EndpointSchedule;
  paths: string[];
  excludes: string[];
  hooks: { pre?: string; post?: string };
  bandwidthKbps: number | null;
  onlyOnAcPower: boolean;
  useVss: boolean;
  /**
   * Skip files larger than this many bytes (restic `--exclude-larger-than`). Written from a backup
   * job only; absent when no job sets it. An agent that does not know the field ignores it.
   */
  excludeLargerThanBytes?: number;
  /**
   * Windows with their own upload limit, read in the zone of `schedule`; written from a backup job
   * (or by hand on a machine without one) and absent when there are none. `bandwidthKbps` is the
   * limit outside every window. The agent never sees them: `GET /agent/v1/config` answers with the
   * limit that applies at that moment.
   */
  bandwidthWindows?: EndpointBandwidthWindow[];
  /**
   * The effective agent policy of the machine (installation, tenant and job resolved; @restow/core
   * endpoints/agent-policy.ts `EndpointPolicy`). Absent when every setting is the default, so the
   * configuration of an installation without policies stays as it was. The agent gets it in its
   * wire form (`GET /agent/v1/config`, field `policy`).
   */
  policy?: EndpointConfigPolicy;
  /**
   * Back up the whole machine (preview, docs/BAREMETAL.md 5); written from a whole machine job to
   * Linux machines that are no container, absent otherwise.
   */
  wholeMachine?: boolean;
  /**
   * File system snapshots on Linux (LVM, btrfs), set on the machine; absent means the default (on
   * for a whole machine backup, off otherwise).
   */
  fsSnapshot?: "auto" | "off";
  /**
   * The native SQL Server backup (W2a, docs/BAREMETAL-WINDOWS.md 5.1.3): Windows only, written from
   * a backup job and absent when no job sets it. The agent gets it without `verify`, which only the
   * server plans (@restow/core `agentFacingConfig`).
   */
  sql?: EndpointSqlConfig;
};

/** A database of the SQL settings: its name, and the instance when only that one's is meant. */
export type EndpointSqlDatabaseRef = { instance?: string; name: string };

/** When and how the server checks the newest backup of each database (W2a, 5.1.7). */
export type EndpointSqlVerifyConfig = {
  enabled: boolean;
  /** 1 = Monday ... 7 = Sunday, read in the zone of the schedule. */
  weekday: number;
  /** Local `HH:MM`. */
  time: string;
  /** Above this many GiB of used pages CHECKDB runs with PHYSICAL_ONLY. */
  maxGiB: number;
  /** Always PHYSICAL_ONLY. */
  physicalOnly: boolean;
};

export type EndpointSqlConfig = {
  enabled: boolean;
  /** W2a knows `alongside` only: copy-only fulls beside the customer's own backups. */
  mode: "alongside";
  instances: "all" | string[];
  databases: "all" | EndpointSqlDatabaseRef[];
  exclude: EndpointSqlDatabaseRef[];
  /** A staging folder of its own; absent: the agent's (`C:\ProgramData\Restow\data\staging\sql`). */
  stagingDir?: string;
  /** Server only; never sent to the agent. */
  verify?: EndpointSqlVerifyConfig;
};

/** The effective agent policy stored with a machine's configuration. */
export type EndpointConfigPolicy = {
  backupWindow: { days: number[]; from: string; to: string } | null;
  catchUp: { enabled: boolean; mode: "asap" | "next_window"; maxAgeHours: number | null };
  retries: number;
  bandwidthKbps: number | null;
  bandwidthLocked: boolean;
  onlyOnAcPower: boolean;
  onlyOnAcPowerLocked: boolean;
  /** Only `fail` is stored (0.5.0); absent means `continue`. */
  snapshotOnFailure?: "continue" | "fail";
};

/** Retention of one endpoint's repository (`restic forget --keep-*`). */
export type EndpointRetention = {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
};

/**
 * Settings only the server uses; never sent to the agent. Every field is
 * optional, a missing one takes its documented default (docs/AGENT.md).
 */
/**
 * Removing a machine from Restow (release 0.4.5, #65), on `endpoints.removal`. Only a revoked
 * machine is removed; from then on it is left out of every list, picker, dashboard and counter,
 * while its runs, reports and audit entries stay (the row is kept as a tombstone).
 *
 *   delete   its restic repository (`endpoints/<id>/` on every target of the tenant that holds
 *            files of it) is deleted as soon as nothing holds it, at the earliest seven days
 *            after the request (since 0.5.0; a provider owner asks, with a reason, and may
 *            cancel until the worker starts). Until it starts the machine stays listed as
 *            revoked (`removed_at` stays NULL); the worker sets `removed_at` when it starts.
 *   expire   its backups stay until the machine's retention would have let the newest of them
 *            go (`expiresAt`), then they are deleted the same way.
 *
 * The worker (`endpoint-removal`) deletes when `endpoints.removal_due_at` has come. A legal hold
 * over the whole tenant, or a suspicion hold on the machine, holds the deletion (`held`, tried
 * again daily); objects the storage still locks (S3 Object Lock, a directory's deletion delay)
 * defer it until they run out (`deferred`, `lockedUntil`). `done` once nothing of the repository
 * is left; the repository password, the stored samples and the snapshot marks go with it.
 */
export type EndpointRemovalMode = "delete" | "expire";
export type EndpointRemovalState = "scheduled" | "held" | "deferred" | "done";

export type EndpointRemoval = {
  mode: EndpointRemovalMode;
  state: EndpointRemovalState;
  /** Who asked (the account's e-mail) and when. */
  requestedBy: string;
  requestedAt: string;
  /** `expire`: when the machine's retention lets the newest backup go. */
  expiresAt?: string | null;
  /** `delete` (0.5.0): why, as the requester gave it (also in the audit entry). */
  reason?: string | null;
  /**
   * `delete` (0.5.0): when the worker started deleting. From then on the removal can no longer be
   * cancelled, and the machine is removed (`removed_at`).
   */
  startedAt?: string | null;
  /** Snapshots deleted so far, over every attempt and target (distinct snapshot ids). */
  deletedSnapshots?: number;
  /** `held`: what holds it. */
  heldBy?: "legal_hold" | "suspicion" | null;
  /** `deferred`: the latest retain-until of the objects the storage refused to delete. */
  lockedUntil?: string | null;
  /** `deferred`: how many objects the storage refused to delete. */
  lockedObjects?: number;
  /** Objects deleted so far, over every attempt. */
  deletedObjects?: number;
  /** The last attempt of the worker, and why it failed (if it did). */
  attemptedAt?: string | null;
  lastError?: string | null;
  /** `done`: when the last object was gone. */
  completedAt?: string | null;
};

export type EndpointSettings = {
  retention?: EndpointRetention;
  /**
   * The storage budget of this endpoint's repository in GiB; without it the
   * installation's default applies (`RESTOW_ENDPOINT_QUOTA_GIB`). The tenant's
   * budget for all its endpoints still caps it.
   */
  quotaGib?: number | null;
  /** Server profile: hours without contact before the alert (default 2). */
  staleAfterHours?: number;
  /** Client profile: days without a backup before the alert (default 7). */
  staleAfterDays?: number;
  /**
   * Days without contact after which the machine page and the attention list suggest revoking
   * the machine (default 30, release 0.4.5, #65).
   */
  revokeHintAfterDays?: number;
  /**
   * The tenant paused automatic agent updates (docs/AGENT.md, "Self-update"):
   * the tenant-wide switch is stored on each of its endpoints, and a new
   * endpoint takes it over from the tenant's others.
   */
  autoUpdatePaused?: boolean;
  /** What the agent reports about the machine; written by the server from enrollment and heartbeat only. */
  agent?: EndpointAgentFacts;
  /**
   * The SQL Server instances of the machine's last SQL inventory, without their databases (those
   * are rows of `endpoint_sql_databases`). Written only by a heartbeat that carries an inventory,
   * with a `jsonb_set` of its own, so a heartbeat without one never removes it (W2a).
   */
  sqlInstances?: EndpointSqlInventoryState;
  /**
   * The machine was enrolled with a client token but got the server profile, because its agent
   * reported a container or a virtual machine without a desktop (release 0.4.0, #59). Written once
   * at enrollment.
   */
  profileDetection?: {
    requested: "server" | "client";
    reason: "container" | "vm";
    /** What it runs in as the agent named it (`lxc`, `kvm`); empty when unknown. */
    technology: string;
  };
  /**
   * The machine was rebound (docs/BAREMETAL.md 11): its next good backup is the new baseline of
   * the ransomware signals (`endpoint_runs.activity_baseline`); cleared by that backup. Server
   * only, so it bumps no configuration version.
   */
  activityBaselinePending?: boolean;
};

/** The machine's local hook policy (set by root on the machine, never by the server). */
export type EndpointHookPolicy = "off" | "scripts" | "any";

/** Facts the agent reports in its enrollment and heartbeats. */
export type EndpointAgentFacts = {
  hooks?: EndpointHookPolicy;
  /** Script names in /etc/restow-agent/hooks.d (scripts policy), at most 50. */
  hookScripts?: string[];
  /** When the agent last reported these facts (ISO 8601). */
  reportedAt?: string;
  /** Container, virtual machine, desktop (agent 0.4.0 and later). */
  machine?: EndpointMachineFacts;
  /**
   * The folders of a fixed list where applications keep their data that exist on the machine with
   * files in them (@restow/core `DATA_FOLDER_CANDIDATES`; agent 0.4.0 and later, #59). Absent:
   * the agent does not report them.
   */
  dataFolders?: string[];
  /**
   * What the agent can do beyond the base contract, e.g. `sql_native_v1` (W2a): the server offers
   * SQL actions only to an agent that names it. Absent: an older agent, nothing beyond the base.
   */
  capabilities?: string[];
};

/** How the agent sees the machine it runs on. */
export type EndpointMachineFacts = {
  virtualization: "container" | "vm" | "none";
  /** `lxc`, `docker`, `kvm`, `vmware`, ...; empty when unknown. */
  technology: string;
  desktop: boolean;
  /** Windows only (agent 0.5.0, W1): version, roles, SQL Server instances, BitLocker. */
  windows?: EndpointWindowsFacts;
};

/** A SQL Server instance as the registry and the service configuration name it (W1). */
export type EndpointWindowsSqlInstance = {
  name: string;
  id: string;
  version: string;
  edition: string;
  serviceName: string;
  serviceAccount: string;
  clustered: boolean;
  strictEncryption: boolean;
};

/** What a Windows agent reports about its system (W1, docs/BAREMETAL-WINDOWS.md 6.1). */
export type EndpointWindowsFacts = {
  productName: string;
  editionId: string;
  productType: "workstation" | "server" | "domain_controller" | "unknown";
  installationType: string;
  build: number;
  ubr: number;
  displayVersion: string;
  domainMember: boolean;
  domain: string;
  roles: {
    domainController: boolean;
    dfsr: boolean;
    exchange: boolean;
    hyperV: boolean;
    sqlServer: boolean;
  };
  sqlInstances: EndpointWindowsSqlInstance[];
  bitlocker: {
    /** `unavailable`: the feature is not installed; `error`: it could not be read. */
    state: "ok" | "unavailable" | "error";
    volumes: { mount: string; protection: "on" | "off" | "unknown"; conversion: string }[];
  };
};

/** A problem the agent met with one SQL Server instance or database (W2a). */
export type EndpointSqlProblem = { code: string; step?: string; number?: number; message?: string };

/** One instance of the SQL inventory, without its databases. */
export type EndpointSqlInstanceState = {
  name: string;
  state: "ok" | "error";
  version?: string;
  edition?: string;
  engineEdition?: number;
  clustered?: boolean;
  hadr?: boolean;
  backupCompressionDefault?: boolean;
  login?: { name: string; sysadmin: boolean; canCreateDatabase: boolean };
  error?: EndpointSqlProblem;
};

export type EndpointSqlInventoryState = {
  collectedAt: string;
  truncated: boolean;
  instances: EndpointSqlInstanceState[];
};

/** A machine with an agent enrolled. */
export const endpoints = pgTable(
  "endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    displayName: text("display_name"),
    os: endpointOsEnum("os").notNull(),
    arch: endpointArchEnum("arch").notNull(),
    profile: endpointProfileEnum("profile").notNull(),
    agentVersion: text("agent_version"),
    osVersion: text("os_version"),
    status: endpointStatusEnum("status").notNull().default("active"),
    // SHA-256 (hex) of the agent secret; the secret itself is shown to the agent once.
    secretHash: text("secret_hash").notNull(),
    // The restic repository password, sealed with the tenant key.
    repositorySecretId: uuid("repository_secret_id").references(() => secrets.id, {
      onDelete: "set null",
    }),
    config: jsonb("config").$type<EndpointConfig>().notNull(),
    // Bumped by every change of `config`; the agent reports the one it runs.
    configVersion: integer("config_version").notNull().default(1),
    settings: jsonb("settings").$type<EndpointSettings>().notNull().default({}),
    // What the agent reported in its last heartbeat.
    agentState: text("agent_state").$type<"idle" | "running">(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    // What a due backup waits for, as the agent's last heartbeat said (agent 0.4.0): a code such
    // as `backup_window`, `update_pause`, `ac_power`; '' when nothing waits; null when unknown (an
    // older agent does not say). A plain column, not part of `settings`: it may change with any
    // heartbeat, which writes the row anyway.
    agentWaiting: text("agent_waiting"),
    agentConfigVersion: integer("agent_config_version"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    // The last finished backup run, whatever its outcome; `last_success_at` only a good one.
    lastBackupAt: timestamp("last_backup_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    // The restic snapshot of the newest good backup.
    lastSnapshotId: text("last_snapshot_id"),
    lastRetentionAt: timestamp("last_retention_at", { withTimezone: true }),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    lastRestoreTestAt: timestamp("last_restore_test_at", { withTimezone: true }),
    // Set when the "endpoint is silent" alert went out; cleared by the next contact.
    staleAlertedAt: timestamp("stale_alerted_at", { withTimezone: true }),
    // Bytes the repository takes in storage: measured by listing it (retention, first upload
    // after a restart), kept current by every upload in between. Null until first measured.
    repositoryBytes: bigint("repository_bytes", { mode: "number" }),
    repositoryMeasuredAt: timestamp("repository_measured_at", { withTimezone: true }),
    // The last upload refused because the storage budget was used up.
    quotaRefusedAt: timestamp("quota_refused_at", { withTimezone: true }),
    // The storage-budget alert that went out (`near` or `exceeded`) and when; cleared below 80 %.
    quotaAlertLevel: text("quota_alert_level").$type<"near" | "exceeded">(),
    quotaAlertedAt: timestamp("quota_alerted_at", { withTimezone: true }),
    // Retention and check runs in a row that found the repository locked, since when, and
    // when the alert about it went out; reset by the next run that got the lock.
    maintenanceLockedCount: integer("maintenance_locked_count").notNull().default(0),
    maintenanceLockedSince: timestamp("maintenance_locked_since", { withTimezone: true }),
    lockedAlertedAt: timestamp("locked_alerted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // The person of the tenant's protection directory (`users`, not a login account) the machine
    // is assigned to (release 0.2.1). Cleared when that person leaves the directory. The migration
    // adds a second key over (tenant_id, assigned_user_id), so the person is always one of the
    // machine's own tenant (drizzle/0025_endpoint_assigned_user.sql).
    assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
    // "Update now" (0.4.2): the heartbeat tells the agent to look for its update at once (it
    // installs it when idle); cleared once the agent reports the offered version.
    updateRequestedAt: timestamp("update_requested_at", { withTimezone: true }),
    // Removed from Restow (release 0.4.5, #65; EndpointRemoval): left out of every list from
    // then on. Null while the machine is listed (active or revoked).
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removal: jsonb("removal").$type<EndpointRemoval>(),
    // When the worker next deletes the machine's backups; null when nothing is left to do.
    removalDueAt: timestamp("removal_due_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index("endpoints_tenant_profile_idx").on(t.tenantId, t.profile, t.status),
    index("endpoints_status_seen_idx").on(t.status, t.lastSeenAt),
    index("endpoints_assigned_user_idx").on(t.assignedUserId),
    index("endpoints_removal_due_idx").on(t.removalDueAt).where(sql`${t.removalDueAt} IS NOT NULL`),
  ],
);

/**
 * A one-time enrollment token. Only its SHA-256 is stored; it is valid for
 * 24 hours, bound to a tenant and a profile, and single use.
 */
export const endpointEnrollmentTokens = pgTable(
  "endpoint_enrollment_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    profile: endpointProfileEnum("profile").notNull(),
    // A label the admin gave in the wizard; becomes the endpoint's display name.
    displayName: text("display_name"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedByEndpointId: uuid("used_by_endpoint_id").references(() => endpoints.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // A rebind token (0.5.0, docs/BAREMETAL.md 11): the existing machine it gives a new agent
    // secret; null for an enrollment token, which creates a new machine.
    endpointId: uuid("endpoint_id").references(() => endpoints.id, {
      onDelete: "cascade",
    }),
    // What a rebind token is for: `baremetal` (after a restore), `reinstall`, `mac_setup` (M6).
    purpose: text("purpose").$type<"baremetal" | "reinstall" | "mac_setup">(),
    // A rebind token that may bring a revoked machine back (chosen when it was issued).
    unrevoke: boolean("unrevoke").notNull().default(false),
  },
  (t) => [
    uniqueIndex("endpoint_enrollment_tokens_hash_uq").on(t.tokenHash),
    index("endpoint_enrollment_tokens_tenant_idx").on(t.tenantId, t.createdAt),
    check(
      "endpoint_enrollment_tokens_purpose_ck",
      sql`${t.purpose} IS NULL OR ${t.purpose} IN ('baremetal', 'reinstall', 'mac_setup')`,
    ),
    // A rebind token gives lasting access like an installed agent: valid for at most a day.
    check(
      "endpoint_enrollment_tokens_rebind_24h",
      sql`${t.endpointId} IS NULL OR ${t.expiresAt} <= ${t.createdAt} + interval '24 hours'`,
    ),
  ],
);

/** One partial or full error the agent reported for a run. */
export type EndpointRunError = { path?: string; message: string; code?: string };

export type EndpointRunStats = {
  filesNew?: number;
  filesChanged?: number;
  filesUnmodified?: number;
  dataAdded?: number;
  /** What restic stored for the new data, compressed (agent 0.4.x and newer). */
  dataAddedPacked?: number;
  totalFilesProcessed?: number;
  totalBytesProcessed?: number;
  /** What the backup changed (agent 0.4.0 and newer): @restow/core `ActivityReport`. */
  activity?: Record<string, unknown>;
  /**
   * Whether a file system snapshot was used (agent 0.5.0 and newer): @restow/core
   * `RunConsistency`. Kept for a failed run too, when the snapshot is why it failed.
   */
  consistency?: { method?: string; state: string; liveFilesystems?: string[] };
  /** A `sql`, `sql_restore` or `sql_verify` run (W2a): its instance and what became of each database. */
  sql?: EndpointRunSqlStats;
  /** Fixed warnings of the run (W1, W2a): `app_files_not_app_backup`, `sql_log_growing`, ... */
  notices?: EndpointRunNotice[];
  /**
   * A restore that read the repository from another target than the primary (a copy target's
   * repository copy, docs/STORAGE.md "Restoring from a copy"): which one.
   */
  readFrom?: { targetId: string; targetName: string | null; role: string };
};

export type EndpointRunNotice = { code: string; subjects?: string[]; message?: string };

/** One database of a SQL run, as the run sheet shows it. */
export type EndpointRunSqlDatabase = {
  name: string;
  /**
   * `sql`: `backed_up`, `skipped`, `failed`; `sql_verify`: `green`, `red`, `incomplete`;
   * `sql_restore`: `restored`, `failed`.
   */
  outcome: string;
  code?: string;
  message?: string;
  bytes?: number;
  durationMs?: number;
};

export type EndpointRunSqlStats = {
  instance: string;
  databases?: EndpointRunSqlDatabase[];
  /** `sql_restore`: the name the copy got and whether CHECKDB ran on it. */
  newName?: string;
  checkdb?: "clean" | "errors" | "skipped";
};

export type EndpointRunProgress = {
  filesDone: number;
  bytesDone: number;
  totalFiles?: number;
  totalBytes?: number;
  currentPath?: string;
  updatedAt: string;
};

/** A backup, restore or restore-test run the agent reported. */
export const endpointRuns = pgTable(
  "endpoint_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    kind: endpointRunKindEnum("kind").notNull(),
    status: endpointRunStatusEnum("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // The restic snapshot this run made or read.
    snapshotId: text("snapshot_id"),
    stats: jsonb("stats").$type<EndpointRunStats>(),
    errors: jsonb("errors").$type<EndpointRunError[]>().notNull().default([]),
    logTail: text("log_tail"),
    // The structured explanation of what went wrong (packages/core/src/failures), for the web app.
    failure: jsonb("failure").$type<FailureRecordJson>(),
    progress: jsonb("progress").$type<EndpointRunProgress>(),
    taskId: uuid("task_id"),
    // Set when the failure went out as an alert.
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    // Stop requested in the UI (0.4.2): the agent stops restic with its next heartbeat; the
    // label of who asked.
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    // The layout manifest a whole machine backup recorded (0.5.0, docs/BAREMETAL.md 4.3).
    layoutId: uuid("layout_id").references(() => endpointLayouts.id, { onDelete: "set null" }),
    // The first good backup after a rebind (0.5.0, docs/BAREMETAL.md 11): the new baseline of the
    // ransomware signals, nothing before it is compared with what comes after (docs/RANSOMWARE.md).
    activityBaseline: boolean("activity_baseline").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("endpoint_runs_endpoint_started_idx").on(t.endpointId, t.startedAt),
    // The layouts still referenced by a run (the monitor keeps them, apps/worker monitor.ts).
    index("endpoint_runs_layout_idx").on(t.layoutId).where(sql`${t.layoutId} IS NOT NULL`),
    // The runs an agent is told to stop with its heartbeat.
    index("endpoint_runs_cancelling_idx")
      .on(t.endpointId)
      .where(sql`${t.status} = 'running' AND ${t.cancelRequestedAt} IS NOT NULL`),
    index("endpoint_runs_tenant_status_idx").on(t.tenantId, t.status),
    // History lists a tenant's runs newest first (apps/api features/history).
    index("endpoint_runs_tenant_created_idx").on(t.tenantId, t.createdAt, t.id),
    // The ransomware judgement (apps/worker suspicion/scan.ts) reads new restore points by time;
    // the predicate is the scan's, word for word.
    index("endpoint_runs_suspicion_idx")
      .on(t.finishedAt, t.id)
      .where(
        sql`${t.kind} = 'backup' AND ${t.status} IN ('succeeded', 'partial') AND ${t.snapshotId} IS NOT NULL AND ${t.finishedAt} IS NOT NULL`,
      ),
  ],
);

/**
 * The layout manifest of a whole machine backup (preview, docs/BAREMETAL.md 4.3, 14.2), stored
 * once per machine and content: the SHA-256 of its canonical encoding (@restow/core
 * `canonicalLayoutJson`) is the same in the snapshot (`layout.json`) and here, and the runs that
 * recorded it point at it (`endpoint_runs.layout_id`). `summary` is what the machine's page shows
 * (@restow/core `LayoutSummary`); the full manifest carries serial numbers and is read by admins
 * only. A layout no run points at and that is not the machine's newest is removed by the monitor.
 */
export const endpointLayouts = pgTable(
  "endpoint_layouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    sha256: text("sha256").notNull(),
    format: text("format").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    platform: text("platform").notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
    verdict: text("verdict").notNull(),
    layoutFingerprint: text("layout_fingerprint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("endpoint_layouts_endpoint_sha_uq").on(t.endpointId, t.sha256),
    index("endpoint_layouts_endpoint_created_idx").on(t.endpointId, t.createdAt),
    check("endpoint_layouts_platform_ck", sql`${t.platform} IN ('linux', 'darwin')`),
  ],
);

/**
 * A bare metal recovery (docs/BAREMETAL.md 9.9): a code was issued, exchanged by the ISO for a
 * session, released by an admin, read the backups, ended.
 *
 *   issued -> pending_approval | active (exchange) | revoked | expired
 *   pending_approval -> active (release) | cancelled (rejected) | failed (not released in time)
 *   active -> finishing (the ISO gave up its repository access) | succeeded | failed | cancelled
 *   finishing -> succeeded | failed | cancelled
 */
export const endpointRecoveryStatusEnum = pgEnum("endpoint_recovery_status", [
  "issued",
  "pending_approval",
  "active",
  "finishing",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "revoked",
]);

/**
 * `code`: a recovery code for the ISO (M3). `probe`: a boot probe of the lab (M5, docs/BAREMETAL.md
 * 12.3), which runs the same code exchange and session without an operator. macOS migrations come
 * later.
 */
export const endpointRecoveryKindEnum = pgEnum("endpoint_recovery_kind", ["code", "probe"]);

export type EndpointRecoveryStatus = (typeof endpointRecoveryStatusEnum.enumValues)[number];
export type EndpointRecoveryKind = (typeof endpointRecoveryKindEnum.enumValues)[number];

/** The hardware the ISO found (docs/BAREMETAL.md 9.3), as it reported it. */
export type EndpointRecoveryHardware = {
  firmware: "uefi" | "bios";
  secureBoot: boolean | null;
  ramBytes: number;
  disks: {
    sizeBytes: number;
    logicalSectorSize: number;
    model: string;
    serial: string;
    wwn: string;
    transport: string;
  }[];
  nics: { mac: string; driver: string; link: boolean }[];
};

/** The last progress the ISO reported (docs/BAREMETAL.md 9.8). */
export type EndpointRecoveryProgress = {
  phase: string;
  step: number;
  stepsTotal: number;
  bytesDone: number;
  totalBytes: number;
  filesDone: number;
  totalFiles: number;
  message: string;
  updatedAt: string;
};

/**
 * One recovery code and the session it became (docs/BAREMETAL.md 9, 14.2). The code itself is never
 * stored: `code_hash` is SHA-256 of the proof the ISO sends, bound to `instance_origin`; the session
 * secret only as its hash. A session lasts until `expires_at` of its code, at most 48 hours after
 * it was issued (CHECK). Everything the ISO reports (hardware, progress, verification, warnings)
 * is shown as reported by the ISO.
 */
export const endpointRecoveries = pgTable(
  "endpoint_recoveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    kind: endpointRecoveryKindEnum("kind").notNull(),
    status: endpointRecoveryStatusEnum("status").notNull().default("issued"),
    // SHA-256 of the code proof (kind `code`).
    codeHash: text("code_hash"),
    // The canonical origin the code was issued for, and the SHA-256 of its TLS public key.
    instanceOrigin: text("instance_origin"),
    spkiSha256: text("spki_sha256"),
    requireApproval: boolean("require_approval").notNull().default(true),
    snapshotId: text("snapshot_id"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by").references(() => user.id, { onDelete: "set null" }),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedIp: text("used_ip"),
    sessionSecretHash: text("session_secret_hash"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by").references(() => user.id, { onDelete: "set null" }),
    credentialsIssuedAt: timestamp("credentials_issued_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    recoveryVersion: text("recovery_version"),
    hardware: jsonb("hardware").$type<EndpointRecoveryHardware>(),
    sshKeys: jsonb("ssh_keys").$type<string[]>(),
    sshHostKeys: jsonb("ssh_host_keys").$type<{ type: string; fingerprint: string }[]>(),
    progress: jsonb("progress").$type<EndpointRecoveryProgress>(),
    verification: jsonb("verification").$type<Record<string, unknown>>(),
    warnings: jsonb("warnings").$type<{ code: string; message: string }[]>(),
    logBytes: integer("log_bytes").notNull().default(0),
    /**
     * The stored log ends inside a key block (a BEGIN line without its END yet): the next batch
     * goes on masking until the END line (docs/BAREMETAL.md 9.8).
     */
    logInKeyBlock: boolean("log_in_key_block").notNull().default(false),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("endpoint_recoveries_code_uq").on(t.codeHash).where(sql`${t.codeHash} IS NOT NULL`),
    index("endpoint_recoveries_endpoint_idx").on(t.endpointId, t.issuedAt),
    // The sessions that hold the repository open (retention and removal wait for them).
    index("endpoint_recoveries_active_idx")
      .on(t.endpointId)
      .where(sql`${t.status} IN ('active', 'finishing')`),
    check(
      "endpoint_recoveries_max_48h",
      sql`${t.expiresAt} <= ${t.issuedAt} + interval '48 hours'`,
    ),
  ],
);

/** Lines the ISO sent for a recovery session, redacted and without control characters (9.8). */
export const endpointRecoveryLog = pgTable(
  "endpoint_recovery_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    recoveryId: uuid("recovery_id")
      .notNull()
      .references(() => endpointRecoveries.id, { onDelete: "cascade" }),
    // The lines of one call, joined with newlines.
    lines: text("lines").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Read in pages in the order they came (the cursor is the time and the id).
  (t) => [index("endpoint_recovery_log_recovery_idx").on(t.recoveryId, t.createdAt, t.id)],
);

/** Params of a restore task: into a new folder on the endpoint, never over files. */
export type EndpointRestoreParams = { snapshotId: string; paths: string[]; targetDir?: string };

/** Params of a restore-test task: files and the hashes they must have. */
export type EndpointVerifySampleParams = {
  snapshotId: string;
  files: { path: string; sha256: string }[];
};

/** A file of a SQL Server backup as `RESTORE FILELISTONLY` names it (W2a). */
export type EndpointSqlBackupFile = {
  logicalName: string;
  /** `D` data, `L` log, `F` FILESTREAM or full text, `S` memory-optimized. */
  type: string;
  fileGroup: string;
  fileId: number;
  sizeBytes: number;
  physicalName: string;
};

/** The backup a `sql_verify` or `sql_restore` task fetches from the repository. */
export type EndpointSqlBackupRef = {
  backupId: string;
  snapshotId: string;
  pathInSnapshot: string;
  sha256: string;
  bytes: number;
  fileList: EndpointSqlBackupFile[];
};

/** Params of a `sql_verify` task: the newest full of each database of one instance (W2a, 5.1.7). */
export type EndpointSqlVerifyParams = {
  instance: string;
  maxGiB: number;
  physicalOnly: boolean;
  databases: (EndpointSqlBackupRef & { databaseId: string; name: string; usedBytes: number })[];
};

/** Params of a `sql_restore` task: one backup restored under a new name (W2a, 5.1.4). */
export type EndpointSqlRestoreParams = EndpointSqlBackupRef & {
  instance: string;
  targetInstance: string;
  database: string;
  newName: string;
  checkdb: boolean;
  maxGiB: number;
};

/** A job for the agent, delivered with its next heartbeat. */
export const endpointTasks = pgTable(
  "endpoint_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    kind: endpointTaskKindEnum("kind").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    status: endpointTaskStatusEnum("status").notNull().default("pending"),
    // better-auth user id of the admin; null for tasks the server created itself.
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // A task nobody picked up by then is failed (a laptop that stayed off).
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Why a task failed or expired; never a secret.
    errorMessage: text("error_message"),
    // A cancel request for a task the agent already has (0.4.2); the label of who asked.
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
  },
  (t) => [
    index("endpoint_tasks_endpoint_status_idx").on(t.endpointId, t.status),
    index("endpoint_tasks_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

/** A file the agent hashed after a backup: the reference for a restore test. */
export const endpointSamples = pgTable(
  "endpoint_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => endpointRuns.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id").notNull(),
    path: text("path").notNull(),
    sha256: text("sha256").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("endpoint_samples_run_path_uq").on(t.runId, t.path),
    index("endpoint_samples_endpoint_snapshot_idx").on(t.endpointId, t.snapshotId),
  ],
);

/** Where a restore-test report came from: the server reading the repository, or the agent. */
export type EndpointReportOrigin = "server" | "agent";

export type EndpointReportSummary = {
  // restore_test
  files?: number;
  matched?: number;
  mismatched?: { path: string; expected: string; actual: string | null; reason?: string }[];
  // repository_check
  subsetPercent?: number;
  // retention
  removedSnapshots?: number;
  keptSnapshots?: number;
  repositoryBytes?: number;
  /** Snapshots retention left alone because the server has no run that reported them. */
  unrecordedSnapshots?: number;
  /** Snapshots whose recorded time lies in the future or after their file was stored. */
  futureSnapshots?: number;
  /** Agent lock files removed before the run (no backup of the agent was running). */
  removedLocks?: number;
  /** How the prune of this run went: restic's normal prune, or one that only deleted (docs/STORAGE.md). */
  pruneMode?: "full" | "delete_only";
  /** Why it only deleted: too little free space for the repack, or the normal prune ran out of it. */
  pruneReason?: "low_space" | "storage_full";
  /** A prune is still due (repacking deferred, or a prune that failed): the next run prunes. */
  prunePending?: boolean;
  /** Retention could not free space: the storage target is full (docs/STORAGE.md, "A full target"). */
  targetFull?: boolean;
  /** SQL backups whose snapshot retention forgot (W2a). */
  prunedSqlBackups?: number;
  // sql_verify (W2a): one report per database; `outcome` is the server's judgement.
  databaseId?: string;
  backupId?: string;
  outcome?: "green" | "red" | "incomplete";
  instance?: string;
  database?: string;
  method?: string;
  code?: string;
  physicalOnly?: boolean;
  backupLsn?: string;
  durationMs?: number;
  evidence?: { source: "checkdb" | "restore" | "sha256"; number?: number; message: string }[];
  // any failed step
  errorMessage?: string;
  [key: string]: unknown;
};

/**
 * What the server found out about an endpoint's repository: the outcome of a
 * restore test (which rates a snapshot like `verify_reports` rates a mailbox
 * backup), a repository check and a retention run. `readiness` is null for a
 * retention run, which only reports.
 */
export const endpointReports = pgTable(
  "endpoint_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    kind: endpointReportKindEnum("kind").notNull(),
    origin: text("origin").$type<EndpointReportOrigin>().notNull().default("server"),
    // The restic snapshot a restore test read back; null for checks and retention.
    snapshotId: text("snapshot_id"),
    readiness: recoveryReadinessEnum("readiness"),
    summary: jsonb("summary").$type<EndpointReportSummary>().notNull().default({}),
    runId: uuid("run_id"),
    // Set when a red report went out as an alert.
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index("endpoint_reports_endpoint_checked_idx").on(t.endpointId, t.checkedAt),
    index("endpoint_reports_tenant_kind_idx").on(t.tenantId, t.kind),
    // Which restore tests of a machine a report rated (History groups the ones that were not).
    index("endpoint_reports_run_idx").on(t.runId),
  ],
);

/**
 * A lock file the agent wrote into its repository (`locks/<name>`). The agent
 * may delete only the locks recorded here, so it can release its own locks but
 * never the server's (docs/AGENT.md, "Sperren"); the server removes the ones
 * left over before its own maintenance when no run of the agent is active.
 */
export const endpointRepositoryLocks = pgTable(
  "endpoint_repository_locks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    // The object name (SHA-256 hex of the lock file's content).
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("endpoint_repository_locks_endpoint_name_uq").on(t.endpointId, t.name)],
);

/**
 * Why a snapshot in an endpoint's repository is suspicious: the server has no
 * run that reported it (`unrecorded`), or its time, which the agent chooses,
 * lies in the future or after the moment its file was stored (`future_time`).
 */
export type EndpointSnapshotFlagReason = "unrecorded" | "future_time";

/**
 * A snapshot the retention run found suspicious (docs/AGENT.md,
 * "Aufbewahrung"). Retention never lets such a snapshot's own time decide
 * anything and never deletes an unrecorded one; the row remembers that the
 * admin was told, so each snapshot is announced once.
 */
export const endpointSnapshotFlags = pgTable(
  "endpoint_snapshot_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id").notNull(),
    reasons: jsonb("reasons").$type<EndpointSnapshotFlagReason[]>().notNull(),
    // The time restic records in the snapshot (chosen by the agent) and when its file was stored.
    snapshotTime: timestamp("snapshot_time", { withTimezone: true }),
    storedAt: timestamp("stored_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set when the alert about this snapshot went out.
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("endpoint_snapshot_flags_endpoint_snapshot_uq").on(t.endpointId, t.snapshotId),
    index("endpoint_snapshot_flags_tenant_idx").on(t.tenantId, t.createdAt),
  ],
);

/** One file or folder of a prepared ZIP download, as resolved in the snapshot. */
export type EndpointDownloadItem = { path: string; type: "file" | "dir" };

/**
 * A ZIP download of snapshot files, prepared by `POST .../downloads` and
 * streamed once by `GET .../downloads/:id` (docs/AGENT.md, "Restore"). The
 * selection is checked against the snapshot when it is prepared and kept here,
 * so the request carries no paths in a URL; the row is bound to the admin who
 * asked, expires after a few minutes and can be started exactly once. Expired
 * rows are removed by the endpoint monitor.
 */
export const endpointDownloads = pgTable(
  "endpoint_downloads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id").notNull(),
    selection: jsonb("selection").$type<EndpointDownloadItem[]>().notNull(),
    // better-auth user id of the admin who prepared it; only that admin can fetch it.
    createdBy: text("created_by").references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Set by the request that started the download; a second one finds it gone.
    startedAt: timestamp("started_at", { withTimezone: true }),
  },
  (t) => [
    index("endpoint_downloads_endpoint_idx").on(t.endpointId),
    index("endpoint_downloads_expires_idx").on(t.expiresAt),
  ],
);

export type Endpoint = typeof endpoints.$inferSelect;
export type NewEndpoint = typeof endpoints.$inferInsert;
export type EndpointEnrollmentToken = typeof endpointEnrollmentTokens.$inferSelect;
export type NewEndpointEnrollmentToken = typeof endpointEnrollmentTokens.$inferInsert;
export type EndpointRun = typeof endpointRuns.$inferSelect;
export type NewEndpointRun = typeof endpointRuns.$inferInsert;
export type EndpointTask = typeof endpointTasks.$inferSelect;
export type NewEndpointTask = typeof endpointTasks.$inferInsert;
export type EndpointSample = typeof endpointSamples.$inferSelect;
export type NewEndpointSample = typeof endpointSamples.$inferInsert;
export type EndpointReport = typeof endpointReports.$inferSelect;
export type NewEndpointReport = typeof endpointReports.$inferInsert;
export type EndpointLayout = typeof endpointLayouts.$inferSelect;
export type NewEndpointLayout = typeof endpointLayouts.$inferInsert;
export type EndpointRepositoryLock = typeof endpointRepositoryLocks.$inferSelect;
export type NewEndpointRepositoryLock = typeof endpointRepositoryLocks.$inferInsert;
export type EndpointSnapshotFlag = typeof endpointSnapshotFlags.$inferSelect;
export type NewEndpointSnapshotFlag = typeof endpointSnapshotFlags.$inferInsert;
export type EndpointRecovery = typeof endpointRecoveries.$inferSelect;
export type NewEndpointRecovery = typeof endpointRecoveries.$inferInsert;
export type EndpointRecoveryLogEntry = typeof endpointRecoveryLog.$inferSelect;
export type EndpointDownload = typeof endpointDownloads.$inferSelect;
export type NewEndpointDownload = typeof endpointDownloads.$inferInsert;
