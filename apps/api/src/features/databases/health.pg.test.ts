/**
 * Health checks of the module "Databases", stage D2, against Postgres (docs/DATABASES.md 8, 9): an
 * agent gets one `db_health` task per heartbeat window for the connections it runs, fetches the
 * checks once with the credentials and the confirmed certificate, and posts what it found; the
 * server judges every sample, cleans the messages and keeps only connections of the task. The
 * history (availability, response time, events) and the size of a database day by day, the
 * interval of a connection and its health in the answers.
 *
 * Needs RESTOW_TEST_DATABASE_URL (a superuser); skipped otherwise.
 */
import { randomUUID } from "node:crypto";
import type { DbProbeResult } from "@restow/core";
import {
  databaseConnections,
  databaseHealthSamples,
  databaseProbes,
  databases,
  endpoints,
  endpointTasks,
  settings,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";
import type { DatabaseContext } from "./service.js";

const DATABASE = "restow_api_database_health_test";
const PASSWORD = "Health-s3cret!42";
const USER = "restow_backup";
const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(
  ":",
);

type Service = typeof import("./service.js");
type Health = typeof import("./health.js");
type AgentService = typeof import("../endpoints/agent-service.js");
type Schemas = typeof import("../endpoints/schemas.js");
type Shared = typeof import("../../db.js");

function probeResult(): DbProbeResult {
  return {
    engine: "postgresql",
    port: 5432,
    serverVersion: "16.4",
    tls: {
      offered: true,
      used: true,
      fingerprintSha256: FINGERPRINT,
      subject: null,
      issuer: null,
      notAfter: null,
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
        { name: "app", oid: "16384", allowConnections: true, canConnect: true, sizeBytes: 1000 },
      ],
    },
    durationMs: 40,
  };
}

function healthResult(overrides: Partial<DbProbeResult> = {}): DbProbeResult {
  return {
    engine: "postgresql",
    port: 5432,
    serverVersion: "16.4",
    tls: {
      offered: true,
      used: true,
      fingerprintSha256: FINGERPRINT,
      subject: null,
      issuer: null,
      notAfter: null,
    },
    login: "ok",
    error: null,
    health: {
      latencyMs: 30,
      startedAt: "2026-11-01T00:00:00.000Z",
      connectionsUsed: 4,
      connectionsMax: 100,
      systemIdentifier: "7300000000000000042",
      serverUuid: null,
      serverId: null,
      datadir: null,
      databases: [{ name: "app", oid: "16384", sizeBytes: 2000 }],
    },
    durationMs: 35,
    ...overrides,
  };
}

