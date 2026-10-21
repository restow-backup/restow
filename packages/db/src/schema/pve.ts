import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { type FailureRecordJson, timestamps } from "./_shared.js";
import { user } from "./auth.js";
import { secrets } from "./secrets.js";
import { tenants } from "./tenants.js";

/**
 * Virtual machines and containers of Proxmox VE (docs/PVE.md, design in
 * docs/PROXMOX.md section 2.10). A cluster belongs to exactly one tenant
 * (phase 1); each node runs restow-pve, which enrolls with a one-time token
 * and then talks to /agent/pve/v1 with its own secret. Every table is
 * tenant-scoped (RLS, sql/rls.sql).
 *
 * VM disks are stored as block maps in the tenant's chunk store (synthetic
 * fulls, one sealed manifest per restore point); containers in one restic
 * repository per guest under `pve-guests/<guest id>/` of the primary target.
 */

export type PveGuestKind = "vm" | "ct";
export type PveTaskStatus = "pending" | "delivered" | "done" | "failed";
export type PveRunKind = "backup" | "restore" | "restore_test" | "verify" | "boot_test";
export type PveTaskKind = "backup" | "restore" | "refresh_inventory" | "boot_test";
export type PveRunStatus = "running" | "succeeded" | "failed";
export type PveSnapshotStatus = "active" | "pruned" | "unavailable";
export type PveBackupMode = "snapshot" | "suspend" | "stop";

/** A one-time enrollment token of a node: 24 hours, single use, bound to a tenant. */
export const pveEnrollmentTokens = pgTable(
  "pve_enrollment_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedByNodeId: uuid("used_by_node_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Optional: an existing PVE API token the admin entered for this enrollment
    // (sealed JSON {id, secret} in the secret store). The node fetches it once
    // before it enrolls; it is deleted when the node enrolls, and by the worker
    // once the enrollment token is used, revoked or expired (docs/PVE.md).
    pveTokenSecretId: uuid("pve_token_secret_id").references(() => secrets.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pve_enrollment_tokens_hash_uq").on(t.tokenHash),
    index("pve_enrollment_tokens_tenant_idx").on(t.tenantId, t.createdAt),
  ],
);

/**
 * A PVE cluster (or a single node without a cluster). `fingerprint` is the
 * SHA-256 of the cluster CA certificate, which every node of the cluster
 * shares: it is unique across the installation, so a cluster can never be
 * enrolled into two tenants. `storageId` is the PVE storage id of the Restow
 * storage on this cluster.
 */
export const pveClusters = pgTable(
  "pve_clusters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    fingerprint: text("fingerprint").notNull(),
    storageId: text("storage_id").notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("pve_clusters_fingerprint_uq").on(t.fingerprint),
    index("pve_clusters_tenant_idx").on(t.tenantId),
  ],
);

/** What a node reports in its heartbeat. */
export type PveNodeFacts = {
  pluginLoaded?: boolean;
  restoresAllowed?: boolean;
  problems?: string[];
  state?: "idle" | "running";
  /**
   * The backup runs the node works on, as of `activeRunsAt` (restow-pve from 0.4.0; absent
   * from older helpers). A running backup run of this node it no longer lists is over: the
   * worker closes it instead of waiting 48 hours (#46).
   */
  activeRuns?: string[];
  activeRunsAt?: string;
  /**
   * The task kinds beyond the original set the node can run (restow-pve from 0.4.0 announces
   * `boot_test`). The server hands a node only what it declared; an older node never gets one.
   */
  capabilities?: string[];
};

