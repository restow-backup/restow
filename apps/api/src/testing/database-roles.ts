import { randomBytes } from "node:crypto";
import { type RoleLogin, createDb, deriveAuthLogin, grantQueueAccess } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";

/**
 * The application, installation and auth roles for a Postgres-backed test, so
 * the code under test runs exactly as in production: on a role that Row Level
 * Security binds, next to the BYPASSRLS installation role and the auth role
 * better-auth runs on (packages/db/src/roles.ts). The auth role's login is
 * derived from the other two, as in an installation without
 * DATABASE_AUTH_URL, so the api derives the same one from DATABASE_URL and
 * DATABASE_PROVIDER_URL. Roles are cluster-wide, so every suite gets uniquely
 * named ones and drops them again.
 */
export interface TestDatabaseRoles {
  /** DATABASE_URL of the suite: the application role, subject to RLS. */
  appUrl: string;
  /** DATABASE_PROVIDER_URL of the suite: the installation role. */
  providerUrl: string;
  /** The auth pool's connection string (what the api derives itself). */
  authUrl: string;
  /**
   * Give the application role its enqueue access to a pg-boss schema the
   * suite created after provisioning, as the worker and the scheduler do
   * right after starting pg-boss (packages/db roles.ts `grantQueueAccess`).
   */
  grantQueue(): Promise<void>;
  /** Drop the roles; call after the suite's database is gone. */
  drop(adminUrl: string): Promise<void>;
}

function withLogin(url: string, login: RoleLogin): string {
  const parsed = new URL(url);
  parsed.username = login.name;
  parsed.password = login.password;
  return parsed.toString();
}

/** Provision the roles on the (already migrated) database `ownerUrl` points at. */
export async function provisionTestRoles(ownerUrl: string): Promise<TestDatabaseRoles> {
  const suffix = randomBytes(4).toString("hex");
  const tenant: RoleLogin = {
    name: `restow_test_app_${suffix}`,
    password: randomBytes(18).toString("base64url"),
  };
  const installation: RoleLogin = {
    name: `restow_test_provider_${suffix}`,
    password: randomBytes(18).toString("base64url"),
  };
  const auth = deriveAuthLogin(tenant, installation);
  await runMigrations(ownerUrl, { roles: { tenant, installation } });
  return {
    appUrl: withLogin(ownerUrl, tenant),
    providerUrl: withLogin(ownerUrl, installation),
    authUrl: withLogin(ownerUrl, auth),
    async grantQueue() {
      const installationDb = createDb(withLogin(ownerUrl, installation));
      try {
        await grantQueueAccess(installationDb.$client, tenant.name);
      } finally {
        await installationDb.$client.end();
      }
    },
    async drop(adminUrl: string) {
      const admin = createDb(adminUrl);
      try {
        await admin.$client.query(`DROP ROLE IF EXISTS ${tenant.name}`);
        await admin.$client.query(`DROP ROLE IF EXISTS ${installation.name}`);
        await admin.$client.query(`DROP ROLE IF EXISTS ${auth.name}`);
      } finally {
        await admin.$client.end();
      }
    },
  };
}
