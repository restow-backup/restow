/**
 * Postgres-backed proof of what a database connection's stored credentials may reach, and of the
 * limits of "Test connection" (docs/DATABASES.md 3.2, 4.2, 10):
 *
 * - a stored password only ever travels to the executor it was stored for: moving the connection
 *   to another executor needs the password again in the same change (audited);
 * - saving a connection keeps exactly the credentials its test used;
 * - the tests of a tenant are counted from their rows (a restart, a refused address or a deleted
 *   connection does not reset the count), and the server runs only a few of them at once.
 *
 * Needs RESTOW_TEST_DATABASE_URL (a superuser); skipped otherwise.
 */
import type { DbProbeResult, DbProbeSpec } from "@restow/core";
import { auditLog, databaseConnections, databaseProbes, endpoints, settings } from "@restow/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";
import type { DatabaseContext } from "./service.js";

const DATABASE = "restow_api_databases_guard_test";
const USER = "restow_backup";
const PASSWORD = "Pg-s3cret,tested";

type Service = typeof import("./service.js");
type Shared = typeof import("../../db.js");
type Secrets = typeof import("../../lib/secrets.js");

function okResult(): DbProbeResult {
  return {
    engine: "postgresql",
    port: 5432,
    serverVersion: "16.4",
    tls: {
      offered: true,
      used: true,
      fingerprintSha256: Array.from({ length: 32 }, () => "CD").join(":"),
      subject: "CN=db.example.test",
      issuer: "CN=db.example.test",
      notAfter: "2027-11-17T00:00:00.000Z",
    },
    login: "ok",
    error: null,
    postgresql: {
      versionNum: 160004,
      version: "PostgreSQL 16.4",
      currentUser: USER,
      superuser: false,
      createDb: false,
      replication: false,
      readAllData: true,
      systemIdentifier: "7300000000000000099",
      databases: [
        { name: "app", oid: "16384", allowConnections: true, canConnect: true, sizeBytes: 1 },
      ],
    },
    durationMs: 5,
  };
}