/** A node with restow-pve. */
export const pveNodes = pgTable(
  "pve_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => pveClusters.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    helperVersion: text("helper_version"),
    pveVersion: text("pve_version"),
    // SHA-256 (hex) of the node secret; the secret itself is shown to the node once.
    secretHash: text("secret_hash").notNull(),
    fleecingStorage: text("fleecing_storage"),
    facts: jsonb("facts").$type<PveNodeFacts>().notNull().default({}),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index("pve_nodes_cluster_idx").on(t.clusterId),
    uniqueIndex("pve_nodes_cluster_name_active_uq")
      .on(t.clusterId, t.name)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

/** Retention of a job's restore points (as for endpoints: daily, weekly, monthly). */
export type PveRetention = { keepDaily: number; keepWeekly: number; keepMonthly: number };

/** What a PVE job does. */
export type PveJobSettings = {
  mode?: PveBackupMode;
  retention?: PveRetention;
  /** Force a full read ("verify read") every this many backups; default 30. */
  verifyReadEvery?: number;
  /** Monthly restore test into the restore pool (needs capacity; off by default). */
  restoreTest?: { enabled: boolean; targetStorage?: string };
  /** Upload limit in kbit/s; null = unlimited. */
  bandwidthKbps?: number | null;
  /** Boot tests of the job's guests (docs/PVE.md, "Boot test"); off by default. */
  bootTest?: PveBootTestSettings;
};

/** When a job proves that its guests' restore points boot. */
export type PveBootTestSchedule = "off" | "weekly" | "after_backup";

export type PveBootTestSettings = {
  schedule: PveBootTestSchedule;
  /** A guest that needs more memory (MiB) than this is not booted; default 8192. */
  maxMemoryMiB?: number;
  /** How long the node waits for the QEMU guest agent (or a container's init), in seconds. */
  timeoutSeconds?: number;
};

/**
 * How a boot test ended (docs/PVE.md, "Boot test"):
 *   green    the restored VM's QEMU guest agent answered (a container: its init runs)
 *   yellow   the guest started and kept running, but nothing inside it answered
 *   red      the restore, the start or the boot failed (the guest stopped)
 *   skipped  the node did not run it (memory, storage, a backup running); `reason` says why
 *   error    the node could not carry it out (its PVE API failed); says nothing about the backup
 */
export type PveBootTestOutcome = "green" | "yellow" | "red" | "skipped" | "error";

/** The result of a boot test, kept with its run and with the restore point it tested. */
export type PveBootTestResult = {
  outcome: PveBootTestOutcome;
  /** A short code: agent_answered, init_running, no_guest_agent, restore_failed, ... */
  reason: string;
  message: string;
  checkedAt: string;
  durationMs: number;
  /** Seconds from the start of the guest until the agent (or init) answered. */
  bootSeconds: number | null;
  guestAgent: boolean;
  /** The temporary VMID on the node (destroyed again). */
  tempVmid: number | null;
  storage: string | null;
  /** Whether the temporary guest was destroyed. */
  cleanedUp: boolean;
  runId: string;
};

/** When a PVE job runs: a daily time in a zone, or every N minutes. */
export type PveJobSchedule = {
  kind: "daily" | "interval";
  timeOfDay?: string;
  intervalMinutes?: number;
  timeZone: string;
};

/**
 * A backup job for VMs and containers. Kept apart from `backup_jobs` in this
 * phase so the mail and endpoint jobs stay untouched; the guests of a job
 * point to it (`pve_guests.job_id`). With `scope_all` the job also covers
 * every guest of the tenant's clusters that is in no other job.
 */
export const pveJobs = pgTable(
  "pve_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    scopeAll: boolean("scope_all").notNull().default(false),
    schedule: jsonb("schedule").$type<PveJobSchedule>(),
    settings: jsonb("settings").$type<PveJobSettings>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    /** The job Restow recommended and made with one click (#52); at most one per tenant. */
    recommended: boolean("recommended").notNull().default(false),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("pve_jobs_tenant_recommended_uq").on(t.tenantId).where(sql`${t.recommended}`),
    uniqueIndex("pve_jobs_tenant_name_uq").on(t.tenantId, sql`lower(${t.name})`),
    uniqueIndex("pve_jobs_tenant_all_uq").on(t.tenantId).where(sql`${t.scopeAll}`),
    index("pve_jobs_due_idx").on(t.enabled, t.nextRunAt),
  ],
);

/** One disk of a guest as the inventory reports it. */
export type PveInventoryDisk = { device: string; size: number; backup: boolean };

/** Where the bitmap of each disk stands after the last backup (for the UI). */
export type PveDiskState = Record<
  string,
  { size: number; lastSnapshotId: string | null; bitmapMode: string; readBytes: number; at: string }
>;

/**
 * A container's repository began a new backup chain (docs/PVE.md, "New backup chain"): the
 * server found the repository missing on the tenant's primary target when a backup began
 * (`missing`), or an administrator reset it (`reset`). The restore points of the chain before
 * became unavailable. `target` is where the repository was looked for (null: not known); its
 * `location` is null for the installation default, whose paths stay with the provider.
 */
