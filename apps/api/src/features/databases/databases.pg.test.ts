/**
 * The module "Databases", stage D1, against Postgres (docs/DATABASES.md 3, 4, 9, 10): a test
 * through the Restow server and through an agent, saving a connection from its test, credentials
 * sealed and never in an answer or the audit log, the network protection and the approval of a
 * provider admin, Restow's own database refused, a changed certificate or instance red until an
 * admin confirms, the databases of a connection with their identity, and the suggestions from an
 * agent's inventory. The server's probe is a stand-in here; the probe itself runs against a real
 * PostgreSQL in packages/core (probe/postgres.pg.test.ts).
 *
 * Needs RESTOW_TEST_DATABASE_URL (a superuser); skipped otherwise.
 */
import { randomUUID } from "node:crypto";
import type { DbProbeResult, DbProbeSpec } from "@restow/core";
import {
  auditLog,
  databaseConnections,
  databaseProbes,
  databases,
  endpoints,
  endpointTasks,
  secrets,
  settings,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";
import type { DatabaseContext } from "./service.js";

const DATABASE = "restow_api_databases_test";
const PASSWORD = "Pg-s3cret,with=comma";
const USER = "restow_backup";
const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(
  ":",
);
const OTHER_FINGERPRINT = Array.from({ length: 32 }, () => "AB").join(":");
const OWN_IDENTIFIER = "7000000000000000001";

type Service = typeof import("./service.js");
type Shared = typeof import("../../db.js");

const HOSTS: Record<string, string[]> = {
  "db.example.test": ["93.184.216.34"],
  "pg.lan": ["192.168.10.20"],
  "metadata.example.test": ["169.254.169.254"],
};

function pgResult(overrides: Partial<DbProbeResult> = {}): DbProbeResult {
  return {
    engine: "postgresql",
    port: 5432,
    serverVersion: "16.4",
    tls: {
      offered: true,
      used: true,
      fingerprintSha256: FINGERPRINT,
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
      systemIdentifier: "7300000000000000042",
      databases: [
        { name: "app", oid: "16384", allowConnections: true, canConnect: true, sizeBytes: 81920 },
        { name: "shop", oid: "16385", allowConnections: true, canConnect: true, sizeBytes: 4096 },
        { name: "template1", oid: "1", allowConnections: true, canConnect: true, sizeBytes: 1 },
      ],
    },
    durationMs: 50,
    ...overrides,
  };
}

/** The PostgreSQL facts of {@link pgResult}, to change one of them. */
function pgFacts(): NonNullable<DbProbeResult["postgresql"]> {
  const facts = pgResult().postgresql;
  if (!facts) {
    throw new Error("no facts");
  }
  return facts;
}

describe.skipIf(!testDatabaseAdminUrl)("database connections of a tenant against Postgres", () => {
  let fixture: EndpointFixture;
  let service: Service;
  let shared: Shared;
  let agentId: string;
  const probes: {
    spec: DbProbeSpec;
    allowPrivateNetworks: boolean;
    approvedAddresses: readonly string[];
    forbiddenTargets: readonly { address: string; port: number }[];
  }[] = [];
  let nextResult: (spec: DbProbeSpec) => DbProbeResult = () => pgResult();

  const resolve = async (host: string) => {
    const found = HOSTS[host];
    if (!found) throw new Error("ENOTFOUND");
    return found;
  };
  const tenantAdmin = (): DatabaseContext => ({
    actor: { label: "admin@contoso.example", userId: fixture.adminId, ip: "192.0.2.1" },
    isProviderAdmin: false,
    resolve,
    privateNetworksAllowed: false,
    ownSystemIdentifier: async () => OWN_IDENTIFIER,
    ownDatabaseTargets: async () => [{ address: "10.9.9.9", port: 5432 }],
    probe: async (spec, options) => {
      probes.push({
        spec,
        allowPrivateNetworks: options.allowPrivateNetworks,
        approvedAddresses: options.approvedAddresses ?? [],
        forbiddenTargets: options.forbiddenTargets ?? [],
      });
      return nextResult(spec);
    },
  });
  const providerAdmin = (): DatabaseContext => ({
    ...tenantAdmin(),
    actor: { label: "operator@provider.example", userId: fixture.adminId, ip: "192.0.2.2" },
    isProviderAdmin: true,
  });

  const testInput = (
    address: string,
    executor: { kind: "server" } | { kind: "agent"; endpointId: string } = { kind: "server" },
  ) => ({
    address,
    user: USER,
    password: PASSWORD,
    authMethod: "password" as const,
    executor,
    allowUnencrypted: false,
  });

  async function auditOf(action: string) {
    return fixture.db.select().from(auditLog).where(eq(auditLog.action, action));
  }

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    shared = await import("../../db.js");
    service = await import("./service.js");
    await fixture.db.insert(settings).values({}).onConflictDoNothing();
    const [agent] = await fixture.db
      .insert(endpoints)
      .values({
        tenantId: fixture.tenantId,
        hostname: "db-bridge",
        os: "linux",
        arch: "amd64",
        profile: "server",
        secretHash: "x",
        config: {} as never,
        lastSeenAt: new Date(),
        settings: { agent: { capabilities: ["db_runner_v1"] } },
      })
      .returning();
    agentId = agent?.id as string;
  }, 120_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  beforeEach(async () => {
    probes.length = 0;
    nextResult = () => pgResult();
    service.resetDatabaseProbeLimit();
    await fixture.db.delete(databaseConnections);
    await fixture.db.delete(databaseProbes);
    await fixture.db.delete(endpointTasks);
  });

  it("tests through the server, saves from the test and never answers with the credentials [DB-002]", async () => {
    const probe = await service.testConnection(
      shared.db,
      fixture.tenantId,
      testInput("postgresql://db.example.test/app"),
      tenantAdmin(),
    );
    expect(probe).toMatchObject({
      status: "done",
      engine: "postgresql",
      address: "db.example.test",
      tls: { used: true, fingerprintSha256: FINGERPRINT },
      identityKnown: true,
    });
    expect(probe.rights?.capabilities.backup.state).toBe("granted");
    expect(probe.rights?.capabilities.verifyOnInstance.state).toBe("missing");
    expect(probe.databases.map((database) => database.name)).toEqual(["app", "shop"]);
    // The probe got the credentials and the database of the URL, the network judged closed.
    expect(probes[0]).toMatchObject({
      spec: { host: "db.example.test", database: "app", user: USER, password: PASSWORD },
      allowPrivateNetworks: false,
    });
    expect(JSON.stringify(probe)).not.toContain(PASSWORD);
    const [stored] = await fixture.db
      .select()
      .from(databaseProbes)
      .where(eq(databaseProbes.id, probe.id));
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect(JSON.stringify(stored)).not.toContain(USER);

    const created = await service.createConnection(
      shared.db,
      fixture.tenantId,
      {
        probeId: probe.id,
        name: "ERP",
        user: USER,
        password: PASSWORD,
        allowUnencrypted: false,
        mode: "backup",
        schedule: null,
        selection: null,
      },
      tenantAdmin(),
    );
    expect(created).toMatchObject({
      name: "ERP",
      engine: "postgresql",
      address: "db.example.test:5432",
      executor: { kind: "server", endpointId: null, online: null },
      credential: "set",
      tls: { fingerprint: FINGERPRINT, confirmedBy: "admin@contoso.example" },
      schedule: { kind: "interval", intervalMinutes: 60 },
      identityKnown: true,
      state: "ok",
      databaseCount: 2,
    });
    expect(JSON.stringify(created)).not.toContain(PASSWORD);
    const [row] = await fixture.db
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, created.id));
    expect(row?.instanceKey).toBe("postgresql:7300000000000000042");
    const [secret] = await fixture.db
      .select()
      .from(secrets)
      .where(eq(secrets.id, row?.credentialSecretId as string));
    expect(secret?.kind).toBe("database_credentials");
    expect(secret?.ciphertext).not.toContain(PASSWORD);
    const entries = await auditOf("database_connection.created");
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0]?.details)).not.toContain(PASSWORD);
    expect(JSON.stringify(entries[0]?.details)).not.toContain(USER);
    const listed = await service.listConnections(shared.db, fixture.tenantId);
    expect(JSON.stringify(listed)).not.toContain(PASSWORD);
    const detail = await service.getConnection(shared.db, fixture.tenantId, created.id);
    expect(JSON.stringify(detail)).not.toContain(PASSWORD);
    expect(detail.databases.map((database) => [database.name, database.rating])).toEqual([
      ["app", "not_protected"],
      ["shop", "not_protected"],
    ]);
  });

  it("keeps a tenant within its connections on the Restow server, at saving and at a move [DB-004]", async () => {
    const ctx = (): DatabaseContext => ({ ...tenantAdmin(), serverConnectionsPerTenant: 1 });
    const save = async (name: string, executor: Parameters<typeof testInput>[1]) => {
      const probe = await service.testConnection(
        shared.db,
        fixture.tenantId,
        testInput("postgresql://db.example.test/app", executor),
        ctx(),
      );
      if (executor?.kind === "agent") {
        const agent = { endpointId: agentId, tenantId: fixture.tenantId };
        await service.agentFetchProbe(shared.db, agent, probe.id);
        await service.agentFinishProbe(shared.db, agent, probe.id, pgResult(), {
          ownSystemIdentifier: async () => OWN_IDENTIFIER,
        });
      }
      return service.createConnection(
        shared.db,
        fixture.tenantId,
        {
          probeId: probe.id,
          name,
          user: USER,
          password: PASSWORD,
          allowUnencrypted: false,
          mode: "backup",
        },
        ctx(),
      );
    };
    await save("ERP", { kind: "server" });
    const limit = { status: 422, type: "urn:restow:problem:database-server-connection-limit" };
    await expect(save("Shop", { kind: "server" })).rejects.toMatchObject(limit);
    // Through an agent it is saved; moved to the server it is refused, and stays on the agent.
    const shop = await save("Shop", { kind: "agent", endpointId: agentId });
    await expect(
      service.updateConnection(
        shared.db,
        fixture.tenantId,
        shop.id,
        { executor: { kind: "server", endpointId: null }, password: PASSWORD },
        ctx(),
      ),
    ).rejects.toMatchObject(limit);
    const [row] = await fixture.db
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, shop.id));
    expect(row?.executorKind).toBe("agent");
  });

  it("refuses private networks to a tenant admin and records a provider admin's approval [DB-003]", async () => {
    await expect(
      service.testConnection(shared.db, fixture.tenantId, testInput("pg.lan:5432"), tenantAdmin()),
    ).rejects.toMatchObject({ status: 422, extensions: { reason: "db_private_network" } });
    await expect(
      service.testConnection(
        shared.db,
        fixture.tenantId,
        testInput("postgres:5432"),
        tenantAdmin(),
      ),
    ).rejects.toMatchObject({ status: 422, extensions: { reason: "db_private_network" } });
    for (const address of ["169.254.169.254:5432", "metadata.example.test", "[fe80::1]:5432"]) {
      await expect(
        service.testConnection(shared.db, fixture.tenantId, testInput(address), providerAdmin()),
      ).rejects.toMatchObject({ status: 422, extensions: { reason: "db_forbidden_address" } });
    }
    expect(probes).toHaveLength(0);

    // A test that does not say where it signed in cannot be saved with an approval.
    const unbound = await service.testConnection(
      shared.db,
      fixture.tenantId,
      testInput("pg.lan:5432"),
      providerAdmin(),
    );
    await expect(
      service.createConnection(
        shared.db,
        fixture.tenantId,
        { probeId: unbound.id, name: "LAN", allowUnencrypted: false, mode: "backup" },
        providerAdmin(),
      ),
    ).rejects.toMatchObject({ status: 422, type: "urn:restow:problem:database-probe-required" });

    probes.length = 0;
    nextResult = () => pgResult({ connectedAddress: "192.168.10.20" });
    const probe = await service.testConnection(
      shared.db,
      fixture.tenantId,
      testInput("pg.lan:5432"),
      providerAdmin(),
    );
    expect(probes[0]?.allowPrivateNetworks).toBe(true);
    const created = await service.createConnection(
      shared.db,
      fixture.tenantId,
      {
        probeId: probe.id,
        name: "LAN",
        user: USER,
        password: PASSWORD,
        allowUnencrypted: false,
        mode: "backup",
        schedule: { intervalMinutes: 15, timeZone: "Europe/Berlin" },
        selection: null,
      },
      providerAdmin(),
    );
    expect(created.privateNetworkApproval).toMatchObject({
      by: "operator@provider.example",
      addresses: ["192.168.10.20"],
    });
    expect(await auditOf("database_connection.private_network_approved")).toHaveLength(1);
    // The approval lets the stored connection reach the address it was given for (and no other
    // private address), also when a tenant admin tests it.
    probes.length = 0;
    await service.testStoredConnection(shared.db, fixture.tenantId, created.id, tenantAdmin());
    expect(probes[0]).toMatchObject({
      allowPrivateNetworks: false,
      approvedAddresses: ["192.168.10.20"],
      forbiddenTargets: [{ address: "10.9.9.9", port: 5432 }],
      spec: { pinnedFingerprintSha256: FINGERPRINT },
    });
    // A tenant admin's test changes nothing about the approval.
    nextResult = () => pgResult({ connectedAddress: "192.168.10.21" });
    await service.testStoredConnection(shared.db, fixture.tenantId, created.id, tenantAdmin());
    const kept = await service.getConnection(shared.db, fixture.tenantId, created.id);
    expect(kept.privateNetworkApproval?.addresses).toEqual(["192.168.10.20"]);
    // A provider admin's good test renews it for the address that test signed in on, audited.
    await service.testStoredConnection(shared.db, fixture.tenantId, created.id, providerAdmin());
    const renewed = await service.getConnection(shared.db, fixture.tenantId, created.id);
    expect(renewed.privateNetworkApproval?.addresses).toEqual(["192.168.10.21"]);
    const approvals = await auditOf("database_connection.private_network_approved");
    expect(approvals).toHaveLength(2);
    expect(approvals.map((row) => row.details)).toContainEqual(
      expect.objectContaining({ addresses: ["192.168.10.21"] }),
    );
  });

  it("refuses the server's tests while it cannot tell where its own database is", async () => {
    await expect(
      service.testConnection(shared.db, fixture.tenantId, testInput("db.example.test"), {
        ...tenantAdmin(),
        ownDatabaseTargets: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toMatchObject({
      status: 503,
      type: "urn:restow:problem:database-own-database-unknown",
    });
    expect(probes).toHaveLength(0);
    const rows = await fixture.db.select().from(databaseProbes);
    expect(rows).toEqual([]);
  });

  it("refuses Restow's own database and a server without TLS unless allowed", async () => {
    nextResult = () => pgResult({ postgresql: { ...pgFacts(), systemIdentifier: OWN_IDENTIFIER } });
    const own = await service.testConnection(
      shared.db,
      fixture.tenantId,
      testInput("db.example.test"),
      tenantAdmin(),
    );
    expect(own.error?.code).toBe("db_target_is_restow");
    expect(own.databases).toEqual([]);
    await expect(
      service.createConnection(
        shared.db,
        fixture.tenantId,
        {
          probeId: own.id,
          user: USER,
          password: PASSWORD,
          allowUnencrypted: false,
          mode: "backup",
        },
        tenantAdmin(),
      ),
    ).rejects.toMatchObject({ status: 422 });

    nextResult = () =>
      pgResult({
        tls: {
          offered: false,
          used: false,
          fingerprintSha256: null,
          subject: null,
          issuer: null,
          notAfter: null,
        },
      });
    const plain = await service.testConnection(
      shared.db,
      fixture.tenantId,
      testInput("db.example.test"),
      tenantAdmin(),
    );
    await expect(
      service.createConnection(
        shared.db,
        fixture.tenantId,
        {
          probeId: plain.id,
          user: USER,
          password: PASSWORD,
          allowUnencrypted: false,
          mode: "backup",
        },
        tenantAdmin(),
      ),
    ).rejects.toMatchObject({ status: 422, type: "urn:restow:problem:database-tls-missing" });
    const saved = await service.createConnection(
      shared.db,
      fixture.tenantId,
      { probeId: plain.id, user: USER, password: PASSWORD, allowUnencrypted: true, mode: "backup" },
      tenantAdmin(),
    );
    expect(saved.notices).toContain("db_unencrypted");
  });

  it("refuses SQLite and SQL Server for the server executor, and the socket sign-in", async () => {
    await expect(
      service.testConnection(
        shared.db,
        fixture.tenantId,
        testInput("/var/lib/app.db"),
        tenantAdmin(),
      ),
    ).rejects.toMatchObject({ status: 422, type: "urn:restow:problem:database-executor" });
    await expect(
      service.testConnection(
        shared.db,
        fixture.tenantId,
        testInput("sqlserver://db.example.test"),
        tenantAdmin(),
      ),
    ).rejects.toMatchObject({ status: 422, type: "urn:restow:problem:database-executor" });
    await expect(
      service.testConnection(
        shared.db,
        fixture.tenantId,
        { ...testInput("localhost:5432"), authMethod: "socket" },
        tenantAdmin(),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("runs a test through an agent: one task, the credentials fetched once and deleted with the result", async () => {
    const pending = await service.testConnection(
      shared.db,
      fixture.tenantId,
      testInput("10.0.0.5:5432", { kind: "agent", endpointId: agentId }),
      tenantAdmin(),
    );
    // An agent in the customer's network is no case for the server's network protection.
    expect(pending).toMatchObject({
      status: "pending",
      executor: { kind: "agent", endpointId: agentId },
    });
    const tasks = await fixture.db
      .select()
      .from(endpointTasks)
      .where(eq(endpointTasks.endpointId, agentId));
    expect(tasks).toMatchObject([{ kind: "db_probe", params: { probeId: pending.id } }]);
    const [row] = await fixture.db
      .select()
      .from(databaseProbes)
      .where(eq(databaseProbes.id, pending.id));
    expect(row?.credentialSecretId).toBeTruthy();

    const agent = { endpointId: agentId, tenantId: fixture.tenantId };
    const spec = await service.agentFetchProbe(shared.db, agent, pending.id);
    expect(spec).toMatchObject({ host: "10.0.0.5", port: 5432, user: USER, password: PASSWORD });
    await expect(service.agentFetchProbe(shared.db, agent, pending.id)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      service.agentFetchProbe(
        shared.db,
        { endpointId: randomUUID(), tenantId: fixture.tenantId },
        pending.id,
      ),
    ).rejects.toMatchObject({ status: 404 });

    // The agent's message carries the password; the server cleans it once more.
    await service.agentFinishProbe(
      shared.db,
      agent,
      pending.id,
      pgResult({
        login: "failed",
        error: { code: "db_login_failed", message: `password ${PASSWORD} rejected for ${USER}` },
      }),
      { ownSystemIdentifier: async () => OWN_IDENTIFIER },
    );
    const done = await service.getProbe(shared.db, fixture.tenantId, pending.id, {});
    expect(done).toMatchObject({
      status: "done",
      login: "failed",
      error: { code: "db_login_failed" },
    });
    expect(done.error?.message).not.toContain(PASSWORD);
    expect(done.error?.message).not.toContain(USER);
    // Unsaved settings keep the tested credentials a short while, for saving exactly them.
    const kept = () =>
      fixture.db
        .select()
        .from(secrets)
        .where(eq(secrets.id, row?.credentialSecretId as string));
    expect(await kept()).toHaveLength(1);
    await service.getProbe(shared.db, fixture.tenantId, pending.id, {
      now: new Date(Date.now() + 31 * 60 * 1000),
    });
    expect(await kept()).toEqual([]);
  });

  it("turns a stored connection red on another certificate or instance until an admin confirms", async () => {
    const probe = await service.testConnection(
      shared.db,
      fixture.tenantId,
      testInput("db.example.test"),
      tenantAdmin(),
    );
    const created = await service.createConnection(
      shared.db,
      fixture.tenantId,
      {
        probeId: probe.id,
        user: USER,
        password: PASSWORD,
        allowUnencrypted: false,
        mode: "backup",
      },
      tenantAdmin(),
    );
    nextResult = () =>
      pgResult({ tls: { ...pgResult().tls, fingerprintSha256: OTHER_FINGERPRINT } });
    const changed = await service.testStoredConnection(
      shared.db,
      fixture.tenantId,
      created.id,
      tenantAdmin(),
    );
    // The stored test used the stored credentials.
    expect(probes.at(-1)?.spec).toMatchObject({
      user: USER,
      password: PASSWORD,
      engine: "postgresql",
    });
    let detail = await service.getConnection(shared.db, fixture.tenantId, created.id);
    expect(detail).toMatchObject({
      state: "red",
      lastCheck: { errorCode: "db_tls_changed", tlsFingerprintSeen: OTHER_FINGERPRINT },
    });
    detail = await service.updateConnection(
      shared.db,
      fixture.tenantId,
      created.id,
      { confirm: { probeId: changed.id, tls: true, instance: false } },
      tenantAdmin(),
    );
    expect(detail).toMatchObject({ state: "ok", tls: { fingerprint: OTHER_FINGERPRINT } });
    expect(await auditOf("database_connection.tls_confirmed")).toHaveLength(1);

    // Another instance under the address: red; confirmed, the old databases keep their history.
    nextResult = () =>
      pgResult({
        tls: { ...pgResult().tls, fingerprintSha256: OTHER_FINGERPRINT },
        postgresql: { ...pgFacts(), systemIdentifier: "7400000000000000077" },
      });
    const moved = await service.testStoredConnection(
      shared.db,
      fixture.tenantId,
      created.id,
      tenantAdmin(),
    );
    detail = await service.getConnection(shared.db, fixture.tenantId, created.id);
    expect(detail.lastCheck?.errorCode).toBe("db_instance_changed");
    detail = await service.updateConnection(
      shared.db,
      fixture.tenantId,
      created.id,
      { confirm: { probeId: moved.id, tls: false, instance: true } },
      tenantAdmin(),
    );
    expect(detail.state).toBe("ok");
    const rows = await fixture.db
      .select()
      .from(databases)
      .where(eq(databases.connectionId, created.id));
    expect(rows.filter((r) => r.droppedAt === null)).toHaveLength(2);
    expect(rows.filter((r) => r.droppedAt !== null)).toHaveLength(2);
    expect(await auditOf("database_connection.instance_confirmed")).toHaveLength(1);
  });

  it("keeps a database created again under its name as another one", async () => {
    const probe = await service.testConnection(
      shared.db,
      fixture.tenantId,
      testInput("db.example.test"),
      tenantAdmin(),
    );
    const created = await service.createConnection(
      shared.db,
      fixture.tenantId,
      {
        probeId: probe.id,
        user: USER,
        password: PASSWORD,
        allowUnencrypted: false,
        mode: "backup",
      },
      tenantAdmin(),
    );
    nextResult = () =>
      pgResult({
        postgresql: {
          ...pgFacts(),
          databases: [
            { name: "app", oid: "20001", allowConnections: true, canConnect: true, sizeBytes: 1 },
            { name: "shop", oid: "16385", allowConnections: true, canConnect: true, sizeBytes: 1 },
          ],
        },
      });
    await service.testStoredConnection(shared.db, fixture.tenantId, created.id, tenantAdmin());
    const rows = await fixture.db
      .select()
      .from(databases)
      .where(and(eq(databases.connectionId, created.id), eq(databases.name, "app")));
    expect(rows.map((r) => [r.identity, r.droppedAt === null]).sort()).toEqual([
      ["16384", false],
      ["20001", true],
    ]);
  });

  it("replaces credentials only on request, audited, and deletes them with the connection", async () => {
    const probe = await service.testConnection(
      shared.db,
      fixture.tenantId,
      testInput("db.example.test"),
      tenantAdmin(),
    );
    const created = await service.createConnection(
      shared.db,
      fixture.tenantId,
      {
        probeId: probe.id,
        user: USER,
        password: PASSWORD,
        allowUnencrypted: false,
        mode: "backup",
      },
      tenantAdmin(),
    );
    await service.updateConnection(
      shared.db,
      fixture.tenantId,
      created.id,
      { password: "new-one" },
      tenantAdmin(),
    );
    expect(await auditOf("database_connection.credentials_changed")).toHaveLength(1);
    await service.testStoredConnection(shared.db, fixture.tenantId, created.id, tenantAdmin());
    expect(probes.at(-1)?.spec).toMatchObject({ user: USER, password: "new-one" });
    const [row] = await fixture.db
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, created.id));
    await service.deleteConnection(shared.db, fixture.tenantId, created.id, tenantAdmin());
    expect(
      await fixture.db
        .select()
        .from(secrets)
        .where(eq(secrets.id, row?.credentialSecretId as string)),
    ).toEqual([]);
    expect(await auditOf("database_connection.deleted")).not.toHaveLength(0);
  });

  it("offers what an agent's inventory found and no connection covers yet", async () => {
    const endpointsService = await import("../endpoints/agent-service.js");
    const schemas = await import("../endpoints/schemas.js");
    const input = schemas.heartbeatSchema.parse({
      agentVersion: "0.6.0",
      osVersion: "Debian 12",
      state: "idle",
      nextRunAt: null,
      configVersion: null,
      hooks: "off",
      capabilities: ["db_runner_v1"],
      databaseInventory: {
        collectedAt: "2026-11-17T10:00:00Z",
        instances: [
          {
            engine: "postgresql",
            source: "pg_lsclusters",
            name: "16/main",
            version: "16",
            port: 5432,
            socket: "/var/run/postgresql",
            container: null,
            running: true,
          },
          {
            engine: "mariadb",
            source: "docker",
            name: "shop-db",
            version: "11.4",
            port: null,
            socket: null,
            container: "shop-db",
            running: true,
          },
          { engine: "oracle", source: "systemd", name: "ignored" },
        ],
      },
    });
    await endpointsService.heartbeat(
      {
        endpointId: agentId,
        tenantId: fixture.tenantId,
        hostname: "db-bridge",
        profile: "server",
        os: "linux",
        ip: null,
      },
      input,
    );
    const { suggestions } = await service.listSuggestions(shared.db, fixture.tenantId);
    expect(suggestions).toMatchObject([
      {
        engine: "postgresql",
        name: "16/main",
        hostname: "db-bridge",
        prefill: { address: "localhost:5432", authMethod: "socket", endpointId: agentId },
      },
      { engine: "mariadb", name: "shop-db", prefill: null },
    ]);
    const runners = await service.listRunners(shared.db, fixture.tenantId);
    expect(runners.runners).toMatchObject([
      { endpointId: agentId, hostname: "db-bridge", online: true },
    ]);
    const tasks = await fixture.db
      .select()
      .from(endpointTasks)
      .where(eq(endpointTasks.kind, "db_probe"));
    expect(tasks).toEqual([]);
  });
});
