import { readFile } from "node:fs/promises";
import { MAIN_HOST_QUEUES } from "@restow/core";
import {
  type ClusterActor,
  clusterJoinTokens,
  clusterNodes,
  createDb,
  createNodeLogins,
  type Database,
  dropNodeLogins,
  nodeKeyOf,
  roleLoginFromUrl,
  serviceVersion,
} from "@restow/db";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { currentInstallationDefault } from "../../lib/installation-default.js";
import { ProblemError } from "../../problem.js";
import type { CreateJoinTokenInput, JoinRequest } from "./schemas.js";
import { generateJoinToken, hashJoinToken, isWellFormedJoinToken, joinTokenKey } from "./tokens.js";

/**
 * Worker nodes on other hosts (docs/SIZING.md, "Several hosts: worker nodes"), for
 * Installation > Cluster and the join of a new node (`install.sh --join`):
 *
 *   view           the nodes (service_heartbeats grouped by the node id they report, merged with
 *                  cluster_nodes), the open join tokens, what a node needs (per storage target:
 *                  S3 works, a directory must exist at the same path on the node, a Docker volume
 *                  blocks a join) and how the database is reachable from the network
 *   create token   a one-time join token (shown once, 15 minutes to 24 hours, single use,
 *                  optionally bound to the node's address, stored as a hash keyed with a key
 *                  derived from BETTER_AUTH_SECRET: tokens.ts), audited
 *   revoke token   audited
 *   join           the node redeems its token over TLS and gets exactly what a worker needs: its
 *                  own two database logins (node-roles.ts; the installation login switches to the
 *                  node role, which cannot write the join tokens, the node list, the provider
 *                  team or the sign-in tables), the CA of the database, the master
 *                  key and the storage settings of the environment. Never the owner's
 *                  connection, the main host's own logins or the auth secret.
 *   remove node    its logins are dropped and their sessions ended, audited. What the node knew
 *                  (the master key above all) cannot be taken back: the master key cannot be
 *                  rotated yet.
 */

export const CLUSTER_AUDIT_ACTIONS = {
  tokenCreated: "cluster.join_token.created",
  tokenRevoked: "cluster.join_token.revoked",
  nodeJoined: "cluster.node.joined",
  joinRefused: "cluster.node.join_refused",
  nodeRemoved: "cluster.node.removed",
} as const;

export const CLUSTER_PROBLEM = "urn:restow:problem:cluster";

/** Where the api finds the CA of the database's TLS certificate (install.sh --allow-worker). */
export const DEFAULT_DB_CA_FILE = "/etc/restow/postgres-tls/ca.crt";
/** Where a node keeps that CA (docker-compose.worker.yml mounts it). */
export const NODE_DB_CA_PATH = "/etc/restow/db-ca.crt";

/** A heartbeat younger than this is a running process (packages/db heartbeat.ts). */
const ALIVE_SECONDS = 120;

type Env = Record<string, string | undefined>;

function problem(
  status: 401 | 403 | 404 | 409 | 503,
  title: string,
  detail: string,
  code: string,
): ProblemError {
  return new ProblemError(status, title, { type: CLUSTER_PROBLEM, detail, extensions: { code } });
}

export interface ClusterProcessView {
  readonly role: string;
  readonly instanceId: string;
  readonly version: string;
  readonly alive: boolean;
  readonly state: string | null;
  readonly beatAt: string;
  readonly startedAt: string;
}

export interface ClusterNodeView {
  /** null: the main host. */
  readonly id: string | null;
  readonly name: string;
  readonly hostname: string | null;
  readonly address: string | null;
  readonly status: "main" | "active" | "removed";
  readonly joinedAt: string | null;
  readonly version: string | null;
  /** A process of the node runs another release than this api. */
  readonly outdated: boolean;
  /**
   * A process of the node refuses work (packages/db node-guard.ts): the database is newer than
   * its image, or the main host is being updated to another release.
   */
  readonly versionMismatch: boolean;
  readonly processes: readonly ClusterProcessView[];
}

export interface ClusterTargetRequirement {
  readonly tenantId: string | null;
  readonly tenantName: string | null;
  readonly targetId: string;
  /** s3: works from any host; directory: the same path must exist on the node; volume: blocks. */
  readonly kind: "s3" | "directory" | "volume";
  readonly path: string | null;
}