export type PveRepositoryChain = {
  at: string;
  reason: "missing" | "reset";
  target: {
    name: string;
    kind: string | null;
    location: string | null;
    installationDefault: boolean;
  } | null;
  /** How many restore points became unavailable with it. */
  unavailablePoints: number;
  /** Who reset it (`reset` only). */
  actor: string | null;
};

/** How many chain changes a guest keeps (newest first). */
export const PVE_REPOSITORY_CHAINS_KEPT = 10;

/** A VM or container of a cluster. */
export const pveGuests = pgTable(
  "pve_guests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => pveClusters.id, { onDelete: "cascade" }),
    vmid: integer("vmid").notNull(),
    kind: text("kind").$type<PveGuestKind>().notNull(),
    name: text("name"),
    node: text("node"),
    status: text("status"),
    template: boolean("template").notNull().default(false),
    privileged: boolean("privileged").notNull().default(false),
    agent: boolean("agent").notNull().default(false),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    pool: text("pool"),
    disks: jsonb("disks").$type<PveInventoryDisk[]>().notNull().default([]),
    diskState: jsonb("disk_state").$type<PveDiskState>().notNull().default({}),
    // False once the node that last reported the guest no longer does (deleted or moved away).
    present: boolean("present").notNull().default(true),
    jobId: uuid("job_id").references(() => pveJobs.id, { onDelete: "set null" }),
    // The restic repository password of a container (sealed in the secret store).
    repositorySecretId: uuid("repository_secret_id").references(() => secrets.id, {
      onDelete: "set null",
    }),
    repositoryReadyAt: timestamp("repository_ready_at", { withTimezone: true }),
    // The bytes the container's restic repository takes: measured once, then counted with
    // every upload and measured again after a prune; null until first measured.
    repositoryBytes: bigint("repository_bytes", { mode: "number" }),
    repositoryMeasuredAt: timestamp("repository_measured_at", { withTimezone: true }),
    // The new backup chains of the container's repository, newest first (at most
    // PVE_REPOSITORY_CHAINS_KEPT): shown on the guest page and in its history.
    repositoryChains: jsonb("repository_chains")
      .$type<PveRepositoryChain[]>()
      .notNull()
      .default([]),
    lastBackupAt: timestamp("last_backup_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastSnapshotId: uuid("last_snapshot_id"),
    lastVerifyAt: timestamp("last_verify_at", { withTimezone: true }),
    lastRestoreTestAt: timestamp("last_restore_test_at", { withTimezone: true }),
    // When the last boot test of the guest was planned or asked for (docs/PVE.md, "Boot test").
    lastBootTestAt: timestamp("last_boot_test_at", { withTimezone: true }),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("pve_guests_cluster_vmid_uq").on(t.clusterId, t.vmid),
    index("pve_guests_tenant_idx").on(t.tenantId),
    index("pve_guests_job_idx").on(t.jobId),
  ],
);

/** A job for a node, delivered with its next heartbeat. */
export const pveTasks = pgTable(
  "pve_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => pveNodes.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id").references(() => pveGuests.id, { onDelete: "cascade" }),
    kind: text("kind").$type<PveTaskKind>().notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<PveTaskStatus>().notNull().default("pending"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    index("pve_tasks_node_status_idx").on(t.nodeId, t.status),
    index("pve_tasks_guest_idx").on(t.guestId, t.createdAt),
    // The backups that wait for their node (the sidebar, the overviews): only open tasks.
    index("pve_tasks_open_backup_idx")
      .on(t.guestId)
      .where(sql`${t.kind} = 'backup' AND ${t.status} IN ('pending', 'delivered')`),
  ],
);

/** What the server recorded at the incremental query, per disk. */
export type PveRunDevice = { size: number; baseSnapshotId: string | null };

