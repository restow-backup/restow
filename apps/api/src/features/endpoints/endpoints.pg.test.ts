/**
 * Postgres-backed tests of endpoint backup (docs/AGENT.md): the enrollment
 * flow with a one-time token, agent authentication, the agent API (config,
 * heartbeat with tasks, runs, samples), the session service (tokens, tasks,
 * config changes, revoke), readiness and, above all, Row Level Security: one
 * tenant never sees another tenant's endpoints, tokens, runs, tasks, samples
 * or reports.
 *
 * Enrollment creates the restic repository, so the suite needs the restic
 * binary (RESTIC_BINARY, else the PATH). The database `restow_api_endpoints_test`
 * is recreated on the server RESTOW_TEST_DATABASE_URL points at (a superuser)
 * and dropped after.
 */
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_SECRET_PREFIX,
  ENROLLMENT_TOKEN_PREFIX,
  LocalStorageBackend,
  endpointPasswordKey,
  endpointPrefix,
  hashSecret,
  measureRepositoryBytes,
  openEndpointPassword,
  secretMatchesHash,
  singleKeyring,
} from "@restow/core";
import {
  auditLog,
  backupJobMembers,
  backupJobs,
  endpointEnrollmentTokens,
  endpointReports,
  endpointRepositoryLocks,
  endpointRuns,
  endpointSamples,
  endpointSnapshotFlags,
  endpointTasks,
  endpoints,
  secrets,
  tenants,
  users,
  webhookDeliveries,
  webhooks,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type EndpointFixture,
  basic,
  resticAvailable,
  startFixture,
  testDatabaseAdminUrl,
} from "./testing/fixture.js";

const DATABASE = "restow_api_endpoints_test";
const canRun = Boolean(testDatabaseAdminUrl) && resticAvailable();

type Service = typeof import("./service.js");
type AgentService = typeof import("./agent-service.js");
type Readiness = typeof import("./readiness.js");
type Shared = typeof import("../../db.js");

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

interface Enrolled {
  endpointId: string;
  agentSecret: string;
  repository: { url: string; password: string };
  config: Record<string, unknown> & { configVersion: number };
}