describe.skipIf(!testDatabaseAdminUrl)(
  "a database connection's credentials go only where they were tested and stored",
  () => {
    let fixture: EndpointFixture;
    let service: Service;
    let shared: Shared;
    let secretStore: Secrets;
    let agentA: string;
    let agentB: string;
    const specs: DbProbeSpec[] = [];
    let gate: Promise<void> | null = null;

    const admin = (): DatabaseContext => ({
      actor: { label: "admin@contoso.example", userId: fixture.adminId, ip: "192.0.2.1" },
      isProviderAdmin: false,
      privateNetworksAllowed: false,
      resolve: async (host) => {
        if (host === "db.example.test") return ["93.184.216.34"];
        throw new Error("ENOTFOUND");
      },
      ownSystemIdentifier: async () => null,
      ownDatabaseTargets: async () => [],
      probe: async (spec) => {
        specs.push(spec);
        if (gate) await gate;
        return okResult();
      },
    });

    const testInput = (password = PASSWORD) => ({
      address: "postgresql://db.example.test/app",
      user: USER,
      password,
      authMethod: "password" as const,
      executor: { kind: "server" as const },
      allowUnencrypted: false,
    });

    async function storedCredentials(connectionId: string) {
      const [row] = await fixture.db
        .select()
        .from(databaseConnections)
        .where(eq(databaseConnections.id, connectionId));
      const plain = await secretStore.readSecret(fixture.db, {
        id: row?.credentialSecretId as string,
        tenantId: fixture.tenantId,
      });
      return { row, credentials: plain ? JSON.parse(plain) : null };
    }

    async function saved(password = PASSWORD) {
      const probe = await service.testConnection(
        shared.db,
        fixture.tenantId,
        testInput(password),
        admin(),
      );
      return service.createConnection(
        shared.db,
        fixture.tenantId,
        { probeId: probe.id, allowUnencrypted: false, mode: "backup" },
        admin(),
      );
    }

    beforeAll(async () => {
      fixture = await startFixture(DATABASE);
      shared = await import("../../db.js");
      service = await import("./service.js");
      secretStore = await import("../../lib/secrets.js");
      await fixture.db.insert(settings).values({}).onConflictDoNothing();
      const ids: string[] = [];
      for (const hostname of ["db-bridge-a", "db-bridge-b"]) {
        const [agent] = await fixture.db
          .insert(endpoints)
          .values({
            tenantId: fixture.tenantId,
            hostname,
            os: "linux",
            arch: "amd64",
            profile: "server",
            secretHash: "x",
            config: {} as never,
            lastSeenAt: new Date(),
            settings: { agent: { capabilities: ["db_runner_v1"] } },
          })
          .returning();
        ids.push(agent?.id as string);
      }
      [agentA, agentB] = ids as [string, string];
    }, 120_000);

    afterAll(async () => {
      await fixture?.cleanup();
    });

    beforeEach(async () => {
      specs.length = 0;
      gate = null;
      service.resetDatabaseProbeLimit();
      await fixture.db.delete(databaseConnections);
      await fixture.db.delete(databaseProbes);
    });

    it("moves stored credentials to another executor only with the password entered again", async () => {
      const connection = await saved();
      const before = await storedCredentials(connection.id);
      expect(before.credentials).toEqual({ user: USER, password: PASSWORD });

      // Server -> agent, and agent -> another agent: refused without the password.
      await expect(
        service.updateConnection(
          shared.db,
          fixture.tenantId,
          connection.id,
          { executor: { kind: "agent", endpointId: agentA } },
          admin(),
        ),
      ).rejects.toMatchObject({
        status: 422,
        type: "urn:restow:problem:database-credentials-required",
      });
      // A new user alone is not enough either.
      await expect(
        service.updateConnection(
          shared.db,
          fixture.tenantId,
          connection.id,
          { executor: { kind: "agent", endpointId: agentA }, user: "someone_else" },
          admin(),
        ),
      ).rejects.toMatchObject({ status: 422 });
      const unchanged = await storedCredentials(connection.id);
      expect(unchanged.row).toMatchObject({ executorKind: "server", executorEndpointId: null });
      expect(unchanged.credentials).toEqual({ user: USER, password: PASSWORD });

      await service.updateConnection(
        shared.db,
        fixture.tenantId,
        connection.id,
        { executor: { kind: "agent", endpointId: agentA }, password: "Entered-again-1" },
        admin(),
      );
      const moved = await storedCredentials(connection.id);
      expect(moved.row).toMatchObject({ executorKind: "agent", executorEndpointId: agentA });
      expect(moved.credentials).toEqual({ user: USER, password: "Entered-again-1" });
      const changed = await fixture.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "database_connection.credentials_changed"),
            eq(auditLog.target, connection.id),
          ),
        );
      expect(changed).toHaveLength(1);
      expect(changed[0]?.details).toMatchObject({ executor: "agent" });
      expect(JSON.stringify(changed[0]?.details)).not.toContain("Entered-again-1");

      await expect(
        service.updateConnection(
          shared.db,
          fixture.tenantId,
          connection.id,
          { executor: { kind: "agent", endpointId: agentB } },
          admin(),
        ),
      ).rejects.toMatchObject({ status: 422 });
      // The same executor again, or a change of something else, needs no password.
      await service.updateConnection(
        shared.db,
        fixture.tenantId,
        connection.id,
        { executor: { kind: "agent", endpointId: agentA }, name: "Renamed" },
        admin(),
      );
      expect((await storedCredentials(connection.id)).row).toMatchObject({
        name: "Renamed",
        executorEndpointId: agentA,
      });
    });

    it("saves exactly the credentials the test used", async () => {
      const probe = await service.testConnection(shared.db, fixture.tenantId, testInput(), admin());
      await expect(
        service.createConnection(
          shared.db,
          fixture.tenantId,
          {
            probeId: probe.id,
            user: USER,
            password: "never-tested",
            allowUnencrypted: false,
            mode: "backup",
          },
          admin(),
        ),
      ).rejects.toMatchObject({ status: 422, type: "urn:restow:problem:database-probe-required" });
      await expect(
        service.createConnection(
          shared.db,
          fixture.tenantId,
          { probeId: probe.id, user: "other", allowUnencrypted: false, mode: "backup" },
          admin(),
        ),
      ).rejects.toMatchObject({ status: 422 });
      const connection = await service.createConnection(
        shared.db,
        fixture.tenantId,
        {
          probeId: probe.id,
          user: USER,
          password: PASSWORD,
          allowUnencrypted: false,
          mode: "backup",
        },
        admin(),
      );
      expect((await storedCredentials(connection.id)).credentials).toEqual({
        user: USER,
        password: PASSWORD,
      });
      // The test's own copy is gone once saved.
      const [probeRow] = await fixture.db
        .select()
        .from(databaseProbes)
        .where(eq(databaseProbes.id, probe.id));
      expect(probeRow?.credentialSecretId).toBeNull();

      // A test older than the time its credentials are kept cannot be saved, even before
      // anything cleaned them up.
      const stale = await service.testConnection(shared.db, fixture.tenantId, testInput(), admin());
      await expect(
        service.createConnection(
          shared.db,
          fixture.tenantId,
          { probeId: stale.id, allowUnencrypted: false, mode: "backup" },
          { ...admin(), now: new Date(Date.now() + 31 * 60 * 1000) },
        ),
      ).rejects.toMatchObject({ status: 422, type: "urn:restow:problem:database-probe-required" });

      // A test whose credentials are no longer kept cannot be saved.
      const old = await service.testConnection(shared.db, fixture.tenantId, testInput(), admin());
      await service.getProbe(shared.db, fixture.tenantId, old.id, {
        now: new Date(Date.now() + 31 * 60 * 1000),
      });
      await expect(
        service.createConnection(
          shared.db,
          fixture.tenantId,
          { probeId: old.id, allowUnencrypted: false, mode: "backup" },
          admin(),
        ),
      ).rejects.toMatchObject({ status: 422, type: "urn:restow:problem:database-probe-required" });
    });

    it("counts tests from their rows, a refused address and a deleted connection included", async () => {
      // A refused address takes its slot before it is judged.
      for (let index = 0; index < 20; index += 1) {
        await expect(
          service.testConnection(
            shared.db,
            fixture.tenantId,
            { ...testInput(), address: "10.20.30.40:5432" },
            admin(),
          ),
        ).rejects.toMatchObject({ status: 422 });
      }
      const connection = await saved();
      for (let index = 0; index < 8; index += 1) {
        await service.testStoredConnection(shared.db, fixture.tenantId, connection.id, admin());
      }
      await service.deleteConnection(shared.db, fixture.tenantId, connection.id, admin());
      // As after a restart of the api: the count lives in the database.
      service.resetDatabaseProbeLimit();
      await service.testConnection(shared.db, fixture.tenantId, testInput(), admin());
      await expect(
        service.testConnection(shared.db, fixture.tenantId, testInput(), admin()),
      ).rejects.toMatchObject({ status: 429, type: "urn:restow:problem:database-probe-limit" });
      expect(specs).toHaveLength(10);
    });

    it("runs only a few tests of the Restow server at once", async () => {
      let open: () => void = () => undefined;
      gate = new Promise((resolve) => {
        open = resolve;
      });
      const first = service.testConnection(shared.db, fixture.tenantId, testInput(), admin());
      const second = service.testConnection(shared.db, fixture.tenantId, testInput(), admin());
      await expect.poll(() => specs.length).toBe(2);
      await expect(
        service.testConnection(shared.db, fixture.tenantId, testInput(), admin()),
      ).rejects.toMatchObject({ status: 429, type: "urn:restow:problem:database-probe-busy" });
      open();
      await Promise.all([first, second]);
      gate = null;
      await service.testConnection(shared.db, fixture.tenantId, testInput(), admin());
      expect(specs).toHaveLength(3);
    });
  },
);