export interface ClusterView {
  readonly version: string;
  readonly nodes: readonly ClusterNodeView[];
  readonly tokens: readonly {
    id: string;
    prefix: string;
    nodeName: string;
    expectedAddress: string | null;
    standbyScheduler: boolean;
    expiresAt: string;
    createdBy: ClusterActor;
  }[];
  readonly targets: readonly ClusterTargetRequirement[];
  /** A Docker volume holds a target: no node can reach it, so no join is possible. */
  readonly joinBlocked: boolean;
  readonly database: {
    /** The address nodes reach the database at (RESTOW_CLUSTER_DB_ADDRESS), or null: not exposed. */
    readonly address: string | null;
    readonly ssl: boolean | null;
    /** The pg_hba.conf lines that admit worker nodes (`+restow_nodes`). */
    readonly nodeRules: readonly { address: string | null; method: string | null; type: string }[];
    readonly error: string | null;
  };
}

const iso = (value: unknown): string => new Date(value as string).toISOString();

/** A local path inside the `restow-data` Docker volume of the main host. */
export function isVolumePath(path: string): boolean {
  return path === "/data" || path.startsWith("/data/");
}

function classify(location: { kind: string; basePath?: string }): ClusterTargetRequirement["kind"] {
  if (location.kind === "s3") {
    return "s3";
  }
  return location.basePath && isVolumePath(location.basePath) ? "volume" : "directory";
}

/** Per storage target (and the installation default): what a node needs to reach it. */
export async function targetRequirements(db: Database): Promise<ClusterTargetRequirement[]> {
  const { rows } = await db.$client.query<{
    tenant_id: string;
    tenant_name: string | null;
    id: string;
    kind: string;
    base_path: string | null;
  }>(
    `SELECT s.tenant_id::text AS tenant_id, t.name AS tenant_name, s.id::text AS id, s.kind::text AS kind,
            s.config->>'basePath' AS base_path
       FROM storage_targets s LEFT JOIN tenants t ON t.id = s.tenant_id
      WHERE s.kind <> 'installation_default'
      ORDER BY t.name NULLS LAST, s.created_at`,
  );
  const targets: ClusterTargetRequirement[] = rows.map((row) => ({
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    targetId: row.id,
    kind: classify({ kind: row.kind, basePath: row.base_path ?? undefined }),
    path: row.base_path,
  }));
  const defaults = await currentInstallationDefault().catch(() => null);
  if (defaults) {
    const locations = [
      { id: "default", location: defaults.primary },
      ...(defaults.copy ? [{ id: "default-copy", location: defaults.copy }] : []),
    ];
    for (const { id, location } of locations) {
      targets.push({
        tenantId: null,
        tenantName: null,
        targetId: id,
        kind: classify(location),
        path: location.kind === "local" ? location.basePath : null,
      });
    }
  }
  return targets;
}

/** The key of the join token hashes (tokens.ts), or a 503 when the api has no auth secret. */
function tokenKey(env: Env): Buffer {
  const key = joinTokenKey(env);
  if (!key) {
    throw problem(
      503,
      "Configuration incomplete",
      "BETTER_AUTH_SECRET is not set in the api's environment.",
      "configuration",
    );
  }
  return key;
}

function withOwner<T>(env: Env, fn: (owner: Database) => Promise<T>): Promise<T> {
  const url = env.DATABASE_MIGRATION_URL?.trim();
  if (!url) {
    throw problem(
      503,
      "Owner connection missing",
      "DATABASE_MIGRATION_URL is not set in the api's environment.",
      "owner_missing",
    );
  }
  const owner = createDb(url, { max: 1 });
  return fn(owner).finally(() => owner.$client.end());
}

async function databaseExposure(env: Env): Promise<ClusterView["database"]> {
  const address = env.RESTOW_CLUSTER_DB_ADDRESS?.trim() || null;
  try {
    return await withOwner(env, async (owner) => {
      const ssl = await owner.$client.query<{ ssl: string }>("SHOW ssl");
      let nodeRules: ClusterView["database"]["nodeRules"] = [];
      try {
        const { rows } = await owner.$client.query<{
          type: string;
          address: string | null;
          auth_method: string | null;
        }>(
          `SELECT type, address, auth_method FROM pg_hba_file_rules
            WHERE 'restow_nodes' = ANY (user_name) OR '+restow_nodes' = ANY (user_name)`,
        );
        nodeRules = rows.map((row) => ({
          type: row.type,
          address: row.address,
          method: row.auth_method,
        }));
      } catch {
        // pg_hba_file_rules needs a superuser; an owner without it shows no rules.
      }
      return { address, ssl: ssl.rows[0]?.ssl === "on", nodeRules, error: null };
    });
  } catch (error) {
    return {
      address,
      ssl: null,
      nodeRules: [],
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown error",
    };
  }
}

