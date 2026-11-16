import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  inet,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

/**
 * Worker nodes on other hosts (docs/SIZING.md, "Several hosts: worker nodes"). The main host
 * keeps the api, the edge, the database, the mounter and the updater; a worker node runs the
 * worker (and optionally a standby scheduler) against the main host's database over TLS.
 *
 *   cluster_join_tokens  one-time tokens a provider owner issues under Installation > Cluster.
 *                        Only a keyed hash of the token is stored (HMAC-SHA256 with a key the
 *                        api derives from BETTER_AUTH_SECRET, so a planted row matches no
 *                        token: apps/api features/cluster/tokens.ts); a token is
 *                        short-lived, used once, revocable, and carries no secret itself: it
 *                        authenticates one fetch of the node's configuration over TLS.
 *   cluster_nodes        the nodes that joined, each with its own database logins (members of
 *                        the group role `restow_nodes`, switching to the tenant role and the
 *                        node role), so removing a node revokes exactly its access.
 *
 * Both are installation-level (packages/db roles.ts TABLE_ACCESS). The node role of worker nodes
 * cannot write either and reads only cluster_nodes (roles.ts NODE_DENIED_TABLES).
 */

/** Who issued or revoked a token, or removed a node. */
export interface ClusterActor {
  readonly userId: string | null;
  readonly email: string | null;
  readonly ip: string | null;
}

export const CLUSTER_NODE_STATUSES = ["active", "removed"] as const;
export type ClusterNodeStatus = (typeof CLUSTER_NODE_STATUSES)[number];

export const clusterJoinTokens = pgTable(
  "cluster_join_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** HMAC-SHA256 (hex) of the token (apps/api cluster/tokens.ts); the token is shown once, never stored. */
    tokenHash: text("token_hash").notNull(),
    /** The first characters of the token, to recognise it in the list. */
    prefix: text("prefix").notNull(),
    /** The name the node gets (unique among the active nodes). */
    nodeName: text("node_name").notNull(),
    /** When set, only a request from this address may redeem the token. */
    expectedAddress: inet("expected_address"),
    /** The address the node reaches the database at (host or host:port of the main host). */
    dbAddress: text("db_address").notNull(),
    /** The node also runs a standby scheduler. */
    standbyScheduler: boolean("standby_scheduler").notNull().default(false),
    createdBy: jsonb("created_by").$type<ClusterActor>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedFrom: inet("used_from"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: jsonb("revoked_by").$type<ClusterActor>(),
    /** The node the token created. */
    nodeId: uuid("node_id"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("cluster_join_tokens_hash_uq").on(t.tokenHash),
    index("cluster_join_tokens_open_idx")
      .on(t.expiresAt)
      .where(sql`${t.usedAt} IS NULL AND ${t.revokedAt} IS NULL`),
  ],
);

export type ClusterJoinToken = typeof clusterJoinTokens.$inferSelect;

export const clusterNodes = pgTable(
  "cluster_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** The host name the node reported when it joined. */
    hostname: text("hostname"),
    /** The address the join came from. */
    address: inet("address"),
    /** The node's login for DATABASE_URL (switches to the tenant role). */
    dbLogin: text("db_login").notNull(),
    /** The node's login for DATABASE_PROVIDER_URL (switches to the installation role). */
    dbInstallationLogin: text("db_installation_login").notNull(),
    /** The release the node joined with. */
    version: text("version").notNull(),
    status: text("status").$type<ClusterNodeStatus>().notNull().default("active"),
    standbyScheduler: boolean("standby_scheduler").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: jsonb("removed_by").$type<ClusterActor>(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("cluster_nodes_active_name_uq").on(t.name).where(sql`${t.status} = 'active'`),
    check("cluster_nodes_status", sql`${t.status} IN ('active', 'removed')`),
  ],
);

export type ClusterNode = typeof clusterNodes.$inferSelect;