export type PveRunStats = {
  archiveSize?: number;
  readBytes?: number;
  uploadedBytes?: number;
  changedBlocks?: number;
  zeroBlocks?: number;
  hashSkipped?: number;
  resticBytesAdded?: number;
  /** Container backups: what restic stored for the new data, compressed (nodes from 0.4.x on). */
  resticBytesAddedPacked?: number;
  /** Container backups: the bytes restic read (`total_bytes_processed`). */
  resticTotalBytes?: number;
  /**
   * VM backups: summed over the run's block frames, the bytes the server's chunk writer chunked,
   * stored as new, and the compressibility sample (docs/RANSOMWARE.md).
   */
  chunkBytesIn?: number;
  chunkBytesNew?: number;
  chunkBytesSampled?: number;
  chunkBytesSampledCompressed?: number;
  /** Container backups: items restic could not read; the restore point misses them. */
  resticUnreadable?: number;
  /** The first of those items (nodes from 0.4 on). */
  unreadablePaths?: string[];
  consistency?: string | null;
  [key: string]: unknown;
};

/**
 * How far a running backup is (#51): what the node reported last. A VM reads
 * its disks (changed blocks only when the bitmap is reused) and uploads what
 * changed; a container's restic reads the files and adds what is new.
 * `bytesTotal` is null while the total is not known yet.
 */
export type PveRunProgress = {
  bytesDone: number;
  bytesTotal: number | null;
  bytesUploaded: number | null;
  /** Read throughput between the last two reports. */
  bytesPerSecond: number | null;
  at: string;
};

/** A backup, restore, restore test or verify of a guest. */
export const pveRuns = pgTable(
  "pve_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => pveClusters.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").references(() => pveNodes.id, { onDelete: "set null" }),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => pveGuests.id, { onDelete: "cascade" }),
    kind: text("kind").$type<PveRunKind>().notNull(),
    // `restow` for a backup Restow asked for, `pve` for one started in PVE.
    origin: text("origin").$type<"restow" | "pve">().notNull().default("restow"),
    status: text("status").$type<PveRunStatus>().notNull().default("running"),
    archiveName: text("archive_name"),
    storageId: text("storage_id"),
    taskId: uuid("task_id"),
    commitId: uuid("commit_id"),
    snapshotId: uuid("snapshot_id"),
    devices: jsonb("devices").$type<Record<string, PveRunDevice>>().notNull().default({}),
    stats: jsonb("stats").$type<PveRunStats>().notNull().default({}),
    errorMessage: text("error_message"),
    failure: jsonb("failure").$type<FailureRecordJson>(),
    logTail: text("log_tail"),
    // The node's last progress report while the run is going (null: none yet, or an older node).
    progress: jsonb("progress").$type<PveRunProgress>(),
    // A short-lived restic credential of a container run (SHA-256 only).
    resticTokenHash: text("restic_token_hash"),
    resticExpiresAt: timestamp("restic_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pve_runs_guest_started_idx").on(t.guestId, t.startedAt),
    index("pve_runs_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("pve_runs_status_idx").on(t.status, t.startedAt),
    // The ransomware judgement (apps/worker suspicion/scan.ts) reads new restore points by time;
    // the predicate is the scan's, word for word.
    index("pve_runs_suspicion_idx")
      .on(t.finishedAt, t.id)
      .where(
        sql`${t.kind} = 'backup' AND ${t.status} = 'succeeded' AND ${t.snapshotId} IS NOT NULL AND ${t.finishedAt} IS NOT NULL`,
      ),
  ],
);

/**
 * Blocks a running VM backup uploaded, before the commit builds the maps.
 * Their chunks hold one reference each while staged, so garbage collection
 * never takes them; the commit or the end of a failed run releases it.
 */
export const pveRunBlocks = pgTable(
  "pve_run_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => pveRuns.id, { onDelete: "cascade" }),
    device: text("device").notNull(),
    blockIndex: integer("block_index").notNull(),
    zero: boolean("zero").notNull(),
    length: integer("length").notNull(),
    sha256: text("sha256").notNull(),
    chunks: jsonb("chunks").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pve_run_blocks_run_block_uq").on(t.runId, t.device, t.blockIndex)],
);

/** One disk of a VM restore point. */
export type PveSnapshotDisk = {
  device: string;
  size: number;
  map: { chunks: string[]; size: number; sha256: string };
  hashesDigest: string;
  changedBlocks: number;
  zeroBlocks: number;
  dataBlocks: number;
  bitmapMode: string;
};