export async function clusterView(db: Database, env: Env = process.env): Promise<ClusterView> {
  const version = serviceVersion(env);
  const { rows: beats } = await db.$client.query<{
    role: string;
    instance_id: string;
    version: string;
    hostname: string | null;
    started_at: Date;
    beat_at: Date;
    alive: boolean;
    node_id: string | null;
    state: string | null;
  }>(
    `SELECT role::text AS role, instance_id, version, hostname, started_at, beat_at,
            beat_at > now() - make_interval(secs => $1) AS alive,
            details->>'nodeId' AS node_id, details->>'state' AS state
       FROM service_heartbeats ORDER BY role, started_at`,
    [ALIVE_SECONDS],
  );
  const nodeRows = await db
    .select()
    .from(clusterNodes)
    .orderBy(desc(clusterNodes.joinedAt))
    .limit(200);
  const processesOf = (nodeId: string | null) =>
    beats
      .filter((beat) => (beat.node_id ?? null) === nodeId)
      .map((beat) => ({
        role: beat.role,
        instanceId: beat.instance_id,
        version: beat.version,
        alive: beat.alive,
        state: beat.state,
        beatAt: iso(beat.beat_at),
        startedAt: iso(beat.started_at),
      }));
  const summary = (processes: ClusterProcessView[]) => {
    const alive = processes.filter((process) => process.alive);
    return {
      version: alive[0]?.version ?? processes[0]?.version ?? null,
      outdated: alive.some((process) => process.version !== version),
      versionMismatch: alive.some(
        (process) => process.state === "version_mismatch" || process.state === "update_announced",
      ),
    };
  };
  const main = processesOf(null);
  const nodes: ClusterNodeView[] = [
    {
      id: null,
      name: "main",
      hostname: null,
      address: null,
      status: "main",
      joinedAt: null,
      ...summary(main),
      processes: main,
    },
    ...nodeRows
      .filter((row) => row.status === "active" || processesOf(row.id).some((p) => p.alive))
      .map((row) => {
        const processes = processesOf(row.id);
        return {
          id: row.id,
          name: row.name,
          hostname: row.hostname,
          address: row.address,
          status: row.status,
          joinedAt: row.joinedAt.toISOString(),
          ...summary(processes),
          version: summary(processes).version ?? row.version,
          processes,
        };
      }),
  ];
  const tokens = await db
    .select()
    .from(clusterJoinTokens)
    .where(
      and(
        isNull(clusterJoinTokens.usedAt),
        isNull(clusterJoinTokens.revokedAt),
        gt(clusterJoinTokens.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(clusterJoinTokens.createdAt));
  const targets = await targetRequirements(db);
  return {
    version,
    nodes,
    tokens: tokens.map((token) => ({
      id: token.id,
      prefix: token.prefix,
      nodeName: token.nodeName,
      expectedAddress: token.expectedAddress,
      standbyScheduler: token.standbyScheduler,
      expiresAt: token.expiresAt.toISOString(),
      createdBy: token.createdBy,
    })),
    targets,
    joinBlocked: targets.some((target) => target.kind === "volume"),
    database: await databaseExposure(env),
  };
}

export async function createJoinToken(
  db: Database,
  input: CreateJoinTokenInput & { readonly actor: ClusterActor },
  env: Env = process.env,
): Promise<{ id: string; token: string; prefix: string; expiresAt: string }> {
  const dbAddress = env.RESTOW_CLUSTER_DB_ADDRESS?.trim();
  if (!dbAddress) {
    throw problem(
      409,
      "The database is not reachable from the network",
      "Enable access for the worker host first: on this server, run install.sh --allow-worker <address of the worker host>.",
      "database_not_exposed",
    );
  }
  const targets = await targetRequirements(db);
  if (targets.some((target) => target.kind === "volume")) {
    throw problem(
      409,
      "A storage target lives in a Docker volume",
      "A worker node cannot reach storage in a Docker volume of this host. Move those targets to S3 or to a shared directory first.",
      "volume_targets",
    );
  }
  const active = await db
    .select({ id: clusterNodes.id })
    .from(clusterNodes)
    .where(and(eq(clusterNodes.name, input.nodeName), eq(clusterNodes.status, "active")));
  if (active.length > 0) {
    throw problem(
      409,
      "Name in use",
      `A node named ${input.nodeName} is active already.`,
      "name_in_use",
    );
  }
  const generated = generateJoinToken(tokenKey(env));
  const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(clusterJoinTokens)
      .values({
        tokenHash: generated.hash,
        prefix: generated.prefix,
        nodeName: input.nodeName,
        expectedAddress: input.expectedAddress ?? null,
        dbAddress,
        standbyScheduler: input.standbyScheduler,
        createdBy: input.actor,
        expiresAt,
      })
      .returning({ id: clusterJoinTokens.id });
    if (!row) {
      throw new Error("the join token was not stored");
    }
    await audit(tx, {
      tenantId: null,
      actor: input.actor.email ?? "unknown",
      actorUserId: input.actor.userId,
      action: CLUSTER_AUDIT_ACTIONS.tokenCreated,
      target: row.id,
      targetType: "cluster_join_token",
      ip: input.actor.ip,
      details: {
        nodeName: input.nodeName,
        prefix: generated.prefix,
        expectedAddress: input.expectedAddress ?? null,
        expiresAt: expiresAt.toISOString(),
        standbyScheduler: input.standbyScheduler,
      },
    });
    return {
      id: row.id,
      token: generated.token,
      prefix: generated.prefix,
      expiresAt: expiresAt.toISOString(),
    };
  });
}

