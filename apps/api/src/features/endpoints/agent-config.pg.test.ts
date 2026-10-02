/**
 * Postgres-backed test of the one thing a bandwidth window changes for the agent: the answer of
 * `GET /agent/v1/config` depends on the moment it is asked, and nothing stored does. The
 * suite stores a machine whose job set a default limit and two windows, asks for the configuration
 * at different moments of a week (the clock is moved, the database is real) and checks that
 *
 * - the answer carries the limit of the window that is active then, the default outside every
 *   window, and null where the window says unlimited; the windows themselves are never sent;
 * - `endpoints.config` and `config_version` are exactly what they were before the first request,
 *   and no `update_config` task appears (a window starting or ending must not make the agent
 *   re-read, nor the server write);
 * - a heartbeat that reports the stored version gets no task before, at or after a boundary;
 * - the zone is the schedule's, else the tenant's, else Europe/Berlin.
 *
 * It does not need restic: the machines are inserted, not enrolled. Runs when
 * RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the database
 * `restow_api_agent_config_test` is recreated there and dropped after).
 */
import { randomUUID } from "node:crypto";
import { type BandwidthWindow, generateAgentSecret } from "@restow/core";
import { type EndpointConfig, endpointTasks, endpoints, tenants } from "@restow/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type EndpointFixture,
  basic,
  startFixture,
  testDatabaseAdminUrl,
} from "./testing/fixture.js";

const DATABASE = "restow_api_agent_config_test";