export type PveVerifyResult = {
  checkedAt: string;
  blocks: number;
  mismatched: number;
  errors: string[];
};

/**
 * A restore point ("Sicherungsstand") of a guest. VM: one block map per
 * disk; container: the restic snapshot in the guest's repository. Every
 * restore point is complete on its own; retention can remove any of them.
 * `chunkRefs` is how many chunk references it holds (released when it is pruned).
 */
export const pveSnapshots = pgTable(
  "pve_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => pveClusters.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => pveGuests.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    sequence: integer("sequence").notNull(),
    kind: text("kind").$type<PveGuestKind>().notNull(),
    archiveName: text("archive_name").notNull(),
    storageId: text("storage_id").notNull(),
    origin: text("origin").$type<"restow" | "pve">().notNull().default("restow"),
    // `unavailable`: a container restore point whose repository is gone (a new backup chain
    // began, docs/PVE.md); it cannot be restored or checked, and neither readiness nor
    // retention counts it.
    status: text("status").$type<PveSnapshotStatus>().notNull().default("active"),
    manifestPath: text("manifest_path").notNull(),
    guestConfig: text("guest_config").notNull().default(""),
    firewallConfig: text("firewall_config"),
    disks: jsonb("disks").$type<PveSnapshotDisk[]>().notNull().default([]),
    resticSnapshotId: text("restic_snapshot_id"),
    resticRoot: text("restic_root"),
    byteSize: bigint("byte_size", { mode: "number" }).notNull().default(0),
    stats: jsonb("stats").$type<PveRunStats>().notNull().default({}),
    chunkRefs: integer("chunk_refs").notNull().default(0),
    baseSnapshotId: uuid("base_snapshot_id"),
    backupAt: timestamp("backup_at", { withTimezone: true }).notNull(),
    verify: jsonb("verify").$type<PveVerifyResult>(),
    // The newest boot test of this restore point (null: none ran).
    bootTest: jsonb("boot_test").$type<PveBootTestResult>(),
    prunedAt: timestamp("pruned_at", { withTimezone: true }),
    unavailableAt: timestamp("unavailable_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("pve_snapshots_guest_sequence_uq").on(t.guestId, t.sequence),
    uniqueIndex("pve_snapshots_cluster_archive_uq").on(t.clusterId, t.archiveName),
    index("pve_snapshots_guest_status_idx").on(t.guestId, t.status, t.backupAt),
  ],
);

/** One file or folder of a prepared ZIP download, as resolved in the container's restic snapshot. */
export type PveDownloadItem = { path: string; type: "file" | "dir" };

/**
 * A ZIP download of files of a container restore point (docs/PVE.md, "File
 * restore"), prepared by `POST /api/v1/pve/snapshots/:id/downloads` and
 * streamed once by `GET .../downloads/:downloadId`. Like the endpoint
 * downloads: the selection is checked against the restic snapshot when it is
 * prepared and kept here (no paths in a URL), the row is bound to the admin
 * who asked, expires after a few minutes and can be started exactly once.
 */
export const pveDownloads = pgTable(
  "pve_downloads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => pveSnapshots.id, { onDelete: "cascade" }),
    selection: jsonb("selection").$type<PveDownloadItem[]>().notNull(),
    // better-auth user id of the admin who prepared it; only that admin can start it.
    createdBy: text("created_by").references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Set by the request that started the download; a second one finds it gone.
    startedAt: timestamp("started_at", { withTimezone: true }),
  },
  (t) => [
    index("pve_downloads_snapshot_idx").on(t.snapshotId),
    index("pve_downloads_expires_idx").on(t.expiresAt),
  ],
);

export type PveCluster = typeof pveClusters.$inferSelect;
export type PveNode = typeof pveNodes.$inferSelect;
export type PveGuest = typeof pveGuests.$inferSelect;
export type PveJob = typeof pveJobs.$inferSelect;
export type PveTask = typeof pveTasks.$inferSelect;
export type PveRun = typeof pveRuns.$inferSelect;
export type PveRunBlock = typeof pveRunBlocks.$inferSelect;
export type PveSnapshot = typeof pveSnapshots.$inferSelect;
export type PveEnrollmentToken = typeof pveEnrollmentTokens.$inferSelect;
export type PveDownload = typeof pveDownloads.$inferSelect;
