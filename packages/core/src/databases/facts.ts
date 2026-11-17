import { z } from "zod";
import { DB_ENGINES, DB_ERROR_CODES, DB_MAX_DATABASES } from "./model.js";

/**
 * What an executor found when it tested a connection (docs/DATABASES.md 3): facts only, the
 * server judges them (rights.ts, identity.ts). The Restow server's probe (probe/probe.ts) and the
 * agent (agent/internal/dbprobe) produce the same shape; the agent's fixtures in
 * agent/internal/api/testdata/contract/db-*.json are the contract, read by both sides' tests.
 *
 * Nothing here ever carries a credential: messages pass through {@link sanitizeDbMessage} on the
 * executor and again on the server before they are stored.
 */

const text = (max: number) => z.string().max(max);
const optionalText = (max: number) => z.string().max(max).nullable().catch(null);

export const dbTlsFactsSchema = z.object({
  /** The server offers TLS (null: unknown, e.g. the address did not answer). */
  offered: z.boolean().nullable(),
  /** The connection used TLS. */
  used: z.boolean(),
  /** SHA-256 of the leaf certificate (DER), upper-case hex pairs separated by colons. */
  fingerprintSha256: z
    .string()
    .regex(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    .nullable()
    .catch(null),
  subject: optionalText(512),
  issuer: optionalText(512),
  notAfter: optionalText(64),
});
export type DbTlsFacts = z.infer<typeof dbTlsFactsSchema>;

export const dbPostgresDatabaseSchema = z.object({
  name: text(128),
  oid: z.string().regex(/^\d{1,10}$/),
  allowConnections: z.boolean(),
  canConnect: z.boolean(),
  sizeBytes: z.number().int().min(0).nullable().catch(null),
});

export const dbPostgresFactsSchema = z.object({
  versionNum: z.number().int().min(0),
  version: text(512),
  currentUser: text(128),
  superuser: z.boolean(),
  createDb: z.boolean(),
  replication: z.boolean(),
  /** Member of `pg_read_all_data` (PostgreSQL 14 and later); null before 14. */
  readAllData: z.boolean().nullable(),
  /** `pg_control_system().system_identifier`, the cluster's identity (3.3). */
  systemIdentifier: z
    .string()
    .regex(/^\d{1,20}$/)
    .nullable()
    .catch(null),
  databases: z.array(dbPostgresDatabaseSchema).max(DB_MAX_DATABASES),
});
export type DbPostgresFacts = z.infer<typeof dbPostgresFactsSchema>;

export const dbMysqlFactsSchema = z.object({
  version: text(256),
  versionComment: optionalText(256),
  currentUser: text(300),
  /** `SHOW GRANTS` of the current user, as the server wrote them. */
  grants: z.array(text(4096)).max(200),
  /** MySQL's `@@server_uuid`; null on MariaDB. */
  serverUuid: optionalText(64),
  serverId: z.number().int().min(0).nullable().catch(null),
  datadir: optionalText(1024),
  logBin: z.boolean().nullable().catch(null),
  binlogFormat: optionalText(32),
  databases: z
    .array(z.object({ name: text(128), sizeBytes: z.number().int().min(0).nullable().catch(null) }))
    .max(DB_MAX_DATABASES),
});
export type DbMysqlFacts = z.infer<typeof dbMysqlFactsSchema>;

export const dbSqlServerFactsSchema = z.object({
  /** From the PRELOGIN answer: major.minor.build. */
  version: optionalText(64),
  /** The PRELOGIN encryption option: off, on, not_supported, required. */
  encryption: z.enum(["off", "on", "not_supported", "required"]).nullable().catch(null),
});
export type DbSqlServerFacts = z.infer<typeof dbSqlServerFactsSchema>;

export const dbSqliteFactsSchema = z.object({
  path: text(4096),
  sizeBytes: z.number().int().min(0),
  pageSize: z.number().int().min(0),
  /** Inode and device on Unix (decimal), the file index on Windows; null where unknown. */
  inode: z
    .string()
    .regex(/^\d{1,24}$/)
    .nullable()
    .catch(null),
  device: z
    .string()
    .regex(/^\d{1,24}$/)
    .nullable()
    .catch(null),
  /** Birth time where the system has one (macOS, Windows); null on Linux. */
  createdAt: optionalText(64),
  modifiedAt: optionalText(64),
});
export type DbSqliteFacts = z.infer<typeof dbSqliteFactsSchema>;

/**
 * What a health check found besides the sign-in (docs/DATABASES.md 8): the response time
 * (connection, TLS, sign-in and `SELECT 1`), when the instance started, the connections in use
 * against the limit, the identity of the instance and, at most once an hour, the size of each
 * database. Only in a result of a spec with `purpose: "health"`; read-only, never a rights fact.
 */
export const dbHealthFactsSchema = z.object({
  latencyMs: z
    .number()
    .int()
    .min(0)
    .max(10 * 60 * 1000),
  startedAt: optionalText(64),
  connectionsUsed: z.number().int().min(0).nullable().catch(null),
  connectionsMax: z.number().int().min(0).nullable().catch(null),
  /** PostgreSQL: `system_identifier`; MySQL: `@@server_uuid`; MariaDB: `@@server_id`, `@@datadir`. */
  systemIdentifier: z
    .string()
    .regex(/^\d{1,20}$/)
    .nullable()
    .catch(null),
  serverUuid: optionalText(64),
  serverId: z.number().int().min(0).nullable().catch(null),
  datadir: optionalText(1024),
  /** Read only when the spec asked for sizes; null otherwise. */
  databases: z
    .array(
      z.object({
        name: text(128),
        /** PostgreSQL: the OID; null for MySQL and MariaDB schemas. */
        oid: z
          .string()
          .regex(/^\d{1,10}$/)
          .nullable()
          .catch(null),
        sizeBytes: z.number().int().min(0).nullable().catch(null),
      }),
    )
    .max(DB_MAX_DATABASES)
    .nullable(),
});
export type DbHealthFacts = z.infer<typeof dbHealthFactsSchema>;

export const dbProbeErrorSchema = z.object({
  code: z.enum(DB_ERROR_CODES).catch("db_probe_failed"),
  message: z.string().max(2000).catch(""),
});
export type DbProbeError = z.infer<typeof dbProbeErrorSchema>;

export const dbProbeResultSchema = z.object({
  /** The engine that answered; null when nothing answered as a database. */
  engine: z.enum(DB_ENGINES).nullable(),
  /** The port that answered (network engines). */
  port: z.number().int().min(1).max(65535).nullable(),
  /** The version as the server announced it (greeting, PRELOGIN or after the sign-in). */
  serverVersion: optionalText(256),
  tls: dbTlsFactsSchema,
  login: z.enum(["ok", "failed", "skipped"]),
  error: dbProbeErrorSchema.nullable(),
  postgresql: dbPostgresFactsSchema.optional(),
  mysql: dbMysqlFactsSchema.optional(),
  sqlserver: dbSqlServerFactsSchema.optional(),
  sqlite: dbSqliteFactsSchema.optional(),
  health: dbHealthFactsSchema.optional(),
  /**
   * The address the connection that signed in reached (the Restow server's probe): a provider
   * admin's approval of a private network names this address and no other.
   */
  connectedAddress: z.string().max(64).nullable().optional(),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(10 * 60 * 1000),
});
export type DbProbeResult = z.infer<typeof dbProbeResultSchema>;

/** An executor's result, checked; null when it is not one (the probe then fails with db_probe_failed). */
export function parseDbProbeResult(value: unknown): DbProbeResult | null {
  const parsed = dbProbeResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** What the executor gets for one probe (credentials only in the one-time fetch, 4.3). */
export const dbProbeSpecSchema = z.object({
  probeId: z.string().uuid(),
  /** The engine the connection has (a stored one) or the URL names; null: detect. */
  engine: z.enum(DB_ENGINES).nullable(),
  host: z.string().max(255).nullable(),
  port: z.number().int().min(1).max(65535).nullable(),
  path: z.string().max(4096).nullable(),
  database: z.string().max(128).nullable(),
  authMethod: z.enum(["password", "socket"]),
  user: z.string().max(128).nullable(),
  password: z.string().max(1024).nullable(),
  /** Without TLS only when the administrator ticked "connect unencrypted". */
  allowUnencrypted: z.boolean(),
  timeoutSeconds: z.number().int().min(1).max(120),
  /**
   * The certificate the connection confirmed (SHA-256, as `AB:CD:...`): the executor stops right
   * after the TLS handshake, before any sign-in, when the server shows another one or no TLS.
   */
  pinnedFingerprintSha256: z
    .string()
    .regex(/^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/)
    .nullable()
    .optional(),
  /**
   * `probe` ("Test connection", 3.2): every fact of the rights matrix. `health` (8): the light
   * health check of a stored connection, with its confirmed certificate as
   * `pinnedFingerprintSha256`. Absent: `probe` (an agent from D1).
   */
  purpose: z.enum(["probe", "health"]).optional(),
  /** Health checks: read the size of each database too (at most once an hour, 8). */
  sizes: z.boolean().optional(),
});
export type DbProbeSpec = z.infer<typeof dbProbeSpecSchema>;

/** One instance an agent's inventory found on its machine (3.4). */
export const dbInventoryInstanceSchema = z.object({
  engine: z.enum(["postgresql", "mysql", "mariadb"]),
  /** Where it was found: pg_lsclusters, a systemd unit, a Docker container, a socket. */
  source: z.enum(["pg_lsclusters", "systemd", "docker", "socket"]),
  name: text(256),
  version: optionalText(64),
  port: z.number().int().min(1).max(65535).nullable().catch(null),
  socket: optionalText(1024),
  container: optionalText(256),
  running: z.boolean().nullable().catch(null),
});
export type DbInventoryInstance = z.infer<typeof dbInventoryInstanceSchema>;

export const dbInventorySchema = z.object({
  collectedAt: z.string().max(64),
  instances: z.array(dbInventoryInstanceSchema).max(64),
});
export type DbInventory = z.infer<typeof dbInventorySchema>;

/**
 * The inventory of a heartbeat, checked: malformed entries are dropped one by one, a malformed
 * inventory as a whole is null (the heartbeat still counts).
 */
export function parseDbInventory(value: unknown): DbInventory | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as { collectedAt?: unknown; instances?: unknown };
  if (typeof raw.collectedAt !== "string" || !Array.isArray(raw.instances)) {
    return null;
  }
  if (Number.isNaN(Date.parse(raw.collectedAt)) || raw.collectedAt.length > 64) {
    return null;
  }
  const instances: DbInventoryInstance[] = [];
  for (const entry of raw.instances.slice(0, 64)) {
    const parsed = dbInventoryInstanceSchema.safeParse(entry);
    if (parsed.success) {
      instances.push(parsed.data);
    }
  }
  return { collectedAt: raw.collectedAt, instances };
}