const OFFICE: BandwidthWindow = { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", kbps: 2000 };
const NIGHT: BandwidthWindow = { days: [1, 2, 3, 4, 5], from: "22:00", to: "06:00", kbps: 0 };

function config(
  overrides: Partial<EndpointConfig> & {
    zone?: string;
    schedule?: EndpointConfig["schedule"];
  } = {},
): EndpointConfig {
  const { zone = "Europe/Berlin", ...rest } = overrides;
  return {
    profile: "server",
    schedule: { kind: "daily", timeOfDay: "02:00", timeZone: zone },
    paths: ["/srv"],
    excludes: [],
    hooks: {},
    bandwidthKbps: 500,
    onlyOnAcPower: false,
    useVss: false,
    bandwidthWindows: [OFFICE, NIGHT],
    ...rest,
  };
}

describe.skipIf(!testDatabaseAdminUrl)("the configuration of an agent over a week", () => {
  let fixture: EndpointFixture;
  let app: Hono;
  let ipCounter = 10;

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    const { agentRoutes } = await import("./agent-routes.js");
    const { errorHandler } = await import("../../problem.js");
    app = new Hono();
    app.onError(errorHandler);
    app.route("/agent/v1", agentRoutes);
  }, 90_000);

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await fixture?.cleanup();
  });

  async function machine(values: {
    config: EndpointConfig;
    tenantId?: string;
    configVersion?: number;
  }): Promise<{ id: string; secret: string; tenantId: string }> {
    const secret = generateAgentSecret();
    const tenantId = values.tenantId ?? fixture.tenantId;
    const id = randomUUID();
    await fixture.db.insert(endpoints).values({
      id,
      tenantId,
      hostname: `host-${id.slice(0, 8)}`,
      os: "linux",
      arch: "amd64",
      profile: values.config.profile,
      secretHash: secret.hash,
      config: values.config,
      configVersion: values.configVersion ?? 4,
    });
    return { id, secret: secret.value, tenantId };
  }

  /** What the agent gets when it asks at `iso` (the clock is moved to it). */
  async function configAt(who: { id: string; secret: string }, iso: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
    const response = await app.request("/agent/v1/config", {
      headers: { ...basic(who.id, who.secret), "x-forwarded-for": `192.0.2.${ipCounter++}` },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Record<string, unknown> & { configVersion: number };
  }

  async function heartbeatAt(
    who: { id: string; secret: string },
    iso: string,
    configVersion: number,
  ) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
    const response = await app.request("/agent/v1/heartbeat", {
      method: "POST",
      headers: {
        ...basic(who.id, who.secret),
        "content-type": "application/json",
        "x-forwarded-for": `192.0.2.${ipCounter++}`,
      },
      body: JSON.stringify({
        agentVersion: "0.2.0",
        osVersion: "Debian 12",
        state: "idle",
        nextRunAt: null,
        configVersion,
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { tasks: { kind: string }[] };
  }

  async function stored(id: string) {
    const [row] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, id));
    return row;
  }

  it("answers with the limit of the window that is active when it is asked", async () => {
    const who = await machine({ config: config() });
    // Tuesday 2026-10-06 in Berlin (CEST, UTC+2).
    const answers: [string, number | null][] = [
      ["2026-10-06T05:59:00Z", 500], // 07:59, before the office window
      ["2026-10-06T06:00:00Z", 2000], // 08:00, it starts
      ["2026-10-06T15:59:00Z", 2000], // 17:59
      ["2026-10-06T16:00:00Z", 500], // 18:00, it ended
      ["2026-10-06T19:59:00Z", 500], // 21:59
      ["2026-10-06T20:00:00Z", null], // 22:00, the night window: unlimited
      ["2026-10-07T03:59:00Z", null], // 05:59 Wednesday, still Tuesday's night
      ["2026-10-07T04:00:00Z", 500], // 06:00, it ended
      ["2026-10-10T10:00:00Z", 500], // Saturday 12:00: no window on the weekend
      ["2026-10-10T23:00:00Z", 500], // 01:00 Sunday: Friday's night ended at 06:00 Saturday, Saturday has no window
    ];
    for (const [iso, kbps] of answers) {
      const answer = await configAt(who, iso);
      expect(answer.bandwidthKbps, iso).toBe(kbps);
    }
  });

  it("never sends the windows, and sends the rest of the configuration as it is stored", async () => {
    const who = await machine({ config: config(), configVersion: 9 });
    const answer = await configAt(who, "2026-10-06T08:00:00Z");
    expect(answer).not.toHaveProperty("bandwidthWindows");
    expect(answer).toMatchObject({
      profile: "server",
      schedule: { kind: "daily", timeOfDay: "02:00", timeZone: "Europe/Berlin" },
      paths: ["/srv"],
      bandwidthKbps: 2000,
      onlyOnAcPower: false,
      configVersion: 9,
    });
  });

  it("writes nothing and creates no task when a window starts or ends", async () => {
    const original = config();
    const who = await machine({ config: original, configVersion: 6 });
    const before = await stored(who.id);
    // Every boundary of the day, and the minutes around them.
    for (const iso of [
      "2026-10-06T05:59:00Z",
      "2026-10-06T06:00:00Z",
      "2026-10-06T16:00:00Z",
      "2026-10-06T20:00:00Z",
      "2026-10-07T04:00:00Z",
    ]) {
      const answer = await configAt(who, iso);
      expect(answer.configVersion, iso).toBe(6);
      // The agent reports the version it holds: nothing to fetch, at any moment.
      expect((await heartbeatAt(who, iso, 6)).tasks, iso).toEqual([]);
    }
    const after = await stored(who.id);
    expect(after?.config).toEqual(before?.config);
    expect(after?.configVersion).toBe(6);
    expect(
      await fixture.db.select().from(endpointTasks).where(eq(endpointTasks.endpointId, who.id)),
    ).toEqual([]);
  });

  it("still tells an agent with another version to fetch the configuration", async () => {
    const who = await machine({ config: config(), configVersion: 8 });
    const { tasks } = await heartbeatAt(who, "2026-10-06T08:00:00Z", 7);
    expect(tasks.map((task) => task.kind)).toEqual(["update_config"]);
  });

  it("reads the windows in the zone of the machine's schedule, whatever kind it is", async () => {
    // An on-connect machine in Tokyo: Wednesday 2026-10-07 09:00 there is Wednesday 00:00 UTC.
    const tokyo = await machine({
      config: config({
        profile: "client",
        schedule: { kind: "on_connect", intervalMinutes: 240, timeZone: "Asia/Tokyo" },
      }),
    });
    expect((await configAt(tokyo, "2026-10-07T00:00:00Z")).bandwidthKbps).toBe(2000); // 09:00 JST
    expect((await configAt(tokyo, "2026-10-07T09:00:00Z")).bandwidthKbps).toBe(500); // 18:00 JST
    // The same instants in Berlin read differently: 02:00 and 11:00.
    const berlin = await machine({ config: config() });
    expect((await configAt(berlin, "2026-10-07T00:00:00Z")).bandwidthKbps).toBe(null); // 02:00, night
    expect((await configAt(berlin, "2026-10-07T09:00:00Z")).bandwidthKbps).toBe(2000); // 11:00
  });

  it("falls back to the tenant's zone, then to the installation's, where a schedule names none", async () => {
    await fixture.db
      .update(tenants)
      .set({ timeZone: "America/New_York" })
      .where(eq(tenants.id, fixture.otherTenantId));
    const unnamed = config({ zone: "" });
    const inNewYork = await machine({ config: unnamed, tenantId: fixture.otherTenantId });
    const inDefault = await machine({ config: unnamed });
    // Monday 2026-10-05 16:30 UTC: 12:30 in New York (office window), 18:30 in Berlin (outside it).
    expect((await configAt(inNewYork, "2026-10-05T16:30:00Z")).bandwidthKbps).toBe(2000);
    expect((await configAt(inDefault, "2026-10-05T16:30:00Z")).bandwidthKbps).toBe(500);
  });

  it("serves a machine without windows exactly what is stored, in any week", async () => {
    const { bandwidthWindows: _none, ...plain } = config({ bandwidthKbps: 750 });
    const who = await machine({ config: plain, configVersion: 2 });
    for (const iso of ["2026-10-06T06:00:00Z", "2026-10-10T10:00:00Z"]) {
      const answer = await configAt(who, iso);
      expect(answer).toEqual({ ...plain, configVersion: 2 });
    }
  });
});