export async function revokeJoinToken(
  db: Database,
  id: string,
  actor: ClusterActor,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(clusterJoinTokens)
      .set({ revokedAt: new Date(), revokedBy: actor })
      .where(
        and(
          eq(clusterJoinTokens.id, id),
          isNull(clusterJoinTokens.usedAt),
          isNull(clusterJoinTokens.revokedAt),
        ),
      )
      .returning({ id: clusterJoinTokens.id, prefix: clusterJoinTokens.prefix });
    if (!row) {
      throw problem(404, "Not found", "There is no open join token with this id.", "not_found");
    }
    await audit(tx, {
      tenantId: null,
      actor: actor.email ?? "unknown",
      actorUserId: actor.userId,
      action: CLUSTER_AUDIT_ACTIONS.tokenRevoked,
      target: row.id,
      targetType: "cluster_join_token",
      ip: actor.ip,
      details: { prefix: row.prefix },
    });
  });
}

/** What a node gets when it joins: the `.env` of a worker-only node, and nothing more. */
export interface JoinResponse {
  readonly node: { readonly id: string; readonly name: string };
  readonly version: string;
  readonly standbyScheduler: boolean;
  /** The variables of the node's `.env` (an allowlist; never the owner's login or auth secret). */
  readonly env: Readonly<Record<string, string>>;
  /** The CA certificate the node verifies the database's certificate with. */
  readonly caCertificate: string;
  /** Directory targets: the node must have them at the same path (bind mounts). */
  readonly directories: readonly string[];
}

/** Environment variables a worker node copies from the main host when they are set. */
const COPIED_ENV =
  /^(STORAGE_TARGET|STORAGE_LOCAL_PATH|STORAGE_COPY_LOCAL_PATH|S3_[A-Z0-9_]+|ENTRA_[A-Z0-9_]+|RESTOW_PRODUCT_NAME|RESTOW_WEBHOOK_ALLOW_PRIVATE|LOG_LEVEL)$/;

