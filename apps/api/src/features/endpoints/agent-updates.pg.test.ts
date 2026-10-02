/**
 * The pause of automatic agent updates against Postgres, on the application role (subject to Row
 * Level Security). The pause is one setting of the tenant (`tenants.agent_updates_paused`):
 *
 *   - it can be set with no machine yet, and covers machines that enrol later without a flag of
 *     their own;
 *   - a machine paused on its own (how the pause was kept before this setting) stays paused, is
 *     listed as an override, and is lifted one by one or all at once;
 *   - what an agent is offered follows both, and another tenant is never affected;
 *   - every change is audited, and a machine of another tenant cannot be touched.
 *
 * Needs no restic: machines are inserted directly. Runs when RESTOW_TEST_DATABASE_URL points at a
 * Postgres server (the database `restow_api_agent_updates_test` is recreated there and dropped).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultEndpointConfig } from "@restow/core";
import { type Database, auditLog, createDb, endpoints, providers, tenants } from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { AgentContext } from "./agent-auth.js";
import type { EndpointActor } from "./audit.js";

const DATABASE = "restow_api_agent_updates_test";

type Service = typeof import("./service.js");
type AgentService = typeof import("./agent-service.js");

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe.skipIf(!testDatabaseAdminUrl)("the pause of agent updates against Postgres", () => {
  let owner: Database;
  let roles: TestDatabaseRoles | undefined;
  let service: Service;
  let agents: AgentService;
  let shared: typeof import("../../db.js");
  let providerId = "";
  let dist = "";
  let previousDist: string | undefined;
  const actor: EndpointActor = { userId: null, label: "admin@example.test", ip: "192.0.2.10" };

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    providerId = provider?.id ?? "";

    // A signed agent release on disk: the offer is made for 9.0.0 on linux/amd64.
    previousDist = process.env.RESTOW_AGENT_DIR;
    dist = await mkdtemp(join(tmpdir(), "restow-agent-updates-"));
    process.env.RESTOW_AGENT_DIR = dist;
    const binary = "agent 9.0.0";
    await mkdir(join(dist, "9.0.0", "linux-amd64"), { recursive: true });
    await writeFile(join(dist, "9.0.0", "linux-amd64", "restow-agent"), binary);
    await writeFile(
      join(dist, "9.0.0", "SHA256SUMS"),
      `${sha256(binary)}  linux-amd64/restow-agent\n`,
    );
    await writeFile(join(dist, "9.0.0", "SHA256SUMS.sig"), "-----BEGIN SSH SIGNATURE-----\n");

    shared = await import("../../db.js");
    service = await import("./service.js");
    agents = await import("./agent-service.js");
  }, 60_000);

  afterAll(async () => {
    if (previousDist === undefined) {
      Reflect.deleteProperty(process.env, "RESTOW_AGENT_DIR");
    } else {
      process.env.RESTOW_AGENT_DIR = previousDist;
    }
    if (dist) await rm(dist, { recursive: true, force: true });
    if (shared) await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await owner?.$client.end();
    if (testDatabaseAdminUrl) {
      await dropDatabase(testDatabaseAdminUrl, DATABASE);
      await roles?.drop(testDatabaseAdminUrl);
    }
  }, 60_000);

  async function freshTenant(name: string): Promise<string> {
    const [row] = await owner
      .insert(tenants)
      .values({ providerId, name, slug: `t-${randomUUID().slice(0, 8)}` })
      .returning({ id: tenants.id });
    return row?.id ?? "";
  }

  async function machine(
    tenantId: string,
    hostname: string,
    settings: Record<string, unknown> = {},
  ): Promise<AgentContext> {
    const [row] = await owner
      .insert(endpoints)
      .values({
        tenantId,
        hostname,
        os: "linux",
        arch: "amd64",
        profile: "server",
        agentVersion: "1.0.0",
        secretHash: randomBytes(16).toString("hex"),
        config: defaultEndpointConfig("linux", "server", { timeZone: "UTC" }),
        settings,
      })
      .returning({ id: endpoints.id });
    return {
      endpointId: row?.id ?? "",
      tenantId,
      hostname,
      profile: "server",
      os: "linux",
      ip: null,
    };
  }

  const offered = async (agent: AgentContext) =>
    (await agents.agentUpdate(agent, "https://restow.example.test")) !== null;

  it("is set before the first machine exists, and covers machines that enrol later", async () => {
    const tenant = await freshTenant("Pause before any machine");
    expect(await service.getAgentUpdates(shared.db, tenant)).toEqual({
      paused: false,
      endpoints: 0,
      overrides: [],
    });
    expect(await service.setAgentUpdates(shared.db, tenant, true, actor)).toEqual({
      paused: true,
      endpoints: 0,
      overrides: [],
    });

    // A machine that arrives afterwards carries no flag, yet gets no release.
    const later = await machine(tenant, "later");
    const [row] = await owner
      .select({ settings: endpoints.settings })
      .from(endpoints)
      .where(eq(endpoints.id, later.endpointId));
    expect(row?.settings.autoUpdatePaused).toBeUndefined();
    expect(await offered(later)).toBe(false);

    await service.setAgentUpdates(shared.db, tenant, false, actor);
    expect(await offered(later)).toBe(true);
  }, 30_000);

  it("leaves another tenant alone", async () => {
    const paused = await freshTenant("Paused tenant");
    const other = await freshTenant("Other tenant");
    const a = await machine(paused, "a");
    const b = await machine(other, "b");
    await service.setAgentUpdates(shared.db, paused, true, actor);
    expect(await offered(a)).toBe(false);
    expect(await offered(b)).toBe(true);
    expect((await service.getAgentUpdates(shared.db, other)).paused).toBe(false);
  }, 30_000);

  it("keeps a machine's own pause as an override that the tenant's resume does not lift", async () => {
    const tenant = await freshTenant("Overrides");
    const own = await machine(tenant, "own-pause", { autoUpdatePaused: true });
    const follows = await machine(tenant, "follows", { autoUpdatePaused: false });
    const plain = await machine(tenant, "plain");

    const state = await service.getAgentUpdates(shared.db, tenant);
    expect(state).toMatchObject({ paused: false, endpoints: 3 });
    expect(state.overrides).toEqual([{ id: own.endpointId, name: "own-pause", profile: "server" }]);
    expect(await offered(own)).toBe(false);
    // An explicit "false" left by the old switch means "follows the tenant", not "never pause".
    expect(await offered(follows)).toBe(true);
    expect(await offered(plain)).toBe(true);

    // The tenant pause covers everyone; resuming it leaves the override in place.
    await service.setAgentUpdates(shared.db, tenant, true, actor);
    expect(await offered(follows)).toBe(false);
    await service.setAgentUpdates(shared.db, tenant, false, actor);
    expect(await offered(follows)).toBe(true);
    expect(await offered(own)).toBe(false);
    expect((await service.getAgentUpdates(shared.db, tenant)).overrides).toHaveLength(1);

    // The detail of the machine says which of the two holds it back.
    const detail = await service.getEndpoint(
      shared.db,
      tenant,
      own.endpointId,
      "https://restow.example.test",
    );
    expect(detail).toMatchObject({ autoUpdatePaused: true, autoUpdateOwnPause: true });
    const free = await service.getEndpoint(
      shared.db,
      tenant,
      plain.endpointId,
      "https://restow.example.test",
    );
    expect(free).toMatchObject({ autoUpdatePaused: false, autoUpdateOwnPause: false });
  }, 30_000);

  it("lifts the overrides one by one or all at once, only for the tenant's own machines", async () => {
    const tenant = await freshTenant("Lift overrides");
    const other = await freshTenant("Not this one");
    const first = await machine(tenant, "first", { autoUpdatePaused: true });
    const second = await machine(tenant, "second", { autoUpdatePaused: true });
    const third = await machine(tenant, "third", { autoUpdatePaused: true });
    const foreign = await machine(other, "foreign", { autoUpdatePaused: true });

    const afterOne = await service.resumeMachineUpdates(shared.db, tenant, first.endpointId, actor);
    expect(afterOne.overrides.map((entry) => entry.name).sort()).toEqual(["second", "third"]);
    expect(await offered(first)).toBe(true);

    // Another tenant's machine is invisible: nothing is lifted, nothing leaks.
    await expect(
      service.resumeMachineUpdates(shared.db, tenant, foreign.endpointId, actor),
    ).rejects.toMatchObject({ status: 404 });
    expect(await offered(foreign)).toBe(false);

    const afterAll = await service.setAgentUpdates(shared.db, tenant, false, actor, {
      resumeMachines: true,
    });
    expect(afterAll).toMatchObject({ paused: false, overrides: [] });
    expect(await offered(second)).toBe(true);
    expect(await offered(third)).toBe(true);
    // The other tenant's machine kept its pause.
    expect((await service.getAgentUpdates(shared.db, other)).overrides).toHaveLength(1);
  }, 30_000);

  it("audits every change", async () => {
    const tenant = await freshTenant("Audited");
    const own = await machine(tenant, "audited", { autoUpdatePaused: true });
    await service.setAgentUpdates(shared.db, tenant, true, actor);
    await service.setAgentUpdates(shared.db, tenant, false, actor, { resumeMachines: true });
    await service.resumeMachineUpdates(shared.db, tenant, own.endpointId, actor);
    const entries = await owner.select().from(auditLog).where(eq(auditLog.tenantId, tenant));
    const actions = entries.map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining(["endpoint.updates.paused", "endpoint.updates.resumed"]),
    );
    const resumed = entries.filter((entry) => entry.action === "endpoint.updates.resumed");
    expect(resumed.map((entry) => entry.details)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ machinesResumed: 1 }),
        expect.objectContaining({ machine: true }),
      ]),
    );
  }, 30_000);
});