describe.skipIf(!canRun)("endpoint backup against Postgres", () => {
  let fixture: EndpointFixture;
  let shared: Shared;
  let service: Service;
  let agentService: AgentService;
  let readiness: Readiness;
  let app: Hono;
  let ipCounter = 10;

  const actor = () => ({
    label: "admin@contoso.example",
    userId: fixture.adminId,
    ip: "192.0.2.1",
  });
  const instance = { url: "https://restow.test.example", configured: true };
  const nextIp = () => `192.0.2.${ipCounter++}`;

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    shared = await import("../../db.js");
    service = await import("./service.js");
    agentService = await import("./agent-service.js");
    readiness = await import("./readiness.js");
    const { agentRoutes } = await import("./agent-routes.js");
    const { resticRoutes } = await import("./restic-route.js");
    const { errorHandler } = await import("../../problem.js");
    app = new Hono();
    app.onError(errorHandler);
    app.route("/agent/v1", agentRoutes);
    app.route("/agent/restic", resticRoutes);
  }, 90_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  async function token(
    profile: "server" | "client" = "server",
    os: "linux" | "darwin" = "linux",
    tenantId = fixture.tenantId,
  ) {
    return service.createEnrollmentToken(shared.db, tenantId, { profile, os }, actor(), instance);
  }

  async function enrollWith(
    tokenValue: string,
    overrides: Record<string, unknown> = {},
    ip = nextIp(),
  ) {
    return app.request("/agent/v1/enroll", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({
        token: tokenValue,
        hostname: "srv-01",
        os: "linux",
        arch: "amd64",
        agentVersion: "0.1.0",
        osVersion: "Debian 12",
        ...overrides,
      }),
    });
  }

  async function enrolled(
    profile: "server" | "client" = "server",
    tenantId = fixture.tenantId,
    os: "linux" | "darwin" = "linux",
    extra: Record<string, unknown> = {},
  ): Promise<Enrolled> {
    const created = await token(profile, os, tenantId);
    const response = await enrollWith(created.token, { os, ...extra });
    expect(response.status).toBe(201);
    return (await response.json()) as Enrolled;
  }

  /** A tenant of its own (with its key), for tests of tenant-wide switches. */
  async function freshTenant(name: string): Promise<string> {
    const [base] = await fixture.db.select().from(tenants).where(eq(tenants.id, fixture.tenantId));
    const [row] = await fixture.db
      .insert(tenants)
      .values({ providerId: base?.providerId ?? "", name, slug: `t-${randomUUID().slice(0, 8)}` })
      .returning();
    const id = row?.id ?? "";
    const secretStore = await import("../../lib/secrets.js");
    await fixture.db.transaction((tx) => secretStore.createTenantKey(tx, id));
    return id;
  }

  const agentRequest = (
    who: Enrolled,
    path: string,
    init: { method?: string; body?: unknown; ip?: string } = {},
  ) =>
    app.request(`/agent/v1${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...basic(who.endpointId, who.agentSecret),
        "content-type": "application/json",
        "x-forwarded-for": init.ip ?? "192.0.2.200",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  async function endpointRow(id: string) {
    const [row] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, id));
    return row;
  }

  const DAILY = { kind: "daily" as const, timeOfDay: "22:00", timeZone: "Europe/Berlin" };

  /** Give a machine a schedule, as one in no job of an earlier release still has it. */
  async function withSchedule(who: Enrolled): Promise<void> {
    const row = await endpointRow(who.endpointId);
    if (!row) throw new Error("no such machine");
    await fixture.db
      .update(endpoints)
      .set({ config: { ...row.config, schedule: DAILY } })
      .where(eq(endpoints.id, who.endpointId));
  }

  /** Put a machine into a backup job of its own (backups run only in a job, release 0.2.1). */
  async function inJob(who: Enrolled, tenantId = fixture.tenantId): Promise<void> {
    const [job] = await fixture.db
      .insert(backupJobs)
      .values({
        tenantId,
        kind: "endpoint",
        name: `Job ${randomUUID().slice(0, 8)}`,
        schedule: DAILY,
        settings: {},
      })
      .returning();
    await fixture.db
      .insert(backupJobMembers)
      .values({ tenantId, jobId: job?.id ?? "", endpointId: who.endpointId, overrides: {} });
    await withSchedule(who);
  }

  describe("enrollment", () => {
    it("creates a one-time token that is stored only as a hash and audited", async () => {
      const created = await token("server");
      expect(created.token.startsWith(ENROLLMENT_TOKEN_PREFIX)).toBe(true);
      expect(created.state).toBe("valid");
      expect(new Date(created.expiresAt).getTime() - Date.now()).toBeGreaterThan(23.9 * 3600_000);
      // The token is not part of any command: the script asks for it (shell history, process list).
      expect(created.commands.install).toBe(
        "curl -fsSL 'https://restow.test.example/install/linux.sh' | sudo sh",
      );
      expect(JSON.stringify(created.commands)).not.toContain(created.token);
      expect(created.commands.uninstallAgent).toBe(
        "sudo '/opt/restow-agent/bin/restow-agent' uninstall",
      );
      expect(created.warnings).toEqual([]);

      const [row] = await fixture.db
        .select()
        .from(endpointEnrollmentTokens)
        .where(eq(endpointEnrollmentTokens.id, created.id));
      expect(row?.tokenHash).toBe(hashSecret(created.token));
      expect(JSON.stringify(row)).not.toContain(created.token);

      const [entry] = await fixture.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "endpoint.token.created"), eq(auditLog.target, created.id)));
      expect(entry?.tenantId).toBe(fixture.tenantId);
      expect(JSON.stringify(entry)).not.toContain(created.token);
    });

    it("builds the macOS command and warns about plain http and an unset address", async () => {
      const created = await service.createEnrollmentToken(
        shared.db,
        fixture.tenantId,
        { profile: "client", os: "darwin", displayName: "  Anna's MacBook " },
        actor(),
        { url: "http://192.168.1.10:8080", configured: false },
      );
      expect(created.commands.install).toContain("/install/macos.sh");
      expect(created.displayName).toBe("Anna's MacBook");
      expect(created.warnings).toEqual(["insecure_transport", "instance_url_not_configured"]);
    });

    it("refuses tokens for Windows", async () => {
      await expect(
        service.createEnrollmentToken(
          shared.db,
          fixture.tenantId,
          { profile: "server", os: "windows" },
          actor(),
          instance,
        ),
      ).rejects.toMatchObject({ status: 422, type: "urn:restow:problem:unsupported-os" });
    });

    it("enrolls a machine: secret, sealed repository password, repository and audit", async () => {
      const created = await token("server");
      const response = await enrollWith(created.token, { hostname: "web-01" });
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as Enrolled;

      expect(body.agentSecret.startsWith(AGENT_SECRET_PREFIX)).toBe(true);
      expect(body.repository.url).toBe(
        `rest:https://restow.test.example/agent/restic/${body.endpointId}/`,
      );
      expect(body.repository.password.length).toBeGreaterThanOrEqual(40);
      // In no backup job yet: no schedule, and the agent is handed no folders (an older agent
      // that does not know `none` backs nothing up either).
      expect(body.config).toMatchObject({
        profile: "server",
        schedule: { kind: "none" },
        paths: [],
        hooks: {},
        bandwidthKbps: null,
        onlyOnAcPower: false,
        useVss: false,
        configVersion: 1,
      });

      const row = await endpointRow(body.endpointId);
      // The stored configuration keeps the profile's folders for a job to start from.
      expect(row?.config).toMatchObject({
        schedule: { kind: "none" },
        paths: [
          "/etc",
          "/home",
          "/root",
          "/srv",
          "/var/www",
          "/opt",
          "/usr/local",
          "/var/lib",
          "/var/backups",
        ],
      });
      expect(row).toMatchObject({
        tenantId: fixture.tenantId,
        hostname: "web-01",
        os: "linux",
        arch: "amd64",
        profile: "server",
        status: "active",
        agentVersion: "0.1.0",
      });
      // Only the hash of the agent secret is stored.
      expect(row?.secretHash).toBe(hashSecret(body.agentSecret));
      expect(secretMatchesHash(body.agentSecret, row?.secretHash ?? "")).toBe(true);
      expect(JSON.stringify(row)).not.toContain(body.agentSecret);

      // The repository password is sealed with the tenant key, never stored in clear.
      const [secret] = await fixture.db
        .select()
        .from(secrets)
        .where(eq(secrets.id, row?.repositorySecretId ?? ""));
      expect(secret?.tenantId).toBe(fixture.tenantId);
      expect(secret?.ciphertext).not.toContain(body.repository.password);
      const { readSecret } = await import("../../lib/secrets.js");
      expect(
        await readSecret(shared.db, { id: secret?.id ?? "", tenantId: fixture.tenantId }),
      ).toBe(body.repository.password);

      // The server initialised the repository in the primary storage target.
      await access(join(fixture.storageDir, "endpoints", body.endpointId, "config"));
      await access(join(fixture.storageDir, "endpoints", body.endpointId, "keys"));

      // And put the password next to it, sealed with the tenant key (restore without the database).
      const document = await new LocalStorageBackend(fixture.storageDir).get(
        endpointPasswordKey(body.endpointId),
      );
      expect(document.toString("utf8")).not.toContain(body.repository.password);
      const { loadTenantDek } = await import("../../lib/secrets.js");
      const { withTenantTx } = await import("../../lib/tenant-context.js");
      const dek = await withTenantTx(shared.db, fixture.tenantId, (tx) =>
        loadTenantDek(tx, fixture.tenantId),
      );
      expect(openEndpointPassword(document, singleKeyring(dek).open, body.endpointId)).toEqual({
        tenantId: fixture.tenantId,
        endpointId: body.endpointId,
        password: body.repository.password,
      });

      const [entry] = await fixture.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "endpoint.enrolled"), eq(auditLog.target, body.endpointId)));
      expect(entry?.tenantId).toBe(fixture.tenantId);
      const details = JSON.stringify(entry);
      expect(details).not.toContain(body.agentSecret);
      expect(details).not.toContain(body.repository.password);

      const [used] = await fixture.db
        .select()
        .from(endpointEnrollmentTokens)
        .where(eq(endpointEnrollmentTokens.id, created.id));
      expect(used?.usedAt).toBeInstanceOf(Date);
      expect(used?.usedByEndpointId).toBe(body.endpointId);
    }, 30_000);

    it("uses a token exactly once", async () => {
      const created = await token("client", "darwin");
      const first = await enrollWith(created.token, { os: "darwin", arch: "arm64" });
      expect(first.status).toBe(201);
      const second = await enrollWith(created.token, { os: "darwin", arch: "arm64" });
      expect(second.status).toBe(401);
      expect(await second.json()).toMatchObject({
        type: "urn:restow:problem:enrollment-token-invalid",
        reason: "used",
      });
    }, 30_000);

    it("only lets one of two simultaneous enrollments win", async () => {
      const created = await token("server");
      const results = await Promise.all([
        enrollWith(created.token, { hostname: "race-a" }),
        enrollWith(created.token, { hostname: "race-b" }),
      ]);
      expect(results.map((response) => response.status).sort()).toEqual([201, 401]);
    }, 30_000);

    it("refuses an expired, a revoked and an unknown token", async () => {
      const expired = await token("server");
      await fixture.db
        .update(endpointEnrollmentTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(endpointEnrollmentTokens.id, expired.id));
      const revoked = await token("server");
      await service.revokeEnrollmentToken(shared.db, fixture.tenantId, revoked.id, actor());

      for (const [value, reason] of [
        [expired.token, "expired"],
        [revoked.token, "revoked"],
        [`${ENROLLMENT_TOKEN_PREFIX}${"x".repeat(43)}`, "unknown"],
      ] as const) {
        const response = await enrollWith(value);
        expect(response.status, reason).toBe(401);
        expect(await response.json()).toMatchObject({ reason });
      }
      const [entry] = await fixture.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "endpoint.token.revoked"), eq(auditLog.target, revoked.id)));
      expect(entry).toBeDefined();
    });

    it("does not enroll Windows and leaves the token valid", async () => {
      const created = await token("server");
      const response = await enrollWith(created.token, { os: "windows" });
      expect(response.status).toBe(422);
      const problem = (await response.json()) as { type: string; detail: string };
      expect(problem.type).toBe("urn:restow:problem:unsupported-os");
      expect(problem.detail).toContain("Windows");
      const [row] = await fixture.db
        .select()
        .from(endpointEnrollmentTokens)
        .where(eq(endpointEnrollmentTokens.id, created.id));
      expect(row?.usedAt).toBeNull();
      // The same token still enrolls a Linux machine.
      expect((await enrollWith(created.token)).status).toBe(201);
    }, 30_000);

    it("rejects malformed bodies without spending the token", async () => {
      const created = await token("server");
      expect((await enrollWith(created.token, { arch: "sparc" })).status).toBe(422);
      expect((await enrollWith(created.token, { hostname: "" })).status).toBe(422);
      const [row] = await fixture.db
        .select()
        .from(endpointEnrollmentTokens)
        .where(eq(endpointEnrollmentTokens.id, created.id));
      expect(row?.usedAt).toBeNull();
    });
  });

  describe("restoring without Restow", () => {
    it("hands out the repository password on request and audits the access", async () => {
      const who = await enrolled("server");
      const key = await service.revealRepositoryPassword(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        actor(),
      );
      expect(key.password).toBe(who.repository.password);
      expect(key.storagePrefix).toBe(`endpoints/${who.endpointId}/`);
      const [entry] = await fixture.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "endpoint.repository.password.revealed"),
            eq(auditLog.target, who.endpointId),
          ),
        );
      expect(entry?.actor).toBe("admin@contoso.example");
      expect(JSON.stringify(entry)).not.toContain(who.repository.password);
      await expect(
        service.revealRepositoryPassword(shared.db, fixture.otherTenantId, who.endpointId, actor()),
      ).rejects.toMatchObject({ status: 404 });
    }, 30_000);
  });

  describe("agent authentication", () => {
    it("serves the configuration to the endpoint and marks it seen", async () => {
      const who = await enrolled("client", fixture.tenantId, "darwin");
      const before = await endpointRow(who.endpointId);
      expect(before?.lastSeenAt).toBeInstanceOf(Date);
      const response = await agentRequest(who, "/config");
      expect(response.status).toBe(200);
      // A new machine waits for a backup job: no schedule, and no folders handed out.
      expect(await response.json()).toMatchObject({
        profile: "client",
        schedule: { kind: "none" },
        paths: [],
        configVersion: 1,
      });
    }, 30_000);

    it("refuses a wrong secret, another endpoint's secret and missing credentials", async () => {
      const a = await enrolled("server");
      const b = await enrolled("server");
      const ip = nextIp();
      const cases = [
        { ...a, agentSecret: `${a.agentSecret}x` },
        { ...a, agentSecret: b.agentSecret },
        { ...a, endpointId: randomUUID() },
      ];
      for (const who of cases) {
        const response = await agentRequest(who, "/config", { ip });
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain("Basic");
      }
      const none = await app.request("/agent/v1/config", { headers: { "x-forwarded-for": ip } });
      expect(none.status).toBe(401);
      expect((await app.request("/agent/v1/config")).status).toBe(401);
    }, 60_000);

    it("throttles an address after repeated failures", async () => {
      const who = await enrolled("server");
      const ip = "198.51.100.77";
      for (let attempt = 0; attempt < 30; attempt++) {
        await agentRequest({ ...who, agentSecret: "wrong" }, "/config", { ip });
      }
      const blocked = await agentRequest(who, "/config", { ip });
      expect(blocked.status).toBe(429);
      // Another address is not affected.
      expect((await agentRequest(who, "/config", { ip: "198.51.100.78" })).status).toBe(200);
    }, 60_000);

    it("refuses a revoked endpoint with a problem the agent can act on", async () => {
      const who = await enrolled("server");
      await service.revokeEndpoint(shared.db, fixture.tenantId, who.endpointId, actor());
      const response = await agentRequest(who, "/config");
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ type: "urn:restow:problem:endpoint-revoked" });
      const restic = await app.request(`/agent/restic/${who.endpointId}/config`, {
        headers: basic(who.endpointId, who.agentSecret),
      });
      expect(restic.status).toBe(401);
    }, 30_000);
  });

  describe("heartbeat and tasks", () => {
    it("refuses a backup request for a machine in no backup job", async () => {
      const who = await enrolled("server");
      await expect(
        service.createTask(
          shared.db,
          fixture.tenantId,
          who.endpointId,
          { kind: "backup_now" },
          actor(),
        ),
      ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:endpoint-no-job" });
    }, 30_000);

    it("delivers a backup request once", async () => {
      const who = await enrolled("server");
      await inJob(who);
      const created = await service.createTask(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        { kind: "backup_now" },
        actor(),
      );
      expect(created.alreadyQueued).toBe(false);
      const again = await service.createTask(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        { kind: "backup_now" },
        actor(),
      );
      expect(again.alreadyQueued).toBe(true);
      expect(again.task.id).toBe(created.task.id);

      const heartbeat = {
        agentVersion: "0.1.1",
        osVersion: "Debian 12.5",
        state: "idle",
        nextRunAt: null,
        configVersion: 1,
      };
      const first = await agentRequest(who, "/heartbeat", { body: heartbeat });
      expect(first.status).toBe(200);
      const delivered = ((await first.json()) as { tasks: { id: string; kind: string }[] }).tasks;
      expect(delivered.map((task) => task.kind)).toEqual(["backup_now"]);
      expect(delivered[0]?.id).toBe(created.task.id);

      const second = await agentRequest(who, "/heartbeat", { body: heartbeat });
      expect(((await second.json()) as { tasks: unknown[] }).tasks).toEqual([]);

      const row = await endpointRow(who.endpointId);
      expect(row).toMatchObject({
        agentVersion: "0.1.1",
        osVersion: "Debian 12.5",
        agentState: "idle",
      });
      const [task] = await fixture.db
        .select()
        .from(endpointTasks)
        .where(eq(endpointTasks.id, created.task.id));
      expect(task?.status).toBe("delivered");
    }, 30_000);

    it("tells an agent with an old configuration to fetch the new one", async () => {
      const who = await enrolled("server", fixture.tenantId, "linux", { hooks: "any" });
      // A machine in no job that still has the schedule of an earlier release.
      await withSchedule(who);
      const changed = await service.updateEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        {
          config: {
            paths: ["/srv/data"],
            bandwidthKbps: 500,
            hooks: { pre: "pg_dump db > /srv/data/db.sql" },
          },
        },
        actor(),
      );
      expect(changed.configVersion).toBe(2);
      expect(changed.changed).toEqual(["config.paths", "config.hooks", "config.bandwidthKbps"]);

      const heartbeat = {
        agentVersion: "0.1.0",
        osVersion: "",
        state: "idle",
        nextRunAt: null,
        configVersion: 1,
      };
      const response = await agentRequest(who, "/heartbeat", { body: heartbeat });
      const tasks = (
        (await response.json()) as { tasks: { kind: string; params: { configVersion: number } }[] }
      ).tasks;
      expect(tasks.map((task) => task.kind)).toEqual(["update_config"]);
      expect(tasks[0]?.params.configVersion).toBe(2);

      const config = await (await agentRequest(who, "/config")).json();
      expect(config).toMatchObject({
        paths: ["/srv/data"],
        bandwidthKbps: 500,
        hooks: { pre: "pg_dump db > /srv/data/db.sql" },
        configVersion: 2,
      });
      // The agent that runs version 2 hears nothing more about it.
      const settled = await agentRequest(who, "/heartbeat", {
        body: { ...heartbeat, configVersion: 2 },
      });
      expect(((await settled.json()) as { tasks: unknown[] }).tasks).toEqual([]);
    }, 30_000);

    it("audits a configuration change without the hook text", async () => {
      const who = await enrolled("server", fixture.tenantId, "linux", { hooks: "any" });
      await service.updateEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        {
          displayName: "Fileserver",
          config: { hooks: { post: "curl https://hooks.example/secret-token" } },
        },
        actor(),
      );
      const [entry] = await fixture.db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, "endpoint.config.changed"), eq(auditLog.target, who.endpointId)),
        );
      expect(entry?.actor).toBe("admin@contoso.example");
      const text = JSON.stringify(entry?.details);
      expect(text).toContain("config.hooks");
      expect(text).not.toContain("secret-token");
    }, 30_000);

    it("assigns a machine to a person of the tenant's directory, audited, and refuses anyone else", async () => {
      const who = await enrolled("client", fixture.tenantId);
      const suffix = randomUUID().slice(0, 8);
      const [alice] = await fixture.db
        .insert(users)
        .values({
          tenantId: fixture.tenantId,
          email: `alice-${suffix}@contoso.example`,
          displayName: "Alice Example",
        })
        .returning();
      const [mallory] = await fixture.db
        .insert(users)
        .values({ tenantId: fixture.otherTenantId, email: `mallory-${suffix}@fabrikam.example` })
        .returning();
      const aliceId = alice?.id ?? "";

      const result = await service.updateEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        { assignedUserId: aliceId },
        actor(),
      );
      expect(result.changed).toEqual(["assignedUserId"]);
      const person = { id: aliceId, displayName: "Alice Example", email: alice?.email };
      const detail = await service.getEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        instance.url,
      );
      expect(detail.assignedTo).toEqual(person);
      const listed = await service.listEndpoints(shared.db, fixture.tenantId);
      expect(listed.items.find((item) => item.id === who.endpointId)?.assignedTo).toEqual(person);
      // No configuration changed: the agent is not asked to fetch anything.
      expect((await endpointRow(who.endpointId))?.configVersion).toBe(who.config.configVersion);
      const [entry] = await fixture.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "endpoint.assigned"), eq(auditLog.target, who.endpointId)));
      expect(entry?.details).toMatchObject({ assignedUserId: aliceId, previousUserId: null });
      const configEntries = await fixture.db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, "endpoint.config.changed"), eq(auditLog.target, who.endpointId)),
        );
      expect(configEntries).toEqual([]);

      // A person of another tenant, or one that does not exist, is not in this directory.
      for (const stranger of [mallory?.id ?? "", randomUUID()]) {
        await expect(
          service.updateEndpoint(
            shared.db,
            fixture.tenantId,
            who.endpointId,
            { assignedUserId: stranger },
            actor(),
          ),
        ).rejects.toMatchObject({
          status: 422,
          type: "urn:restow:problem:endpoint-assignee-unknown",
        });
      }
      expect((await endpointRow(who.endpointId))?.assignedUserId).toBe(aliceId);

      // The picker finds her by a part of her name, and only the tenant's own people.
      const directory = await import("../directory/service.js");
      const found = await directory.listPeople(shared.db, fixture.tenantId, {
        search: "alice ex",
        limit: 20,
      });
      expect(found.items.map((item) => item.id)).toEqual([aliceId]);
      const foreign = await directory.listPeople(shared.db, fixture.tenantId, {
        search: "mallory",
        limit: 20,
      });
      expect(foreign.items).toEqual([]);

      // null removes the assignment; a person leaving the directory clears it as well.
      await service.updateEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        { assignedUserId: null },
        actor(),
      );
      expect((await endpointRow(who.endpointId))?.assignedUserId).toBeNull();
      await service.updateEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        { assignedUserId: aliceId },
        actor(),
      );
      await fixture.db.delete(users).where(eq(users.id, aliceId));
      const after = await endpointRow(who.endpointId);
      expect(after?.assignedUserId).toBeNull();
      expect(after?.tenantId).toBe(fixture.tenantId);
    }, 30_000);

    it("removes the agent on request and revokes the endpoint once it is told", async () => {
      const who = await enrolled("client");
      await service.requestUninstall(shared.db, fixture.tenantId, who.endpointId, actor());
      const heartbeat = {
        agentVersion: "0.1.0",
        osVersion: "",
        state: "idle",
        nextRunAt: null,
        configVersion: 1,
      };
      const response = await agentRequest(who, "/heartbeat", { body: heartbeat });
      expect(
        ((await response.json()) as { tasks: { kind: string }[] }).tasks.map((task) => task.kind),
      ).toEqual(["uninstall"]);
      expect((await endpointRow(who.endpointId))?.status).toBe("revoked");
      expect((await agentRequest(who, "/config")).status).toBe(401);
    }, 30_000);

    it("expires a task nobody picked up", async () => {
      const who = await enrolled("server");
      await inJob(who);
      const { task } = await service.createTask(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        { kind: "backup_now" },
        actor(),
        new Date(Date.now() - 8 * 24 * 3600_000),
      );
      const heartbeat = {
        agentVersion: "0.1.0",
        osVersion: "",
        state: "idle",
        nextRunAt: null,
        configVersion: 1,
      };
      const response = await agentRequest(who, "/heartbeat", { body: heartbeat });
      expect(((await response.json()) as { tasks: unknown[] }).tasks).toEqual([]);
      const [row] = await fixture.db
        .select()
        .from(endpointTasks)
        .where(eq(endpointTasks.id, task.id));
      expect(row).toMatchObject({ status: "failed", errorMessage: "expired" });
    }, 30_000);
  });

  describe("runs, samples and results", () => {
    const SNAPSHOT = "a1".repeat(32);

    async function finishedBackup(who: Enrolled, overrides: Record<string, unknown> = {}) {
      const start = await agentRequest(who, "/runs", {
        body: { kind: "backup", startedAt: new Date().toISOString() },
      });
      expect(start.status).toBe(201);
      const { runId } = (await start.json()) as { runId: string };
      const finish = await agentRequest(who, `/runs/${runId}/finish`, {
        body: {
          status: "succeeded",
          finishedAt: new Date().toISOString(),
          snapshotId: SNAPSHOT,
          stats: {
            filesNew: 3,
            dataAdded: 1024,
            totalFilesProcessed: 3,
            totalBytesProcessed: 4096,
          },
          sample: [
            { path: "/etc/hosts", sha256: sha256("hosts"), size: 5 },
            { path: "/srv/a.txt", sha256: sha256("a"), size: 1 },
          ],
          errors: [],
          logTail: "line 1\nline 2",
          ...overrides,
        },
      });
      return { runId, finish };
    }

    it("records a good backup, its samples and the endpoint's last success", async () => {
      const who = await enrolled("server");
      const { runId, finish } = await finishedBackup(who);
      expect(finish.status).toBe(200);
      expect(await finish.json()).toEqual({ runId, status: "succeeded" });

      const row = await endpointRow(who.endpointId);
      expect(row?.lastSnapshotId).toBe(SNAPSHOT);
      expect(row?.lastSuccessAt).toBeInstanceOf(Date);
      expect(row?.lastBackupAt).toBeInstanceOf(Date);

      const samples = await fixture.db
        .select()
        .from(endpointSamples)
        .where(eq(endpointSamples.endpointId, who.endpointId));
      expect(samples.map((sample) => sample.path).sort()).toEqual(["/etc/hosts", "/srv/a.txt"]);
      expect(samples.every((sample) => sample.snapshotId === SNAPSHOT)).toBe(true);

      const run = await service.getRun(shared.db, fixture.tenantId, who.endpointId, runId);
      expect(run).toMatchObject({
        status: "succeeded",
        snapshotId: SNAPSHOT,
        logTail: "line 1\nline 2",
        filesNew: 3,
      });
    }, 30_000);

    it("finishing twice answers the same and changes nothing", async () => {
      const who = await enrolled("server");
      const { runId } = await finishedBackup(who);
      const again = await agentRequest(who, `/runs/${runId}/finish`, {
        body: {
          status: "failed",
          finishedAt: new Date().toISOString(),
          errors: [{ message: "late" }],
          logTail: "",
        },
      });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ runId, status: "succeeded" });
    }, 30_000);

    it("keeps progress of a running run and refuses it after the end", async () => {
      const who = await enrolled("server");
      const start = await agentRequest(who, "/runs", {
        body: { kind: "backup", startedAt: new Date().toISOString() },
      });
      const { runId } = (await start.json()) as { runId: string };
      const progress = await agentRequest(who, `/runs/${runId}/progress`, {
        body: { filesDone: 10, bytesDone: 2048, totalFiles: 100, currentPath: "/srv/x" },
      });
      expect(progress.status).toBe(204);
      const detail = await service.getRun(shared.db, fixture.tenantId, who.endpointId, runId);
      expect(detail.progress).toMatchObject({
        filesDone: 10,
        bytesDone: 2048,
        currentPath: "/srv/x",
      });
      await agentRequest(who, `/runs/${runId}/finish`, {
        body: {
          status: "failed",
          finishedAt: new Date().toISOString(),
          errors: [{ message: "boom" }],
          logTail: "",
        },
      });
      const late = await agentRequest(who, `/runs/${runId}/progress`, {
        body: { filesDone: 11, bytesDone: 1 },
      });
      expect(late.status).toBe(404);
    }, 30_000);

    it("does not let an endpoint touch another endpoint's run", async () => {
      const a = await enrolled("server");
      const b = await enrolled("server");
      const start = await agentRequest(a, "/runs", {
        body: { kind: "backup", startedAt: new Date().toISOString() },
      });
      const { runId } = (await start.json()) as { runId: string };
      const progress = await agentRequest(b, `/runs/${runId}/progress`, {
        body: { filesDone: 1, bytesDone: 1 },
      });
      expect(progress.status).toBe(404);
      const finish = await agentRequest(b, `/runs/${runId}/finish`, {
        body: {
          status: "succeeded",
          finishedAt: new Date().toISOString(),
          snapshotId: SNAPSHOT,
          errors: [],
          logTail: "",
        },
      });
      expect(finish.status).toBe(404);
    }, 60_000);

    it("keeps a partial backup as the newest good one and rates it yellow at best", async () => {
      const who = await enrolled("server");
      const { finish } = await finishedBackup(who, {
        status: "partial",
        errors: [{ path: "/srv/locked.db", message: "permission denied" }],
      });
      expect(finish.status).toBe(200);
      await fixture.db.insert(endpointReports).values({
        tenantId: fixture.tenantId,
        endpointId: who.endpointId,
        kind: "restore_test",
        origin: "server",
        snapshotId: SNAPSHOT,
        readiness: "green",
        summary: { files: 2, matched: 2 },
      });
      const rating = await shared.db.transaction(async (tx) => {
        await tx.execute(await pin(fixture.tenantId));
        return readiness.loadEndpointReadiness(tx, fixture.tenantId, [who.endpointId]);
      });
      expect(rating.get(who.endpointId)?.state).toBe("yellow");
    }, 30_000);

    it("records a failed backup, alerts by webhook and leaves the last success alone", async () => {
      const who = await enrolled("server");
      await finishedBackup(who);
      // A webhook of the tenant that listens for failed jobs.
      const hookId = randomUUID();
      await fixture.db.insert(webhooks).values({
        id: hookId,
        tenantId: fixture.tenantId,
        name: "RMM",
        url: "https://rmm.example/hook",
        events: ["job.failed"],
      });
      const { runId, finish } = await finishedBackup(who, {
        status: "failed",
        snapshotId: undefined,
        sample: undefined,
        errors: [{ message: "repository unreachable" }],
      });
      expect(finish.status).toBe(200);
      const row = await endpointRow(who.endpointId);
      expect(row?.lastSnapshotId).toBe(SNAPSHOT);
      const deliveries = await fixture.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, hookId));
      expect(deliveries).toHaveLength(1);
      const payload = deliveries[0]?.payload as {
        event: string;
        data: {
          job: {
            id: string;
            status: string;
            errorMessage: string;
            failure: { code: string; transient: boolean } | null;
          };
          endpoint: { id: string };
        };
      };
      expect(payload.event).toBe("job.failed");
      expect(payload.data.job).toMatchObject({
        id: runId,
        status: "failed",
        errorMessage: "repository unreachable",
        // The same machine-readable cause the mailbox jobs carry.
        failure: { code: "endpoint.restic_failed", transient: false },
      });
      expect(payload.data.endpoint.id).toBe(who.endpointId);
    }, 30_000);

    it("explains a failed run: the agent's codes become a stored, translated-by-code cause with steps", async () => {
      const who = await enrolled("server");
      const { runId, finish } = await finishedBackup(who, {
        status: "failed",
        snapshotId: undefined,
        sample: undefined,
        errors: [
          { message: "exit status 1", code: "read_error", path: "/srv/db.lock" },
          { message: "dump command failed: exit 2", code: "pre_hook_failed" },
        ],
      });
      expect(finish.status).toBe(200);
      const [row] = await fixture.db.select().from(endpointRuns).where(eq(endpointRuns.id, runId));
      expect(row?.failure).toMatchObject({
        v: 1,
        code: "endpoint.pre_hook_failed",
        params: { count: 2 },
      });
      const run = await service.getRun(shared.db, fixture.tenantId, who.endpointId, runId);
      expect(run.failure).toMatchObject({
        code: "endpoint.pre_hook_failed",
        category: "endpoint",
        transient: false,
        retryable: true,
      });
      expect(run.failure?.steps.map((step) => step.id)).toEqual([
        "check_endpoint_hooks",
        "read_technical_details",
      ]);
      const detail = await service.getEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        instance.url,
      );
      expect(detail.attention).toContain("last_backup_failed");
      expect(
        detail.problems.find((problem) => problem.attention === "last_backup_failed")?.failure.code,
      ).toBe("endpoint.pre_hook_failed");
      expect(detail.runs[0]?.failure?.code).toBe("endpoint.pre_hook_failed");
    }, 30_000);

    it("stores no explanation for a good run, and a neutral one for an interruption", async () => {
      const who = await enrolled("server");
      const good = await finishedBackup(who);
      const goodRun = await service.getRun(shared.db, fixture.tenantId, who.endpointId, good.runId);
      expect(goodRun.failure).toBeNull();
      const partial = await finishedBackup(who, {
        status: "partial",
        errors: [{ message: "permission denied", code: "read_error", path: "/srv/x" }],
      });
      const partialRun = await service.getRun(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        partial.runId,
      );
      expect(partialRun.failure?.code).toBe("endpoint.read_error");
      const cut = await finishedBackup(who, {
        status: "failed",
        snapshotId: undefined,
        sample: undefined,
        errors: [{ message: "restarted", code: "interrupted" }],
      });
      const cutRun = await service.getRun(shared.db, fixture.tenantId, who.endpointId, cut.runId);
      expect(cutRun.failure).toMatchObject({ code: "endpoint.interrupted", transient: true });
    }, 60_000);

    it("does not treat a run the agent lost to a restart as a failure", async () => {
      const who = await enrolled("server");
      const hookId = randomUUID();
      await fixture.db.insert(webhooks).values({
        id: hookId,
        tenantId: fixture.tenantId,
        name: "RMM",
        url: "https://rmm.example/hook",
        events: ["job.failed"],
      });
      const { runId, finish } = await finishedBackup(who, {
        status: "failed",
        snapshotId: undefined,
        sample: undefined,
        errors: [{ message: "the agent was restarted", code: "interrupted" }],
      });
      expect(finish.status).toBe(200);
      const row = await endpointRow(who.endpointId);
      // No outcome: no webhook, and the machine's last backup is not moved.
      expect(row?.lastBackupAt).toBeNull();
      expect(
        await fixture.db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.webhookId, hookId)),
      ).toHaveLength(0);
      const run = await service.getRun(shared.db, fixture.tenantId, who.endpointId, runId);
      expect(run).toMatchObject({ status: "failed" });
      expect(run.errors[0]?.code).toBe("interrupted");
    }, 30_000);

    /** A delivered restore-test task of the newest backup, started and finished with `finish`. */
    async function agentRestoreTest(
      who: Enrolled,
      finish: Record<string, unknown>,
      params: Record<string, unknown> = {},
    ) {
      const [task] = await fixture.db
        .insert(endpointTasks)
        .values({
          tenantId: fixture.tenantId,
          endpointId: who.endpointId,
          kind: "verify_sample",
          params: {
            snapshotId: SNAPSHOT,
            files: [{ path: "/etc/hosts", sha256: sha256("hosts") }],
            ...params,
          },
          status: "delivered",
        })
        .returning();
      const start = await agentRequest(who, "/runs", {
        body: { kind: "verify_sample", taskId: task?.id, startedAt: new Date().toISOString() },
      });
      expect(start.status).toBe(201);
      const { runId } = (await start.json()) as { runId: string };
      const finished = await agentRequest(who, `/runs/${runId}/finish`, {
        body: { finishedAt: new Date().toISOString(), logTail: "", errors: [], ...finish },
      });
      expect(finished.status).toBe(200);
      return { taskId: task?.id ?? "", runId };
    }

    const reportsOf = (endpointId: string) =>
      fixture.db.select().from(endpointReports).where(eq(endpointReports.endpointId, endpointId));
    const verifyTasksOf = (endpointId: string) =>
      fixture.db
        .select()
        .from(endpointTasks)
        .where(
          and(eq(endpointTasks.endpointId, endpointId), eq(endpointTasks.kind, "verify_sample")),
        );
    async function listeningWebhook(): Promise<string> {
      const hookId = randomUUID();
      await fixture.db.insert(webhooks).values({
        id: hookId,
        tenantId: fixture.tenantId,
        name: "RMM",
        url: "https://rmm.example/hook",
        events: ["job.failed"],
      });
      return hookId;
    }
    const deliveriesOf = (hookId: string) =>
      fixture.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, hookId));

    it("rates the agent's restore test red on a hash that differs and completes its task", async () => {
      const who = await enrolled("server");
      await finishedBackup(who);
      const { taskId, runId } = await agentRestoreTest(who, {
        status: "failed",
        snapshotId: SNAPSHOT,
        errors: [{ path: "/etc/hosts", message: "SHA-256 mismatch", code: "hash_mismatch" }],
        restoreTest: { files: [{ path: "/etc/hosts", sha256: sha256("tampered") }] },
      });
      const [report] = await reportsOf(who.endpointId);
      expect(report).toMatchObject({
        kind: "restore_test",
        origin: "agent",
        snapshotId: SNAPSHOT,
        readiness: "red",
        runId,
        summary: { files: 1, matched: 0 },
      });
      expect(report?.summary.mismatched).toEqual([
        { path: "/etc/hosts", expected: sha256("hosts"), actual: sha256("tampered") },
      ]);
      expect((await endpointRow(who.endpointId))?.lastRestoreTestAt).toBeInstanceOf(Date);
      const tasks = await verifyTasksOf(who.endpointId);
      // The test completed: nothing is offered again.
      expect(tasks).toHaveLength(1);
      expect(tasks.find((task) => task.id === taskId)?.status).toBe("failed");
      // Proven broken: the web app shows the run and the request as failed, not as incomplete.
      const detail = await service.getEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        instance.url,
      );
      expect(detail.runs.find((run) => run.id === runId)?.checkIncomplete).toBe(false);
      expect(detail.recentTasks.find((task) => task.id === taskId)).toMatchObject({
        status: "failed",
        checkIncomplete: false,
      });
      const run = await service.getRun(shared.db, fixture.tenantId, who.endpointId, runId);
      expect(run.checkIncomplete).toBe(false);
    }, 30_000);

    it("rates the agent's restore test red when restic reports the data missing", async () => {
      const who = await enrolled("server");
      await finishedBackup(who);
      await agentRestoreTest(who, {
        status: "failed",
        errors: [{ message: "restic restore failed (exit code 1)", code: "restic_exit_1" }],
        restoreTest: {
          files: [{ path: "/etc/hosts", missing: true }],
          restic: {
            exitCode: 1,
            fatal: "Fatal: There were 2 errors",
            errors: [
              {
                item: "/etc/hosts",
                message: "ReadFull(<data/6e73100d78>): <data/6e73100d78> does not exist",
              },
              { item: "/etc/hosts", message: "lchown /x/etc/hosts: no such file or directory" },
            ],
          },
        },
      });
      const [report] = await reportsOf(who.endpointId);
      expect(report?.readiness).toBe("red");
      expect(report?.summary.mismatched?.[0]).toMatchObject({
        path: "/etc/hosts",
        actual: null,
        reason: "ReadFull(<data/6e73100d78>): <data/6e73100d78> does not exist",
      });
    }, 30_000);

    it("rates the agent's restore test green when every hash matches, from a new and an older agent", async () => {
      const who = await enrolled("server");
      await finishedBackup(who);
      await agentRestoreTest(who, {
        status: "succeeded",
        snapshotId: SNAPSHOT,
        restoreTest: { files: [{ path: "/etc/hosts", sha256: sha256("hosts") }] },
      });
      // An agent before the `restoreTest` field reports its own pass.
      await agentRestoreTest(who, { status: "succeeded", snapshotId: SNAPSHOT });
      const reports = await reportsOf(who.endpointId);
      expect(reports.map((report) => report.readiness)).toEqual(["green", "green"]);
      expect(reports[0]?.summary).toMatchObject({ files: 1, matched: 1, mismatched: [] });
      const runs = await service.listRuns(shared.db, fixture.tenantId, who.endpointId, 10);
      expect(
        runs.items.filter((run) => run.kind === "verify_sample").map((run) => run.checkIncomplete),
      ).toEqual([false, false]);
      const rating = await shared.db.transaction(async (tx) => {
        await tx.execute(await pin(fixture.tenantId));
        return readiness.loadEndpointReadiness(tx, fixture.tenantId, [who.endpointId]);
      });
      expect(rating.get(who.endpointId)?.state).toBe("green");
    }, 30_000);

    it("rates nothing when the agent's restore test could not complete, and offers it again later", async () => {
      const who = await enrolled("server");
      await finishedBackup(who);
      const hookId = await listeningWebhook();
      const before = Date.now();
      const first = await agentRestoreTest(who, {
        status: "failed",
        errors: [{ message: "restic restore failed (exit code 1)", code: "restic_exit_1" }],
        restoreTest: {
          files: [{ path: "/etc/hosts", missing: true }],
          restic: {
            exitCode: 1,
            fatal: "Fatal: There were 1 errors",
            errors: [
              { item: "/etc/hosts", message: "write /x/etc/hosts: no space left on device" },
            ],
          },
        },
      });
      // No rating, no change of the last test, no webhook: the backup proved nothing either way.
      expect(await reportsOf(who.endpointId)).toEqual([]);
      expect((await endpointRow(who.endpointId))?.lastRestoreTestAt).toBeNull();
      expect(await deliveriesOf(hookId)).toEqual([]);
      const run = await service.getRun(shared.db, fixture.tenantId, who.endpointId, first.runId);
      expect(run.status).toBe("failed");
      // Shown as a check that could not complete, never as a failed one.
      expect(run.checkIncomplete).toBe(true);
      const detail = await service.getEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        instance.url,
      );
      expect(detail.runs.find((item) => item.id === first.runId)?.checkIncomplete).toBe(true);
      expect(detail.latestRun).toMatchObject({ id: first.runId, checkIncomplete: true });
      expect(detail.recentTasks.find((task) => task.id === first.taskId)).toMatchObject({
        status: "failed",
        checkIncomplete: true,
      });
      expect(detail.attention).not.toContain("restore_test_failed");
      const listed = await service.listEndpoints(shared.db, fixture.tenantId);
      expect(
        listed.items.find((item) => item.id === who.endpointId)?.latestRun?.checkIncomplete,
      ).toBe(true);

      // The same files are offered again as a new task, in an hour.
      const tasks = await verifyTasksOf(who.endpointId);
      expect(tasks.find((task) => task.id === first.taskId)?.status).toBe("failed");
      const again = tasks.find((task) => task.id !== first.taskId);
      expect(again).toMatchObject({
        status: "pending",
        params: {
          snapshotId: SNAPSHOT,
          files: [{ path: "/etc/hosts", sha256: sha256("hosts") }],
          retry: 1,
        },
      });
      const notBefore = Date.parse(String(again?.params.notBefore));
      expect(notBefore - before).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1000);
      expect(notBefore - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
      expect(again?.expiresAt?.getTime()).toBe(notBefore + 7 * 24 * 60 * 60 * 1000);

      // Not before its time: the heartbeats in between hand nothing out.
      const heartbeat = { agentVersion: "0.1.0", osVersion: "Debian 12", state: "idle" };
      const early = await agentRequest(who, "/heartbeat", { body: heartbeat });
      expect(((await early.json()) as { tasks: unknown[] }).tasks).toEqual([]);
      await fixture.db
        .update(endpointTasks)
        .set({
          params: { ...again?.params, notBefore: new Date(Date.now() - 1000).toISOString() },
        })
        .where(eq(endpointTasks.id, again?.id ?? ""));
      const due = await agentRequest(who, "/heartbeat", { body: heartbeat });
      expect(
        ((await due.json()) as { tasks: { id: string }[] }).tasks.map((task) => task.id),
      ).toEqual([again?.id]);
    }, 30_000);

    it.each([
      [
        "an older agent that failed without saying why",
        { errors: [{ message: "sha256 differs", path: "/etc/hosts" }] },
      ],
      ["an agent stopped mid-test", { errors: [{ message: "stopped", code: "interrupted" }] }],
      [
        "a busy repository",
        {
          errors: [{ message: "locked", code: "restic_exit_11" }],
          restoreTest: {
            files: [{ path: "/etc/hosts", missing: true }],
            restic: { exitCode: 11, fatal: "Fatal: repository is already locked", errors: [] },
          },
        },
      ],
      [
        "a file the agent could not read",
        {
          errors: [{ message: "unreadable", code: "read_error", path: "/etc/hosts" }],
          restoreTest: { files: [{ path: "/etc/hosts", error: "input/output error" }] },
        },
      ],
      ["a report that does not fit the protocol", { restoreTest: { files: "nonsense" } }],
    ])(
      "is incomplete, not red, after %s",
      async (_name, finish) => {
        const who = await enrolled("server");
        await finishedBackup(who);
        await agentRestoreTest(who, { status: "failed", ...finish });
        expect(await reportsOf(who.endpointId)).toEqual([]);
        expect((await endpointRow(who.endpointId))?.lastRestoreTestAt).toBeNull();
        expect(await verifyTasksOf(who.endpointId)).toHaveLength(2);
      },
      30_000,
    );

    it("offers an incomplete test again only for the newest backup and with waits left", async () => {
      const who = await enrolled("server");
      await finishedBackup(who);
      const incomplete = {
        status: "failed",
        errors: [{ message: "stopped", code: "interrupted" }],
      };
      // The last wait is used up: the next backup brings a new test.
      await agentRestoreTest(who, incomplete, { retry: 6 });
      expect(await verifyTasksOf(who.endpointId)).toHaveLength(1);
      // A later wait doubles.
      const now = Date.now();
      await agentRestoreTest(who, incomplete, { retry: 2 });
      const third = (await verifyTasksOf(who.endpointId)).find((task) => task.status === "pending");
      expect(third?.params.retry).toBe(3);
      expect(Date.parse(String(third?.params.notBefore)) - now).toBeGreaterThanOrEqual(
        4 * 60 * 60 * 1000 - 1000,
      );
      // Not a second time while one waits.
      await agentRestoreTest(who, incomplete);
      expect(
        (await verifyTasksOf(who.endpointId)).filter((task) => task.status === "pending"),
      ).toHaveLength(1);
      // Not for a backup that is no longer the newest; and a snapshot gone since proves nothing.
      const other = await enrolled("server");
      await finishedBackup(other);
      await finishedBackup(other, { snapshotId: "b2".repeat(32) });
      await agentRestoreTest(other, {
        status: "failed",
        errors: [{ message: "restic restore failed", code: "restic_exit_1" }],
        restoreTest: {
          files: [{ path: "/etc/hosts", missing: true }],
          restic: {
            exitCode: 1,
            fatal: `Fatal: failed to find snapshot: failed to load snapshot a1a1a1a1: <snapshot/${"a1".repeat(5)}> does not exist`,
            errors: [],
          },
        },
      });
      expect(await reportsOf(other.endpointId)).toEqual([]);
      expect(await verifyTasksOf(other.endpointId)).toHaveLength(1);
    }, 60_000);

    it("refuses a task that does not fit the run and one that is finished", async () => {
      const who = await enrolled("server");
      const [task] = await fixture.db
        .insert(endpointTasks)
        .values({
          tenantId: fixture.tenantId,
          endpointId: who.endpointId,
          kind: "restore",
          params: {},
          status: "delivered",
        })
        .returning();
      const mismatch = await agentRequest(who, "/runs", {
        body: { kind: "backup", taskId: task?.id, startedAt: new Date().toISOString() },
      });
      expect(mismatch.status).toBe(409);
      const unknown = await agentRequest(who, "/runs", {
        body: { kind: "restore", taskId: randomUUID(), startedAt: new Date().toISOString() },
      });
      expect(unknown.status).toBe(404);
    }, 30_000);

    it("bounds what an agent can make the server store", async () => {
      const who = await enrolled("server");
      const start = await agentRequest(who, "/runs", {
        body: { kind: "backup", startedAt: new Date().toISOString() },
      });
      const { runId } = (await start.json()) as { runId: string };
      const tooMany = await agentRequest(who, `/runs/${runId}/finish`, {
        body: {
          status: "succeeded",
          finishedAt: new Date().toISOString(),
          snapshotId: SNAPSHOT,
          sample: Array.from({ length: 21 }, (_, i) => ({
            path: `/f${i}`,
            sha256: sha256(String(i)),
            size: 1,
          })),
          errors: [],
          logTail: "",
        },
      });
      expect(tooMany.status).toBe(422);
      const long = "x\n".repeat(60_000);
      const finish = await agentRequest(who, `/runs/${runId}/finish`, {
        body: { status: "failed", finishedAt: new Date().toISOString(), errors: [], logTail: long },
      });
      expect(finish.status).toBe(200);
      const [row] = await fixture.db.select().from(endpointRuns).where(eq(endpointRuns.id, runId));
      expect(Buffer.byteLength(row?.logTail ?? "")).toBeLessThanOrEqual(20 * 1024);
    }, 30_000);

    it("keeps the lower-case form of a snapshot id an agent sends in upper case", async () => {
      const who = await enrolled("server");
      const { runId, finish } = await finishedBackup(who, { snapshotId: SNAPSHOT.toUpperCase() });
      expect(finish.status).toBe(200);
      const [row] = await fixture.db.select().from(endpointRuns).where(eq(endpointRuns.id, runId));
      expect(row?.snapshotId).toBe(SNAPSHOT);
      expect((await endpointRow(who.endpointId))?.lastSnapshotId).toBe(SNAPSHOT);
    }, 30_000);

    it("stores what an agent reports without credentials", async () => {
      const who = await enrolled("server");
      const leaked = `rsea_${"Q".repeat(43)}`;
      const { runId, finish } = await finishedBackup(who, {
        status: "partial",
        errors: [
          { path: "/srv/db", message: `pre hook said password=${leaked}`, code: "read_error" },
        ],
        logTail: `Backup started.\nhook: curl -u backup:${leaked} https://db.internal/x\nFiles:   3 new`,
      });
      expect(finish.status).toBe(200);
      const [row] = await fixture.db.select().from(endpointRuns).where(eq(endpointRuns.id, runId));
      expect(JSON.stringify(row?.errors)).not.toContain(leaked);
      expect(row?.errors[0]?.message).toBe("pre hook said password=[redacted]");
      expect(row?.logTail).not.toContain(leaked);
      expect(row?.logTail?.split("\n")).toEqual([
        "Backup started.",
        expect.stringContaining("[redacted]"),
        "Files:   3 new",
      ]);
    }, 30_000);
  });

  describe("the restic endpoint's records: locks and storage use", () => {
    const resticRequest = (
      who: Enrolled,
      path: string,
      init: { method?: string; body?: Buffer; headers?: Record<string, string> } = {},
    ) =>
      app.request(`/agent/restic/${who.endpointId}${path}`, {
        method: init.method ?? "GET",
        headers: {
          ...basic(who.endpointId, who.agentSecret),
          "x-forwarded-for": "192.0.2.201",
          ...init.headers,
        },
        body: init.body ? new Uint8Array(init.body) : undefined,
      });
    const lockRows = (endpointId: string) =>
      fixture.db
        .select()
        .from(endpointRepositoryLocks)
        .where(eq(endpointRepositoryLocks.endpointId, endpointId));

    it("records the agent's locks and lets it release only those", async () => {
      const who = await enrolled("server");
      const lock = Buffer.from("the agent's lock");
      const written = await resticRequest(who, `/locks/${sha256(lock)}`, {
        method: "POST",
        body: lock,
      });
      expect(written.status).toBe(200);
      expect((await lockRows(who.endpointId)).map((row) => row.name)).toEqual([sha256(lock)]);
      expect(
        (await resticRequest(who, `/locks/${sha256(lock)}`, { method: "DELETE" })).status,
      ).toBe(200);
      expect(await lockRows(who.endpointId)).toEqual([]);

      // A lock the server wrote (its exclusive prune lock) stays, and the attempt is audited.
      const serverLock = Buffer.from('{"exclusive":true}');
      const storage = new LocalStorageBackend(fixture.storageDir);
      const key = `${endpointPrefix(who.endpointId)}locks/${sha256(serverLock)}`;
      await storage.put(key, serverLock);
      const refused = await resticRequest(who, `/locks/${sha256(serverLock)}`, {
        method: "DELETE",
      });
      expect(refused.status).toBe(403);
      expect(await storage.head(key)).not.toBeNull();
      // The audit entry is written after the answer: wait for it, but not for ever.
      const deniedEntry = async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const [entry] = await fixture.db
            .select()
            .from(auditLog)
            .where(
              and(
                eq(auditLog.action, "endpoint.repository.denied"),
                eq(auditLog.target, who.endpointId),
              ),
            );
          if (entry) return entry;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return undefined;
      };
      expect((await deniedEntry())?.details).toMatchObject({
        action: "delete",
        type: "locks",
        reason: "foreign_lock",
      });
    }, 30_000);

    it("counts what the repository takes and refuses an upload over the storage budget", async () => {
      const who = await enrolled("server");
      const storage = new LocalStorageBackend(fixture.storageDir);
      const small = Buffer.alloc(100, 1);
      expect(
        (await resticRequest(who, `/data/${sha256(small)}`, { method: "POST", body: small }))
          .status,
      ).toBe(200);
      const measured = (await endpointRow(who.endpointId))?.repositoryBytes ?? 0;
      expect(measured).toBe(await measureRepositoryBytes(storage, endpointPrefix(who.endpointId)));

      // A budget that leaves room for 500 more bytes.
      const previous = process.env.RESTOW_ENDPOINT_QUOTA_GIB;
      process.env.RESTOW_ENDPOINT_QUOTA_GIB = String((measured + 500) / 1024 ** 3);
      try {
        const big = Buffer.alloc(2048, 2);
        const refused = await resticRequest(who, `/data/${sha256(big)}`, {
          method: "POST",
          body: big,
          headers: { "content-length": String(big.length) },
        });
        expect(refused.status).toBe(403);
        expect(refused.headers.get("content-type")).toBe("application/problem+json");
        expect(await refused.json()).toMatchObject({
          type: "urn:restow:problem:endpoint-quota-exceeded",
        });
        expect(
          await storage.head(
            `${endpointPrefix(who.endpointId)}data/${sha256(big).slice(0, 2)}/${sha256(big)}`,
          ),
        ).toBeNull();
        expect((await endpointRow(who.endpointId))?.quotaRefusedAt).toBeInstanceOf(Date);
        // A lock still goes in: a restore on the machine needs one.
        const lock = Buffer.from("restore lock");
        expect(
          (await resticRequest(who, `/locks/${sha256(lock)}`, { method: "POST", body: lock }))
            .status,
        ).toBe(200);
        // What fits is stored and counted.
        const fits = Buffer.alloc(200, 3);
        expect(
          (await resticRequest(who, `/data/${sha256(fits)}`, { method: "POST", body: fits }))
            .status,
        ).toBe(200);
        expect((await endpointRow(who.endpointId))?.repositoryBytes).toBe(
          measured + lock.length + fits.length,
        );
        const detail = await service.getEndpoint(
          shared.db,
          fixture.tenantId,
          who.endpointId,
          instance.url,
        );
        expect(detail.storage).toMatchObject({
          usedBytes: measured + lock.length + fits.length,
          level: "exceeded",
        });
      } finally {
        if (previous === undefined) {
          Reflect.deleteProperty(process.env, "RESTOW_ENDPOINT_QUOTA_GIB");
        } else {
          process.env.RESTOW_ENDPOINT_QUOTA_GIB = previous;
        }
      }
    }, 30_000);

    it("lets an admin give an endpoint a budget of its own and take it back", async () => {
      const who = await enrolled("server");
      await service.updateEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        { settings: { quotaGib: 3000 } },
        actor(),
      );
      let detail = await service.getEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        instance.url,
      );
      expect(detail.settings.quotaGib).toBe(3000);
      expect(detail.storage).toMatchObject({ budgetBytes: 3000 * 1024 ** 3, ownBudget: true });
      await service.updateEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        { settings: { quotaGib: null } },
        actor(),
      );
      detail = await service.getEndpoint(shared.db, fixture.tenantId, who.endpointId, instance.url);
      expect(detail.settings.quotaGib).toBeNull();
      // The installation's default: 2 TiB per endpoint.
      expect(detail.storage).toMatchObject({ budgetBytes: 2048 * 1024 ** 3, ownBudget: false });
      expect((await endpointRow(who.endpointId))?.settings).not.toHaveProperty("quotaGib");
    }, 30_000);
  });

  describe("the repository box on the detail page", () => {
    it("takes the newest retention run and check however many restore tests came after them", async () => {
      const who = await enrolled("server");
      const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60 * 1000);
      await fixture.db.insert(endpointReports).values([
        {
          tenantId: fixture.tenantId,
          endpointId: who.endpointId,
          kind: "retention" as const,
          origin: "server" as const,
          readiness: null,
          summary: { removedSnapshots: 0, keptSnapshots: 9, repositoryBytes: 123_456 },
          checkedAt: at(500),
        },
        {
          tenantId: fixture.tenantId,
          endpointId: who.endpointId,
          kind: "repository_check" as const,
          origin: "server" as const,
          readiness: "green" as const,
          summary: { subset: "1/20" },
          checkedAt: at(490),
        },
        // A month of daily restore tests (and the agent's own), all newer.
        ...Array.from({ length: 40 }, (_, n) => ({
          tenantId: fixture.tenantId,
          endpointId: who.endpointId,
          kind: "restore_test" as const,
          origin: n % 2 === 0 ? ("server" as const) : ("agent" as const),
          snapshotId: "a1".repeat(32),
          readiness: "green" as const,
          summary: { files: 3, matched: 3 },
          checkedAt: at(400 - n),
        })),
      ]);
      const detail = await service.getEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        instance.url,
      );
      expect(detail.repository).toMatchObject({ bytes: 123_456, snapshots: 9 });
      expect(detail.reports.map((report) => report.kind)).toEqual(
        expect.arrayContaining(["retention", "repository_check", "restore_test"]),
      );
      // Newest first, the latest of every kind included once.
      expect(detail.reports.filter((report) => report.kind === "retention")).toHaveLength(1);
      const times = detail.reports.map((report) => Date.parse(report.checkedAt));
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    }, 30_000);
  });

  describe("update offer", () => {
    it("has nothing to offer without a shipped agent", async () => {
      const who = await enrolled("server");
      const response = await agentRequest(who, "/update");
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
    }, 30_000);

    it("offers a signed release unless the tenant paused agent updates, also for machines enrolled later", async () => {
      const dist = await mkdtemp(join(tmpdir(), "restow-agent-offer-"));
      const previous = process.env.RESTOW_AGENT_DIR;
      process.env.RESTOW_AGENT_DIR = dist;
      try {
        const binary = "agent 9.0.0";
        await mkdir(join(dist, "9.0.0", "linux-amd64"), { recursive: true });
        await writeFile(join(dist, "9.0.0", "linux-amd64", "restow-agent"), binary);
        await writeFile(
          join(dist, "9.0.0", "SHA256SUMS"),
          `${sha256(binary)}  linux-amd64/restow-agent\n`,
        );
        const tenant = await freshTenant("Update switch tenant");
        const offer = async (who: Enrolled) =>
          (await (await agentRequest(who, "/update")).json()) as { version: string } | null;

        // The pause is a setting of the tenant: it can be set before the first machine exists.
        expect(await service.getAgentUpdates(shared.db, tenant)).toEqual({
          paused: false,
          endpoints: 0,
          overrides: [],
        });
        expect(await service.setAgentUpdates(shared.db, tenant, true, actor())).toEqual({
          paused: true,
          endpoints: 0,
          overrides: [],
        });
        // A machine enrolled while paused is covered by it, without carrying a flag of its own.
        const first = await enrolled("server", tenant);
        await writeFile(join(dist, "9.0.0", "SHA256SUMS.sig"), "-----BEGIN SSH SIGNATURE-----\n");
        expect(await offer(first)).toBeNull();
        const [row] = await fixture.db
          .select({ settings: endpoints.settings })
          .from(endpoints)
          .where(eq(endpoints.id, first.endpointId));
        expect(row?.settings.autoUpdatePaused).toBeUndefined();
        expect(await service.getAgentUpdates(shared.db, tenant)).toEqual({
          paused: true,
          endpoints: 1,
          overrides: [],
        });
        // Another tenant is not affected.
        const other = await enrolled("server");
        expect(await offer(other)).toMatchObject({ version: "9.0.0", sha256: sha256(binary) });

        // Resumed: every machine of the tenant gets the release, also one that enrolled later.
        await service.setAgentUpdates(shared.db, tenant, false, actor());
        const later = await enrolled("client", tenant);
        expect(await offer(first)).toMatchObject({ version: "9.0.0" });
        expect(await offer(later)).toMatchObject({ version: "9.0.0" });

        // A machine paused on its own (how the pause was kept before it became the tenant's
        // setting) stays paused, is listed as an override, and is lifted on its own or all at once.
        await fixture.db
          .update(endpoints)
          .set({ settings: { autoUpdatePaused: true } })
          .where(eq(endpoints.id, first.endpointId));
        expect(await offer(first)).toBeNull();
        expect(await offer(later)).toMatchObject({ version: "9.0.0" });
        const listed = await service.getAgentUpdates(shared.db, tenant);
        expect(listed.paused).toBe(false);
        expect(listed.overrides).toHaveLength(1);
        expect(listed.overrides[0]).toMatchObject({ id: first.endpointId, profile: "server" });
        // The detail says why the machine is paused.
        const detail = await service.getEndpoint(shared.db, tenant, first.endpointId, instance.url);
        expect(detail).toMatchObject({ autoUpdatePaused: true, autoUpdateOwnPause: true });
        // Resuming the tenant leaves the override alone ...
        await service.setAgentUpdates(shared.db, tenant, true, actor());
        await service.setAgentUpdates(shared.db, tenant, false, actor());
        expect(await offer(first)).toBeNull();
        // ... unless asked to lift them as well.
        await service.setAgentUpdates(shared.db, tenant, false, actor(), { resumeMachines: true });
        expect(await offer(first)).toMatchObject({ version: "9.0.0" });
        expect((await service.getAgentUpdates(shared.db, tenant)).overrides).toEqual([]);
        // One machine's own pause can also be lifted by itself.
        await fixture.db
          .update(endpoints)
          .set({ settings: { autoUpdatePaused: true } })
          .where(eq(endpoints.id, later.endpointId));
        expect(await offer(later)).toBeNull();
        await service.resumeMachineUpdates(shared.db, tenant, later.endpointId, actor());
        expect(await offer(later)).toMatchObject({ version: "9.0.0" });
        await expect(
          service.resumeMachineUpdates(shared.db, tenant, randomUUID(), actor()),
        ).rejects.toMatchObject({ status: 404 });

        const actions = (
          await fixture.db.select().from(auditLog).where(eq(auditLog.tenantId, tenant))
        ).map((entry) => entry.action);
        expect(actions).toEqual(
          expect.arrayContaining(["endpoint.updates.paused", "endpoint.updates.resumed"]),
        );
      } finally {
        if (previous === undefined) {
          Reflect.deleteProperty(process.env, "RESTOW_AGENT_DIR");
        } else {
          process.env.RESTOW_AGENT_DIR = previous;
        }
        await rm(dist, { recursive: true, force: true });
      }
    }, 60_000);
  });

  describe("hooks are the machine's decision", () => {
    it("refuses hooks until the agent reports that the machine allows them", async () => {
      const who = await enrolled("server");
      const set = (hooks: { pre?: string; post?: string }) =>
        service.updateEndpoint(
          shared.db,
          fixture.tenantId,
          who.endpointId,
          { config: { hooks } },
          actor(),
        );
      await service.updateEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        { settings: { retention: { keepDaily: 3, keepWeekly: 2, keepMonthly: 1 } } },
        actor(),
      );
      // An earlier pre-release agent reports no policy: no hooks can be set.
      await expect(set({ pre: "pg_dumpall > /srv/all.sql" })).rejects.toMatchObject({
        status: 409,
        type: "urn:restow:problem:endpoint-hooks-not-allowed",
      });
      const beat = (extra: Record<string, unknown>) =>
        agentRequest(who, "/heartbeat", {
          body: {
            agentVersion: "0.1.1",
            osVersion: "",
            state: "idle",
            nextRunAt: null,
            configVersion: 1,
            ...extra,
          },
        });
      expect((await beat({ hooks: "off" })).status).toBe(200);
      await expect(set({ pre: "pg_dumpall > /srv/all.sql" })).rejects.toMatchObject({
        status: 409,
      });

      expect((await beat({ hooks: "scripts", hookScripts: ["db-dump", "../x"] })).status).toBe(200);
      await expect(set({ pre: "pg_dumpall > /srv/all.sql" })).rejects.toMatchObject({
        status: 422,
        type: "urn:restow:problem:endpoint-hook-not-a-script",
      });
      expect((await set({ pre: "db-dump" })).changed).toEqual(["config.hooks"]);

      expect((await beat({ hooks: "any" })).status).toBe(200);
      expect((await set({ pre: "pg_dumpall > /srv/all.sql" })).changed).toEqual(["config.hooks"]);

      const [row] = await fixture.db
        .select()
        .from(endpoints)
        .where(eq(endpoints.id, who.endpointId));
      // The heartbeat only touched the agent's facts; the admin's retention stayed.
      expect(row?.settings).toMatchObject({
        retention: { keepDaily: 3, keepWeekly: 2, keepMonthly: 1 },
        agent: { hooks: "any" },
      });

      // Clearing is always possible, also after the machine switched hooks off.
      expect((await beat({ hooks: "off" })).status).toBe(200);
      expect((await set({})).changed).toEqual(["config.hooks"]);
    }, 60_000);

    it("asks for a recent sign-in before a hook is set or changed, never before all are removed", async () => {
      const who = await enrolled("server", fixture.tenantId, "linux", { hooks: "any" });
      // What the route's step-up check throws for an older session (lib/recent-sign-in.ts).
      const refused = new Error("Confirm it is you");
      const asked = vi.fn();
      const change = (
        input: Parameters<typeof service.updateEndpoint>[3],
        confirm: () => void = () => {
          asked();
          throw refused;
        },
      ) =>
        service.updateEndpoint(shared.db, fixture.tenantId, who.endpointId, input, actor(), {
          confirmHookChange: confirm,
        });
      const hooksOf = async () => (await endpointRow(who.endpointId))?.config.hooks;
      const before = await endpointRow(who.endpointId);

      // Refused: nothing of the change is kept, also not the name sent along with it.
      await expect(
        change({ displayName: "db-1", config: { hooks: { pre: "pg_dumpall > /srv/all.sql" } } }),
      ).rejects.toBe(refused);
      expect(asked).toHaveBeenCalledTimes(1);
      expect(await hooksOf()).toEqual({});
      expect(await endpointRow(who.endpointId)).toMatchObject({
        displayName: before?.displayName ?? null,
        configVersion: before?.configVersion,
      });

      // Confirmed: set, then changed (one of two removed still leaves a hook to run).
      const confirmed = vi.fn();
      await change({ config: { hooks: { pre: "a", post: "b" } } }, confirmed);
      await change({ config: { hooks: { pre: "a" } } }, confirmed);
      expect(confirmed).toHaveBeenCalledTimes(2);
      expect(await hooksOf()).toEqual({ pre: "a" });

      // No question for a change that leaves the hooks alone, or that removes every hook.
      asked.mockClear();
      expect((await change({ config: { paths: ["/srv"], hooks: { pre: "a" } } })).changed).toEqual([
        "config.paths",
      ]);
      expect((await change({ config: { hooks: { pre: "", post: "" } } })).changed).toEqual([
        "config.hooks",
      ]);
      expect(asked).not.toHaveBeenCalled();
      expect(await hooksOf()).toEqual({});
    }, 60_000);

    it("shows the hook texts only to who may change the configuration", async () => {
      const who = await enrolled("server", fixture.tenantId, "linux", { hooks: "scripts" });
      const detail = await service.getEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        instance.url,
      );
      expect(detail.hooks).toMatchObject({ policy: "scripts", scripts: [], visible: false });
      await agentRequest(who, "/heartbeat", {
        body: {
          agentVersion: "0.1.1",
          osVersion: "",
          state: "idle",
          nextRunAt: null,
          hooks: "any",
        },
      });
      await service.updateEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        { config: { hooks: { pre: "mysqldump -pS3cret app > /srv/app.sql" } } },
        actor(),
      );
      const limited = await service.getEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        instance.url,
        {
          revealHooks: false,
        },
      );
      expect(limited.config.hooks).toEqual({});
      expect(limited.hooks.pre.set).toBe(true);
      expect(limited.hooks.pre.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(JSON.stringify(limited)).not.toContain("S3cret");
      const full = await service.getEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        instance.url,
        {
          revealHooks: true,
        },
      );
      expect(full.config.hooks.pre).toContain("mysqldump");
      expect(full.hooks.visible).toBe(true);
    }, 60_000);
  });

  describe("install files", () => {
    it("serves the signed checksums byte for byte and writes the release key into the scripts", async () => {
      const dist = await mkdtemp(join(tmpdir(), "restow-agent-install-"));
      const keep = {
        dir: process.env.RESTOW_AGENT_DIR,
        install: process.env.RESTOW_AGENT_INSTALL_DIR,
      };
      process.env.RESTOW_AGENT_DIR = dist;
      process.env.RESTOW_AGENT_INSTALL_DIR = join(dist, "install");
      try {
        const key =
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMRVvWWyNWQd+TdyI0JkmmUUvnSIwVWcpYspaF0SOyZA restow-agent-release";
        const sums = `${"a".repeat(64)}  linux-amd64/restow-agent\r\n${"b".repeat(64)}  linux-amd64/restic\n`;
        await mkdir(join(dist, "install"), { recursive: true });
        await mkdir(join(dist, "1.2.3", "linux-amd64"), { recursive: true });
        await writeFile(join(dist, "1.2.3", "SHA256SUMS"), sums);
        await writeFile(
          join(dist, "1.2.3", "SHA256SUMS.sig"),
          "-----BEGIN SSH SIGNATURE-----\nx\n",
        );
        await writeFile(join(dist, "release-signing.pub"), `# the release key\n${key}\n`);
        await writeFile(
          join(dist, "install", "linux.sh"),
          "INSTANCE_URL='__RESTOW_URL__'\nAGENT_VERSION='__RESTOW_VERSION__'\nRELEASE_KEY='__RESTOW_RELEASE_KEY__'\n",
        );
        const { installRoutes } = await import("./install-routes.js");
        const { errorHandler } = await import("../../problem.js");
        const install = new Hono();
        install.onError(errorHandler);
        install.route("/install", installRoutes);
        const raw = await install.request("/install/agent/1.2.3/SHA256SUMS");
        expect(raw.status).toBe(200);
        expect(await raw.text()).toBe(sums);
        expect(
          await (await install.request("/install/agent/1.2.3/SHA256SUMS.sig")).text(),
        ).toContain("SSH SIGNATURE");
        expect((await install.request("/install/agent/1.2.3/passwd")).status).toBe(404);
        expect((await install.request("/install/agent/9.9.9/SHA256SUMS")).status).toBe(404);
        const script = await (
          await install.request("https://restow.test.example/install/linux.sh")
        ).text();
        expect(script).toContain(`RELEASE_KEY='${key}'`);
        expect(script).toContain("AGENT_VERSION='1.2.3'");
      } finally {
        for (const [name, value] of [
          ["RESTOW_AGENT_DIR", keep.dir],
          ["RESTOW_AGENT_INSTALL_DIR", keep.install],
        ] as const) {
          if (value === undefined) Reflect.deleteProperty(process.env, name);
          else process.env[name] = value;
        }
        await rm(dist, { recursive: true, force: true });
      }
    }, 60_000);
  });

  describe("tenant isolation (Row Level Security)", () => {
    it("shows a tenant only its own endpoints, tokens, runs, tasks, samples and reports", async () => {
      const mine = await enrolled("server", fixture.tenantId);
      const theirs = await enrolled("client", fixture.otherTenantId);
      await fixture.db.insert(endpointReports).values({
        tenantId: fixture.otherTenantId,
        endpointId: theirs.endpointId,
        kind: "retention",
        summary: {},
      });
      await inJob(theirs, fixture.otherTenantId);
      await service.createTask(
        shared.db,
        fixture.otherTenantId,
        theirs.endpointId,
        { kind: "backup_now" },
        actor(),
      );

      const listMine = await service.listEndpoints(shared.db, fixture.tenantId);
      const listTheirs = await service.listEndpoints(shared.db, fixture.otherTenantId);
      expect(listMine.items.map((item) => item.id)).toContain(mine.endpointId);
      expect(listMine.items.map((item) => item.id)).not.toContain(theirs.endpointId);
      expect(listTheirs.items.map((item) => item.id)).toEqual([theirs.endpointId]);

      // Direct access by id across tenants is a 404, not a leak.
      await expect(
        service.getEndpoint(shared.db, fixture.tenantId, theirs.endpointId, instance.url),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.createTask(
          shared.db,
          fixture.tenantId,
          theirs.endpointId,
          { kind: "backup_now" },
          actor(),
        ),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.revokeEndpoint(shared.db, fixture.tenantId, theirs.endpointId, actor()),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.updateEndpoint(
          shared.db,
          fixture.tenantId,
          theirs.endpointId,
          { displayName: "x" },
          actor(),
        ),
      ).rejects.toMatchObject({ status: 404 });

      const tokensMine = await service.listEnrollmentTokens(shared.db, fixture.tenantId, {
        state: "all",
      });
      const tokensTheirs = await service.listEnrollmentTokens(shared.db, fixture.otherTenantId, {
        state: "all",
      });
      const ids = new Set(tokensMine.items.map((token) => token.id));
      expect(tokensTheirs.items.every((token) => !ids.has(token.id))).toBe(true);
    }, 60_000);

    it("binds the application role: no pinned tenant, no rows; another tenant, no rows", async () => {
      const app = shared.db;
      const tables = [
        endpoints,
        endpointEnrollmentTokens,
        endpointRuns,
        endpointTasks,
        endpointSamples,
        endpointReports,
        endpointRepositoryLocks,
        endpointSnapshotFlags,
      ] as const;
      for (const table of tables) {
        const unpinned = await app.select().from(table);
        expect(unpinned, "unpinned").toEqual([]);
      }
      const { withTenantTx } = await import("../../lib/tenant-context.js");
      for (const table of tables) {
        const ownerRows = await fixture.db.select().from(table);
        const mine = await withTenantTx(app, fixture.tenantId, (tx) => tx.select().from(table));
        const theirs = await withTenantTx(app, fixture.otherTenantId, (tx) =>
          tx.select().from(table),
        );
        expect(mine.length + theirs.length).toBeLessThanOrEqual(ownerRows.length);
        for (const row of mine as { tenantId: string }[])
          expect(row.tenantId).toBe(fixture.tenantId);
        for (const row of theirs as { tenantId: string }[])
          expect(row.tenantId).toBe(fixture.otherTenantId);
      }
      // Writing a row for another tenant is refused by the policy.
      await expect(
        withTenantTx(app, fixture.tenantId, (tx) =>
          tx.insert(endpointTasks).values({
            tenantId: fixture.otherTenantId,
            endpointId: randomUUID(),
            kind: "backup_now",
          }),
        ),
      ).rejects.toThrow();
    }, 60_000);

    it("keeps an endpoint out of another tenant's repository", async () => {
      const mine = await enrolled("server", fixture.tenantId);
      const theirs = await enrolled("server", fixture.otherTenantId);
      // Own credentials, the other endpoint's URL.
      const cross = await app.request(`/agent/restic/${theirs.endpointId}/config`, {
        headers: basic(mine.endpointId, mine.agentSecret),
      });
      expect(cross.status).toBe(403);
      const own = await app.request(`/agent/restic/${mine.endpointId}/config`, {
        headers: basic(mine.endpointId, mine.agentSecret),
      });
      expect(own.status).toBe(200);
    }, 60_000);
  });

  describe("problems carry a type of their own", () => {
    it("tells a settled token from a missing one", async () => {
      const created = await token();
      await service.revokeEnrollmentToken(shared.db, fixture.tenantId, created.id, actor());
      await expect(
        service.revokeEnrollmentToken(shared.db, fixture.tenantId, created.id, actor()),
      ).rejects.toMatchObject({
        status: 409,
        type: "urn:restow:problem:endpoint-token-settled",
      });
      await expect(
        service.revokeEnrollmentToken(shared.db, fixture.tenantId, randomUUID(), actor()),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("says the address of the installation is unknown when no install command can be built", async () => {
      await expect(
        service.createEnrollmentToken(
          shared.db,
          fixture.tenantId,
          { profile: "server", os: "linux" },
          actor(),
          { url: "", configured: false },
        ),
      ).rejects.toMatchObject({
        status: 503,
        type: "urn:restow:problem:endpoint-instance-unknown",
      });
    });

    it("refuses changes, tasks and a restore test for a revoked or untested endpoint", async () => {
      const who = await enrolled("client");
      // Nothing to test before the first good backup.
      await expect(
        service.requestRestoreTest(shared.db, fixture.tenantId, who.endpointId, actor()),
      ).rejects.toMatchObject({
        status: 409,
        type: "urn:restow:problem:endpoint-nothing-to-test",
      });
      await service.revokeEndpoint(shared.db, fixture.tenantId, who.endpointId, actor());
      const revoked = { status: 409, type: "urn:restow:problem:endpoint-revoked" };
      await expect(
        service.updateEndpoint(
          shared.db,
          fixture.tenantId,
          who.endpointId,
          { displayName: "x" },
          actor(),
        ),
      ).rejects.toMatchObject(revoked);
      await expect(
        service.createTask(
          shared.db,
          fixture.tenantId,
          who.endpointId,
          { kind: "backup_now" },
          actor(),
        ),
      ).rejects.toMatchObject(revoked);
      await expect(
        service.requestUninstall(shared.db, fixture.tenantId, who.endpointId, actor()),
      ).rejects.toMatchObject(revoked);
      // The agent is told the same thing in its own terms: 401, same type.
      expect((await agentRequest(who, "/config")).status).toBe(401);
    }, 30_000);
  });

  describe("tokens and tasks on the detail page", () => {
    it("lists the valid tokens by default and every state on request", async () => {
      const tenantId = fixture.otherTenantId;
      const now = new Date();
      const open = await token("server", "linux", tenantId);
      const revoked = await token("client", "linux", tenantId);
      await service.revokeEnrollmentToken(shared.db, tenantId, revoked.id, actor());
      const used = await token("server", "linux", tenantId);
      await fixture.db
        .update(endpointEnrollmentTokens)
        .set({ usedAt: now })
        .where(eq(endpointEnrollmentTokens.id, used.id));
      const expired = await token("server", "linux", tenantId);
      await fixture.db
        .update(endpointEnrollmentTokens)
        .set({ expiresAt: new Date(now.getTime() - 60_000) })
        .where(eq(endpointEnrollmentTokens.id, expired.id));

      const valid = await service.listEnrollmentTokens(shared.db, tenantId);
      expect(valid.items.every((item) => item.state === "valid")).toBe(true);
      const validIds = valid.items.map((item) => item.id);
      expect(validIds).toContain(open.id);
      for (const settled of [revoked.id, used.id, expired.id]) {
        expect(validIds).not.toContain(settled);
      }
      const all = await service.listEnrollmentTokens(shared.db, tenantId, { state: "all" });
      const mine = new Set([open.id, revoked.id, used.id, expired.id]);
      expect(
        Object.fromEntries(
          all.items.filter((item) => mine.has(item.id)).map((item) => [item.id, item.state]),
        ),
      ).toEqual({
        [open.id]: "valid",
        [revoked.id]: "revoked",
        [used.id]: "used",
        [expired.id]: "expired",
      });
      // A token that expires later stops being listed as valid once its time is over.
      const later = await service.listEnrollmentTokens(
        shared.db,
        tenantId,
        {},
        new Date(now.getTime() + 25 * 60 * 60 * 1000),
      );
      expect(later.items.map((item) => item.id)).not.toContain(open.id);
    });

    it("carries the waiting requests and the last twenty finished ones", async () => {
      const who = await enrolled("server");
      const base = Date.now();
      await fixture.db.insert(endpointTasks).values(
        Array.from({ length: 23 }, (_, index) => ({
          tenantId: fixture.tenantId,
          endpointId: who.endpointId,
          kind: "backup_now" as const,
          params: {},
          status: index % 5 === 0 ? ("failed" as const) : ("done" as const),
          errorMessage: index % 5 === 0 ? "expired" : null,
          createdAt: new Date(base - (100 - index) * 60_000),
          finishedAt: new Date(base - (90 - index) * 60_000),
        })),
      );
      await inJob(who);
      await service.createTask(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        { kind: "backup_now" },
        actor(),
      );
      const detail = await service.getEndpoint(
        shared.db,
        fixture.tenantId,
        who.endpointId,
        instance.url,
      );
      // The waiting one, and only that one, is in `tasks`.
      expect(detail.tasks.map((task) => task.status)).toEqual(["pending"]);
      expect(detail.recentTasks).toHaveLength(20);
      expect(detail.recentTasks.every((task) => ["done", "failed"].includes(task.status))).toBe(
        true,
      );
      // Newest first, and the oldest three fell off.
      const finished = detail.recentTasks.map((task) => Date.parse(task.finishedAt ?? ""));
      expect([...finished].sort((a, b) => b - a)).toEqual(finished);
      expect(detail.recentTasks.filter((task) => task.status === "failed")[0]?.errorMessage).toBe(
        "expired",
      );
    }, 30_000);

    it("keeps the recent requests of one machine out of another's", async () => {
      const mine = await enrolled("server");
      const theirs = await enrolled("server", fixture.otherTenantId);
      await fixture.db.insert(endpointTasks).values({
        tenantId: fixture.otherTenantId,
        endpointId: theirs.endpointId,
        kind: "backup_now",
        params: {},
        status: "done",
        finishedAt: new Date(),
      });
      const detail = await service.getEndpoint(
        shared.db,
        fixture.tenantId,
        mine.endpointId,
        instance.url,
      );
      expect(detail.recentTasks).toEqual([]);
    }, 30_000);
  });

  describe("readiness", () => {
    it("rates no backup, unverified and green from the reports of the newest backup", async () => {
      const who = await enrolled("server");
      const rate = async () =>
        shared.db.transaction(async (tx) => {
          await tx.execute(await pin(fixture.tenantId));
          const map = await readiness.loadEndpointReadiness(tx, fixture.tenantId, [who.endpointId]);
          return map.get(who.endpointId);
        });
      expect((await rate())?.state).toBe("no_backup");

      const [run] = await fixture.db
        .insert(endpointRuns)
        .values({
          tenantId: fixture.tenantId,
          endpointId: who.endpointId,
          kind: "backup",
          status: "succeeded",
          startedAt: new Date(),
          finishedAt: new Date(),
          snapshotId: "c3".repeat(32),
        })
        .returning();
      expect(run).toBeDefined();
      expect((await rate())?.state).toBe("unverified");

      await fixture.db.insert(endpointReports).values({
        tenantId: fixture.tenantId,
        endpointId: who.endpointId,
        kind: "restore_test",
        origin: "server",
        snapshotId: "c3".repeat(32),
        readiness: "green",
        summary: {},
      });
      expect((await rate())?.state).toBe("green");

      // A newer backup is unverified again until it is tested itself.
      await fixture.db.insert(endpointRuns).values({
        tenantId: fixture.tenantId,
        endpointId: who.endpointId,
        kind: "backup",
        status: "succeeded",
        startedAt: new Date(Date.now() + 1000),
        finishedAt: new Date(Date.now() + 1000),
        snapshotId: "d4".repeat(32),
      });
      expect((await rate())?.state).toBe("unverified");
    }, 30_000);
  });
});

async function pin(tenantId: string) {
  const { pinTenantStatement } = await import("../../lib/tenant-context.js");
  return pinTenantStatement(tenantId);
}