function nodeUrl(
  base: string,
  login: { name: string; password: string },
  dbAddress: string,
): string {
  const database = new URL(base).pathname.replace(/^\//, "") || "restow";
  const url = new URL(`postgres://${dbAddress}/${database}`);
  url.username = login.name;
  url.password = login.password;
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", NODE_DB_CA_PATH);
  return url.toString();
}

async function refuse(
  db: Database,
  token: { id: string; prefix: string } | null,
  ip: string | null,
  reason: string,
  error: ProblemError,
): Promise<never> {
  // Only a real token is audited; random guesses would only fill the log.
  if (token) {
    await audit(db, {
      tenantId: null,
      actor: "system:cluster-join",
      action: CLUSTER_AUDIT_ACTIONS.joinRefused,
      target: token.id,
      targetType: "cluster_join_token",
      ip,
      details: { prefix: token.prefix, reason },
    }).catch(() => undefined);
  }
  throw error;
}

/** Redeem a join token (the public join route): single use, checked, audited. */
export async function redeemJoinToken(
  db: Database,
  input: JoinRequest & { readonly token: string; readonly ip: string | null },
  env: Env = process.env,
): Promise<JoinResponse> {
  const invalid = problem(
    401,
    "Join token not valid",
    "The join token is unknown, used, revoked or expired.",
    "invalid_token",
  );
  if (!isWellFormedJoinToken(input.token)) {
    throw invalid;
  }
  // Keyed: a row the api did not write (planted with a hash of a chosen token) matches nothing.
  const [row] = await db
    .select()
    .from(clusterJoinTokens)
    .where(eq(clusterJoinTokens.tokenHash, hashJoinToken(input.token, tokenKey(env))))
    .limit(1);
  if (!row || row.usedAt || row.revokedAt || row.expiresAt.getTime() <= Date.now()) {
    return refuse(
      db,
      row ? { id: row.id, prefix: row.prefix } : null,
      input.ip,
      "invalid",
      invalid,
    );
  }
  const version = serviceVersion(env);
  if (input.version.replace(/^v/, "") !== version) {
    // Not used up: the node installs the right release and tries again.
    return refuse(
      db,
      row,
      input.ip,
      "version_mismatch",
      problem(
        409,
        "Different release",
        `This installation runs ${version}; the node runs ${input.version}. Install ${version} on the node.`,
        "version_mismatch",
      ),
    );
  }
  if (row.expectedAddress && row.expectedAddress !== input.ip) {
    return refuse(
      db,
      row,
      input.ip,
      "address",
      problem(
        403,
        "Wrong address",
        "This join token is bound to another address.",
        "address_mismatch",
      ),
    );
  }
  if (input.nodeName !== row.nodeName) {
    return refuse(
      db,
      row,
      input.ip,
      "name",
      problem(
        409,
        "Other node name",
        `This join token is for the node ${row.nodeName}.`,
        "name_mismatch",
      ),
    );
  }
  const caFile = env.RESTOW_CLUSTER_DB_CA_FILE?.trim() || DEFAULT_DB_CA_FILE;
  let caCertificate: string;
  try {
    caCertificate = await readFile(caFile, "utf8");
  } catch {
    throw problem(
      503,
      "Database certificate missing",
      `The CA certificate of the database is not readable at ${caFile} (install.sh --allow-worker writes it).`,
      "ca_missing",
    );
  }
  const masterKey = env.RESTOW_MASTER_KEY?.trim();
  const tenantUrl = env.DATABASE_URL?.trim();
  const installationUrl = env.DATABASE_PROVIDER_URL?.trim();
  if (!masterKey || !tenantUrl || !installationUrl) {
    throw problem(
      503,
      "Configuration incomplete",
      "The api lacks the settings a node needs.",
      "configuration",
    );
  }
  // Single use, decided by the database: a second request with the same token gets nothing.
  const claimed = await db
    .update(clusterJoinTokens)
    .set({ usedAt: new Date(), usedFrom: input.ip })
    .where(
      and(
        eq(clusterJoinTokens.id, row.id),
        isNull(clusterJoinTokens.usedAt),
        isNull(clusterJoinTokens.revokedAt),
        gt(clusterJoinTokens.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: clusterJoinTokens.id });
  if (claimed.length === 0) {
    return refuse(db, row, input.ip, "raced", invalid);
  }
  const [node] = await db
    .insert(clusterNodes)
    .values({
      name: row.nodeName,
      hostname: input.hostname ?? null,
      address: input.ip,
      dbLogin: "pending",
      dbInstallationLogin: "pending",
      version,
      standbyScheduler: row.standbyScheduler,
    })
    .returning();
  if (!node) {
    throw new Error("the node was not stored");
  }
  let logins: Awaited<ReturnType<typeof createNodeLogins>>;
  try {
    logins = await withOwner(env, async (owner) => {
      const client = await owner.$client.connect();
      try {
        return await createNodeLogins(client, {
          nodeKey: nodeKeyOf(node.id),
          tenantRole: roleLoginFromUrl(tenantUrl, "DATABASE_URL").name,
          installationRole: roleLoginFromUrl(installationUrl, "DATABASE_PROVIDER_URL").name,
        });
      } finally {
        client.release();
      }
    });
  } catch (error) {
    await db.delete(clusterNodes).where(eq(clusterNodes.id, node.id));
    throw error;
  }
  await db.transaction(async (tx) => {
    await tx
      .update(clusterNodes)
      .set({ dbLogin: logins.app.name, dbInstallationLogin: logins.installation.name })
      .where(eq(clusterNodes.id, node.id));
    await tx
      .update(clusterJoinTokens)
      .set({ nodeId: node.id })
      .where(eq(clusterJoinTokens.id, row.id));
    await audit(tx, {
      tenantId: null,
      actor: "system:cluster-join",
      action: CLUSTER_AUDIT_ACTIONS.nodeJoined,
      target: node.id,
      targetType: "cluster_node",
      ip: input.ip,
      details: {
        name: node.name,
        hostname: node.hostname,
        version,
        prefix: row.prefix,
        logins: [logins.app.name, logins.installation.name],
      },
    });
  });
  const nodeEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== "" && COPIED_ENV.test(name)) {
      nodeEnv[name] = value;
    }
  }
  Object.assign(nodeEnv, {
    DATABASE_URL: nodeUrl(tenantUrl, logins.app, row.dbAddress),
    DATABASE_PROVIDER_URL: nodeUrl(installationUrl, logins.installation, row.dbAddress),
    RESTOW_MASTER_KEY: masterKey,
    RESTOW_NODE_ID: node.id,
    RESTOW_NODE_NAME: node.name,
    RESTOW_WORKER_EXCLUDE_QUEUES: MAIN_HOST_QUEUES.join(","),
    ...(env.RESTOW_IMAGE ? { RESTOW_IMAGE: env.RESTOW_IMAGE } : {}),
    ...(env.RESTOW_PUBLIC_URL ? { RESTOW_PUBLIC_URL: env.RESTOW_PUBLIC_URL } : {}),
  });
  const directories = (await targetRequirements(db))
    .filter((target) => target.kind === "directory" && target.path)
    .map((target) => target.path as string);
  return {
    node: { id: node.id, name: node.name },
    version,
    standbyScheduler: row.standbyScheduler,
    env: nodeEnv,
    caCertificate,
    directories: [...new Set(directories)].sort(),
  };
}

