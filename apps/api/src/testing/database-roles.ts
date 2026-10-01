import { randomBytes } from "node:crypto";
import { type RoleLogin, createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";

/**
 * The application and installation roles for a Postgres-backed test, so the
 * code under test runs exactly as in production: on a role that Row Level
 * Security binds, next to the BYPASSRLS installation role
 * (packages/db/src/roles.ts). Roles are cluster-wide, so every suite gets
 * uniquely named ones and drops them again.
 */
export interface TestDatabaseRoles {
  /** DATABASE_URL of the suite: the application role, subject to RLS. */
  appUrl: string;
  /** DATABASE_PROVIDER_URL of the suite: the installation role. */
  providerUrl: string;
  /** Drop both roles; call after the suite's database is gone. */
  drop(adminUrl: string): Promise<void>;
}

function withLogin(url: string, login: RoleLogin): string {
  const parsed = new URL(url);
  parsed.username = login.name;
  parsed.password = login.password;
  return parsed.toString();
}

/** Provision both roles on the (already migrated) database `ownerUrl` points at. */
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
  await runMigrations(ownerUrl, { roles: { tenant, installation } });
  return {
    appUrl: withLogin(ownerUrl, tenant),
    providerUrl: withLogin(ownerUrl, installation),
    async drop(adminUrl: string) {
      const admin = createDb(adminUrl);
      try {
        await admin.$client.query(`DROP ROLE IF EXISTS ${tenant.name}`);
        await admin.$client.query(`DROP ROLE IF EXISTS ${installation.name}`);
      } finally {
        await admin.$client.end();
      }
    },
  };
}