describe.skipIf(!testDatabaseAdminUrl)(
  "database health checks of a tenant against Postgres",
  () => {
    let fixture: EndpointFixture;
    let service: Service;
    let health: Health;
    let agentService: AgentService;
    let schemas: Schemas;
    let shared: Shared;
    let agentId: string;
    let otherAgentId: string;

    const ctx = (): DatabaseContext => ({
      actor: { label: "admin@contoso.example", userId: fixture.adminId, ip: "192.0.2.1" },
      isProviderAdmin: false,
      privateNetworksAllowed: false,
      ownSystemIdentifier: async () => "7000000000000000001",
    });

    /** A connection through the agent, saved from its test as the dialog does. */
    async function agentConnection(name: string): Promise<string> {
      const agent = { endpointId: agentId, tenantId: fixture.tenantId };
      const pending = await service.testConnection(
        shared.db,
        fixture.tenantId,
        {
          address: "10.0.0.5:5432",
          user: USER,
          password: PASSWORD,
          authMethod: "password",
          executor: { kind: "agent", endpointId: agentId },
          allowUnencrypted: false,
        },
        ctx(),
      );
      await service.agentFetchProbe(shared.db, agent, pending.id);
      await service.agentFinishProbe(shared.db, agent, pending.id, probeResult(), {
        ownSystemIdentifier: async () => "7000000000000000001",
      });
      const created = await service.createConnection(
        shared.db,
        fixture.tenantId,
        {
          probeId: pending.id,
          name,
          user: USER,
          password: PASSWORD,
          allowUnencrypted: false,
          mode: "backup",
        },
        ctx(),
      );
      await fixture.db.delete(endpointTasks);
      return created.id;
    }

    async function beat(endpointId: string, now: Date) {
      return agentService.heartbeat(
        {
          endpointId,
          tenantId: fixture.tenantId,
          hostname: "db-bridge",
          profile: "server",
          os: "linux",
          ip: null,
        },
        schemas.heartbeatSchema.parse({
          agentVersion: "0.6.0",
          state: "idle",
          configVersion: null,
          capabilities: ["db_runner_v1"],
        }),
        now,
      );
    }

    beforeAll(async () => {
      fixture = await startFixture(DATABASE);
      shared = await import("../../db.js");
      service = await import("./service.js");
      health = await import("./health.js");
      agentService = await import("../endpoints/agent-service.js");
      schemas = await import("../endpoints/schemas.js");
      await fixture.db.insert(settings).values({}).onConflictDoNothing();
      const rows = await fixture.db
        .insert(endpoints)
        .values(
          ["db-bridge", "elsewhere"].map((hostname) => ({
            tenantId: fixture.tenantId,
            hostname,
            os: "linux" as const,
            arch: "amd64",
            profile: "server" as const,
            secretHash: "x",
            config: {} as never,
            lastSeenAt: new Date(),
            settings: { agent: { capabilities: ["db_runner_v1"] } },
          })),
        )
        .returning();
      agentId = rows[0]?.id as string;
      otherAgentId = rows[1]?.id as string;
    }, 120_000);

    afterAll(async () => {
      await fixture?.cleanup();
    });

    beforeEach(async () => {
      service.resetDatabaseProbeLimit();
      await fixture.db.delete(databaseConnections);
      await fixture.db.delete(databaseProbes);
      await fixture.db.delete(endpointTasks);
    });

    it("hands the agent one bundled task and its checks once, with the confirmed certificate [DB-004]", async () => {
      const now = new Date();
      // An agent without a connection gets nothing.
      expect((await beat(agentId, now)).tasks.filter((t) => t.kind === "db_health")).toEqual([]);
      const connectionId = await agentConnection("ERP");
      const first = (await beat(agentId, now)).tasks.filter((t) => t.kind === "db_health");
      expect(first).toHaveLength(1);
      // Not again within the spacing, and never to another agent.
      expect((await beat(agentId, new Date(now.getTime() + 60_000))).tasks).toEqual([]);
      expect((await beat(otherAgentId, now)).tasks).toEqual([]);

      const agent = { endpointId: agentId, tenantId: fixture.tenantId };
      const taskId = first[0]?.id as string;
      await expect(
        health.agentFetchHealth(shared.db, { ...agent, endpointId: otherAgentId }, taskId, now),
      ).rejects.toMatchObject({ status: 404 });
      const plan = await health.agentFetchHealth(shared.db, agent, taskId, now);
      expect(plan).toMatchObject({ taskId, windowSeconds: 360 });
      expect(plan.checks).toEqual([
        {
          connectionId,
          firstAfterSeconds: 0,
          intervalSeconds: 300,
          spec: expect.objectContaining({
            engine: "postgresql",
            host: "10.0.0.5",
            port: 5432,
            user: USER,
            password: PASSWORD,
            purpose: "health",
            tlsFingerprint: FINGERPRINT,
            sizes: true,
            timeoutSeconds: 10,
          }),
        },
      ]);
      // The credentials go out once (4.3).
      await expect(health.agentFetchHealth(shared.db, agent, taskId, now)).rejects.toMatchObject({
        status: 409,
      });
      const [task] = await fixture.db
        .select()
        .from(endpointTasks)
        .where(eq(endpointTasks.id, taskId));
      expect(JSON.stringify(task)).not.toContain(PASSWORD);
    });

    it("judges what the agent posts, cleans it and keeps only the task's connections [DB-002]", async () => {
      const now = new Date();
      const connectionId = await agentConnection("ERP");
      const [task] = (await beat(agentId, now)).tasks;
      const agent = { endpointId: agentId, tenantId: fixture.tenantId };
      await health.agentFetchHealth(shared.db, agent, task?.id as string, now);
      const later = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
      const answer = await health.agentReportHealth(
        shared.db,
        agent,
        task?.id as string,
        {
          samples: [
            { connectionId, at: later(1), result: healthResult() },
            {
              connectionId,
              at: later(2),
              result: healthResult({
                login: "failed",
                health: undefined,
                error: { code: "db_login_failed", message: `password ${PASSWORD} for ${USER}` },
              }),
            },
            // Another certificate than the confirmed one fails the check.
            {
              connectionId,
              at: later(3),
              result: healthResult({
                tls: { ...healthResult().tls, fingerprintSha256: Array(32).fill("CD").join(":") },
              }),
            },
            { connectionId: randomUUID(), at: later(4), result: healthResult() },
            { connectionId, at: later(5), result: { nonsense: true } },
            {
              connectionId,
              at: new Date(now.getTime() - 3_600_000).toISOString(),
              result: healthResult(),
            },
          ],
        },
        new Date(now.getTime() + 10_000),
      );
      expect(answer).toEqual({ accepted: 3 });
      const samples = await fixture.db
        .select()
        .from(databaseHealthSamples)
        .where(eq(databaseHealthSamples.connectionId, connectionId))
        .orderBy(databaseHealthSamples.at);
      expect(samples.map((sample) => [sample.okChecks, sample.errorCode])).toEqual([
        [1, null],
        [0, "db_login_failed"],
        [0, "db_tls_changed"],
      ]);
      expect(JSON.stringify(samples)).not.toContain(PASSWORD);
      expect(JSON.stringify(samples)).not.toContain(USER);
      const [database] = await fixture.db
        .select()
        .from(databases)
        .where(eq(databases.connectionId, connectionId));
      expect(database?.sizeBytes).toBe(2000);
      expect(samples[0]?.sizes).toEqual({ [database?.id as string]: 2000 });

      // Long after its window the task takes nothing any more.
      await expect(
        health.agentReportHealth(
          shared.db,
          agent,
          task?.id as string,
          { samples: [] },
          new Date(now.getTime() + 3_600_000),
        ),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("shows availability, response time, events and the size day by day", async () => {
      const connectionId = await agentConnection("ERP");
      const [database] = await fixture.db
        .select()
        .from(databases)
        .where(eq(databases.connectionId, connectionId));
      const now = new Date();
      const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
      const base = {
        tenantId: fixture.tenantId,
        connectionId,
        executorKind: "agent" as const,
        checks: 1,
        serverVersion: "16.4",
        tlsFingerprint: FINGERPRINT,
      };
      await fixture.db.insert(databaseHealthSamples).values([
        {
          ...base,
          at: minutesAgo(50),
          okChecks: 1,
          latencyMs: 20,
          latencyMaxMs: 20,
          startedAt: minutesAgo(5000),
        },
        { ...base, at: minutesAgo(40), okChecks: 0, errorCode: "db_unreachable" },
        {
          ...base,
          at: minutesAgo(30),
          okChecks: 1,
          latencyMs: 40,
          latencyMaxMs: 40,
          startedAt: minutesAgo(35),
          serverVersion: "16.5",
        },
        {
          ...base,
          at: new Date(now.getTime() - 2 * 86_400_000),
          okChecks: 1,
          sizes: { [database?.id as string]: 1000 },
        },
        {
          ...base,
          at: new Date(now.getTime() - 25 * 3_600_000),
          okChecks: 1,
          sizes: { [database?.id as string]: 1500 },
        },
      ]);
      const history = await health.connectionHealth(
        shared.db,
        fixture.tenantId,
        connectionId,
        {},
        now,
      );
      expect(history.availability.day).toBeCloseTo(2 / 3, 5);
      expect(history.availability.week).toBeCloseTo(4 / 5, 5);
      expect(history.points.reduce((sum, point) => sum + point.checks, 0)).toBe(3);
      expect(history.events.map((event) => event.kind)).toEqual([
        "restart",
        "version",
        "unreachable",
      ]);
      expect(history.lastError).toMatchObject({ code: "db_unreachable" });
      await expect(
        health.connectionHealth(shared.db, fixture.tenantId, connectionId, {
          from: now.toISOString(),
          to: minutesAgo(10).toISOString(),
        }),
      ).rejects.toMatchObject({ status: 422 });

      const sizes = await health.databaseSizeHistory(
        shared.db,
        fixture.tenantId,
        database?.id as string,
        {},
        now,
      );
      expect(sizes.days.map((day) => [day.sizeBytes, day.growthBytes])).toEqual([
        [1000, null],
        [1500, 500],
      ]);

      // The interval is the connection's own; the list carries the band of the last 24 hours.
      const updated = await service.updateConnection(
        shared.db,
        fixture.tenantId,
        connectionId,
        { healthIntervalMinutes: 15 },
        ctx(),
      );
      expect(updated.health.intervalMinutes).toBe(15);
      expect(updated.band).toHaveLength(24);
      expect(updated.band.filter((hour) => hour.checks > 0).length).toBeGreaterThan(0);
      const list = await service.listDatabases(shared.db, fixture.tenantId);
      expect(list.databases[0]?.band).toHaveLength(24);
    });
  },
);
