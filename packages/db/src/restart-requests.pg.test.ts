/**
 * Restart requests against a real schema (restart-requests.ts): a request is
 * recorded once per service and reason, listed oldest first, cleared by the
 * start of the service it names and by nothing else, and only the
 * installation pool reaches the table (it is installation-level, roles.ts).
 * Also: the size probe of the old manifest table, which the running api asks
 * the installation pool before it opens an owner connection
 * (apps/api lib/legacy-manifest-reclaim.ts).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (roles are cluster-wide; the suite creates uniquely named ones and
 * drops them again). Without it the suite is skipped.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./index.js";
import { legacyManifestBytes, runMigrations } from "./migrate.js";
import {
  InvalidRestartRequestError,
  clearRestartRequests,
  listRestartRequests,
  requestServiceRestart,
} from "./restart-requests.js";
import { type RoleLogin, deriveAuthLogin } from "./roles.js";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const DATABASE = `restow_db_restart_test_${suffix}`;
const tenantLogin: RoleLogin = {
  name: `restow_rr_app_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};
const installationLogin: RoleLogin = {
  name: `restow_rr_provider_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};

function urlFor(base: string, database: string, login?: RoleLogin): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (login) {
    url.username = login.name;
    url.password = login.password;
  }
  return url.toString();
}

describe.skipIf(!adminUrl)("restart requests", () => {
  let owner: pg.Pool;
  let tenantDb: ReturnType<typeof createDb>;
  let installationDb: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const base = adminUrl as string;
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(`CREATE DATABASE ${DATABASE}`);
    } finally {
      await admin.end();
    }
    const ownerUrl = urlFor(base, DATABASE);
    owner = new pg.Pool({ connectionString: ownerUrl });
    await runMigrations(ownerUrl, {
      roles: { tenant: tenantLogin, installation: installationLogin },
    });
    tenantDb = createDb(urlFor(base, DATABASE, tenantLogin));
    installationDb = createDb(urlFor(base, DATABASE, installationLogin));
  });

  afterAll(async () => {
    await Promise.all([tenantDb?.$client.end(), installationDb?.$client.end()]);
    await owner?.end();
    await dropTestDatabase(adminUrl as string, DATABASE);
    const admin = new pg.Pool({ connectionString: adminUrl as string });
    try {
      await admin.query(`DROP ROLE IF EXISTS ${tenantLogin.name}`);
      await admin.query(`DROP ROLE IF EXISTS ${installationLogin.name}`);
      await admin.query(
        `DROP ROLE IF EXISTS ${deriveAuthLogin(tenantLogin, installationLogin).name}`,
      );
    } finally {
      await admin.end();
    }
  });

  beforeEach(async () => {
    await owner.query("DELETE FROM restart_requests");
  });

  it("refuses the application pool: the requests are installation-level", async () => {
    await expect(listRestartRequests(tenantDb)).rejects.toThrow();
    await expect(
      requestServiceRestart(tenantDb, { service: "worker", reason: "test_reason" }),
    ).rejects.toThrow();
    await expect(clearRestartRequests(tenantDb, "worker")).rejects.toThrow();
  });

  it("records one row per service and reason and lists them oldest first", async () => {
    await requestServiceRestart(installationDb, { service: "worker", reason: "first_reason" });
    await owner.query(
      "UPDATE restart_requests SET requested_at = now() - interval '1 hour' WHERE reason = 'first_reason'",
    );
    await requestServiceRestart(installationDb, { service: "api", reason: "second_reason" });
    await requestServiceRestart(installationDb, { service: "worker", reason: "second_reason" });

    const listed = await listRestartRequests(installationDb);
    expect(listed.map((row) => [row.service, row.reason])).toEqual([
      ["worker", "first_reason"],
      ["api", "second_reason"],
      ["worker", "second_reason"],
    ]);
    expect(listed[0]?.requestedAt).toBeInstanceOf(Date);

    // The same reason again is still one row, with its time moved forward.
    await requestServiceRestart(installationDb, { service: "worker", reason: "first_reason" });
    const again = await listRestartRequests(installationDb);
    expect(again).toHaveLength(3);
    expect(again.at(-1)).toMatchObject({ service: "worker", reason: "first_reason" });
  });

  it("is cleared by the start of the service it names, and by nothing else", async () => {
    await requestServiceRestart(installationDb, { service: "worker", reason: "one" });
    await requestServiceRestart(installationDb, { service: "worker", reason: "two" });
    await requestServiceRestart(installationDb, { service: "scheduler", reason: "one" });

    expect(await clearRestartRequests(installationDb, "api")).toBe(0);
    expect(await clearRestartRequests(installationDb, "worker")).toBe(2);
    const left = await listRestartRequests(installationDb);
    expect(left.map((row) => [row.service, row.reason])).toEqual([["scheduler", "one"]]);
  });

  it("refuses an unknown service and a reason that is not a key, also in the database", async () => {
    await expect(
      requestServiceRestart(installationDb, {
        service: "caddy" as "api",
        reason: "test_reason",
      }),
    ).rejects.toBeInstanceOf(InvalidRestartRequestError);
    for (const reason of ["", "Has Spaces", "1starts_with_digit", "x".repeat(65), "a.b"]) {
      await expect(
        requestServiceRestart(installationDb, { service: "api", reason }),
        reason,
      ).rejects.toBeInstanceOf(InvalidRestartRequestError);
    }
    // The check constraint holds for a writer that skips the function, too.
    await expect(
      owner.query("INSERT INTO restart_requests (service, reason) VALUES ('api', 'Not A Key')"),
    ).rejects.toThrow(/restart_requests_reason_key/);
    expect(await listRestartRequests(installationDb)).toEqual([]);
  });

  it("lets the installation pool read the old manifest table's size, but not truncate it", async () => {
    const bytes = await legacyManifestBytes(installationDb.$client);
    expect(bytes).not.toBeNull();
    expect(bytes).toBeGreaterThanOrEqual(0);
    // Truncating stays with the owner: the running api opens an owner connection for it.
    await expect(installationDb.$client.query("TRUNCATE manifest_objects")).rejects.toThrow(
      /permission denied|must be owner/,
    );
  });
});