export async function removeNode(
  db: Database,
  id: string,
  actor: ClusterActor,
  env: Env = process.env,
): Promise<void> {
  const [node] = await db.select().from(clusterNodes).where(eq(clusterNodes.id, id)).limit(1);
  if (node?.status !== "active") {
    throw problem(404, "Not found", "There is no active node with this id.", "not_found");
  }
  const logins = [node.dbLogin, node.dbInstallationLogin].filter((name) => name !== "pending");
  await withOwner(env, (owner) => dropNodeLogins(owner.$client, logins));
  await db.transaction(async (tx) => {
    await tx
      .update(clusterNodes)
      .set({ status: "removed", removedAt: new Date(), removedBy: actor })
      .where(eq(clusterNodes.id, id));
    await audit(tx, {
      tenantId: null,
      actor: actor.email ?? "unknown",
      actorUserId: actor.userId,
      action: CLUSTER_AUDIT_ACTIONS.nodeRemoved,
      target: id,
      targetType: "cluster_node",
      ip: actor.ip,
      details: { name: node.name, logins },
    });
  });
}

/** One `.env` line, quoted where Compose would read the value otherwise (spaces, `#`, `$`). */
export function envLine(name: string, value: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} cannot be written to an .env file`);
  }
  if (/^[A-Za-z0-9_./:@+=,%?&-]*$/.test(value)) {
    return `${name}=${value}`;
  }
  if (!value.includes("'")) {
    return `${name}='${value}'`;
  }
  return `${name}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "$$$$")}"`;
}

/**
 * The join's answer as install.sh reads it (`?format=env`, no JSON parser needed on the node):
 * `RESTOW_JOIN_*` lines are for install.sh itself (the standby scheduler, the directories to bind,
 * the database's CA in base64); every other line goes into the node's `.env` as it is.
 */
export function formatJoinEnv(response: JoinResponse): string {
  const lines = [
    `# restow join: node ${response.node.name} (${response.node.id}), release ${response.version}`,
    "RESTOW_JOIN_FORMAT=1",
    `RESTOW_JOIN_STANDBY_SCHEDULER=${response.standbyScheduler ? 1 : 0}`,
    envLine("RESTOW_JOIN_DIRECTORIES", response.directories.join(":")),
    `RESTOW_JOIN_CA_B64=${Buffer.from(response.caCertificate, "utf8").toString("base64")}`,
    ...Object.entries(response.env)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => envLine(name, value)),
  ];
  return `${lines.join("\n")}\n`;
}
