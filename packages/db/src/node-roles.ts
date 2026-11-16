import { randomBytes } from "node:crypto";
import {
  DatabaseRoleError,
  nodeInstallationRoleName,
  nodeRoleStatements,
  type Queryable,
  type RoleLogin,
  scramSha256Verifier,
} from "./roles.js";

/**
 * The database logins of a worker node on another host (docs/SIZING.md, "Several hosts: worker
 * nodes"; apps/api features/cluster). Each node gets two login roles of its own:
 *
 *   restow_node_<key>_app   DATABASE_URL of the node: switches to the tenant role at login
 *   restow_node_<key>_inst  DATABASE_PROVIDER_URL of the node: switches to the node role
 *                           (`<installation role>_node`, roles.ts `nodeInstallationRoleName`)
 *
 * Both are members of the group role `restow_nodes`, which is what pg_hba.conf admits from a
 * worker host (`hostssl <db> +restow_nodes <address>/32 scram-sha-256`), and of the role they
 * switch to (`ALTER ROLE ... SET role`). After the login the session runs as that role: Row Level
 * Security, BYPASSRLS and object ownership are the role's, so the node checks its pools exactly
 * like the main host (roles.ts `assertDatabaseRoles`), while `session_user` and pg_stat_activity
 * still name the node. The tenant login has the main host's tenant rights (bound by Row Level
 * Security). The installation login does not get the api's installation role: the node role has
 * what a worker and a standby scheduler need and nothing on the sign-in tables, the provider team
 * or the join tokens, no CREATE on the database, and owns nothing, so a node cannot plant a join
 * token, take over a provider account or keep access after its removal. Removing a node drops its
 * two logins and ends their sessions; the node role stays for the other nodes.
 */

/** Serializes the change of grants with the migration step (roles.ts uses the same lock). */
const GRANT_LOCK = "SELECT pg_advisory_xact_lock(hashtext('restow.database-roles'))";

/** The group role pg_hba.conf admits from worker hosts. */
export const NODE_GROUP_ROLE = "restow_nodes";

/** `restow_node_<key>_app` and `_inst`: the key is 12 lower-case hex characters. */
const NODE_KEY = /^[0-9a-f]{12}$/;
const NODE_LOGIN = /^restow_node_[0-9a-f]{12}_(app|inst)$/;
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function ident(name: string): string {
  if (!ROLE_NAME.test(name)) {
    throw new DatabaseRoleError(`invalid role name "${name}"`);
  }
  return `"${name}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The node key of a node id (its first 12 hex characters without dashes). */
export function nodeKeyOf(nodeId: string): string {
  const key = nodeId.replace(/-/g, "").toLowerCase().slice(0, 12);
  if (!NODE_KEY.test(key)) {
    throw new DatabaseRoleError(`invalid node id "${nodeId}"`);
  }
  return key;
}

export function isNodeLogin(name: string): boolean {
  return NODE_LOGIN.test(name);
}

export interface NodeLogins {
  /** DATABASE_URL of the node. */
  readonly app: RoleLogin;
  /** DATABASE_PROVIDER_URL of the node. */
  readonly installation: RoleLogin;
}

/**
 * Create the two logins of a node (`owner`: one connection as the database owner, a superuser in
 * the compose default, which may create the BYPASSRLS node role). One transaction; creates the
 * node role or renews its grants first, and refuses when a login of that key exists already.
 * Passwords are new random values, set as SCRAM verifiers so the plaintext never appears in a
 * statement.
 */
export async function createNodeLogins(
  owner: Queryable,
  input: {
    readonly nodeKey: string;
    readonly tenantRole: string;
    readonly installationRole: string;
  },
): Promise<NodeLogins> {
  if (!NODE_KEY.test(input.nodeKey)) {
    throw new DatabaseRoleError(`invalid node key "${input.nodeKey}"`);
  }
  const app: RoleLogin = {
    name: `restow_node_${input.nodeKey}_app`,
    password: randomBytes(24).toString("base64url"),
  };
  const installation: RoleLogin = {
    name: `restow_node_${input.nodeKey}_inst`,
    password: randomBytes(24).toString("base64url"),
  };
  const attributes = "LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT";
  const nodeRole = nodeInstallationRoleName(input.installationRole);
  await owner.query("BEGIN");
  try {
    await owner.query(GRANT_LOCK);
    const { rows } = await owner.query<{ database: string }>(
      "SELECT current_database() AS database",
    );
    const database = `"${(rows[0]?.database ?? "").replace(/"/g, '""')}"`;
    for (const statement of nodeRoleStatements({
      nodeRole,
      installationRole: input.installationRole,
      database,
    })) {
      await owner.query(statement);
    }
    await owner.query(`DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(NODE_GROUP_ROLE)}) THEN
    CREATE ROLE ${ident(NODE_GROUP_ROLE)} NOLOGIN;
  END IF;
END $$`);
    for (const [login, target] of [
      [app, input.tenantRole],
      [installation, nodeRole],
    ] as const) {
      await owner.query(
        `CREATE ROLE ${ident(login.name)} WITH ${attributes} PASSWORD ${literal(scramSha256Verifier(login.password))} IN ROLE ${ident(NODE_GROUP_ROLE)}, ${ident(target)}`,
      );
      await owner.query(`ALTER ROLE ${ident(login.name)} SET role = ${literal(target)}`);
    }
    await owner.query("COMMIT");
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return { app, installation };
}

/**
 * Revoke a node's database access: no new login, its sessions ended, its roles dropped. Names
 * that are not node logins are refused; missing roles are skipped (removing twice is fine).
 */
export async function dropNodeLogins(owner: Queryable, names: readonly string[]): Promise<void> {
  for (const name of names) {
    if (!isNodeLogin(name)) {
      throw new DatabaseRoleError(`"${name}" is not the login of a worker node`);
    }
  }
  for (const name of names) {
    const { rows } = await owner.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
      [name],
    );
    if (rows[0]?.exists !== true) {
      continue;
    }
    await owner.query(`ALTER ROLE ${ident(name)} NOLOGIN`);
    await owner.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()",
      [name],
    );
    await owner.query(`DROP ROLE IF EXISTS ${ident(name)}`);
  }
}
