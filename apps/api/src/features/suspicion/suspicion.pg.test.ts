/**
 * Postgres-backed tests of the ransomware judgements as the web app reads them
 * (docs/RANSOMWARE.md): one object's judged restore points with its open episode and the newest
 * clean restore point, the tenant's objects with an open episode, the false alarm (audited, ends
 * the episode, refused for a clean restore point, taken back again), tenant isolation through
 * the application role, and the installation's thresholds (defaults, a change, the audit entry).
 *
 * Times are relative to the moment the test runs. Runs when RESTOW_TEST_DATABASE_URL points at a
 * Postgres server (the database `restow_api_suspicion_test` is recreated there and dropped after).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_RANSOMWARE_SETTINGS } from "@restow/core";
import {
  auditLog,
  createDb,
  type Database,
  providers,
  restorePointSuspicions,
  settings,
  tenants,
  user,
} from "@restow/db";
import { and, eq, isNull } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth.js";
import type { TenantEnv } from "../../middleware/session.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { buildSuspicionRoutes } from "./routes.js";
import { ransomwareSettingsSchema } from "./schemas.js";
import {
  getRansomwareSettings,
  type ObjectSuspicionsDto,
  type OpenSuspicionDto,
  SUSPICION_AUDIT_ACTIONS,
  type SuspicionDto,
  updateRansomwareSettings,
} from "./service.js";

const DATABASE = "restow_api_suspicion_test";
const HOUR = 60 * 60 * 1000;

describe.skipIf(!testDatabaseAdminUrl)("ransomware judgements against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let contoso: string;
  let fabrikam: string;
  const adminId = randomUUID();
  const machine = randomUUID();
  const now = Date.now();
  const ago = (hours: number) => new Date(now - hours * HOUR);
  const ids: Record<string, string> = {};

  function stand(): MiddlewareHandler<TenantEnv> {
    return async (c, next) => {
      c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
      c.set("user", { id: adminId, email: "admin@contoso.example" } as unknown as SessionUser);
      await next();
    };
  }

  async function judged(
    name: string,
    hours: number,
    verdict: "none" | "suspicious",
    tenantId = contoso,
    objectId = machine,
  ) {
    const [row] = await owner
      .insert(restorePointSuspicions)
      .values({
        tenantId,
        objectKind: "endpoint",
        objectId,
        runId: randomUUID(),
        restorePointId: `${name}-snapshot`,
        restorePointAt: ago(hours),
        verdict,
        findings:
          verdict === "suspicious"
            ? [{ code: "ransom_notes", value: 40, threshold: 2, examples: ["_readme.txt"] }]
            : [],
        signals: { changeRate: "clear", names: verdict === "suspicious" ? "fired" : "clear" },
        metrics: { itemsChanged: 10, itemsTotal: 100, bytesAdded: 1 },
        signaturesVersion: "2026.10-1",
        alertedAt: verdict === "suspicious" && name === "attack" ? ago(hours) : null,
      })
      .returning();
    ids[name] = row?.id as string;
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    const { errorHandler } = await import("../../problem.js");
    await owner
      .insert(user)
      .values({ id: adminId, name: "Admin", email: "admin@contoso.example", emailVerified: true });
    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const made = await owner
      .insert(tenants)
      .values([
        { providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" },
        { providerId: provider?.id ?? "", name: "Fabrikam", slug: "fabrikam" },
      ])
      .returning();
    contoso = made[0]?.id ?? "";
    fabrikam = made[1]?.id ?? "";

    await judged("older", 96, "none");
    await judged("clean", 72, "none");
    await judged("attack", 48, "suspicious");
    await judged("still", 24, "suspicious");
    await judged("foreign", 10, "suspicious", fabrikam);

    app = new Hono();
    app.onError(errorHandler);
    app.route("/suspicions", buildSuspicionRoutes({ db: appDb, requireAdmin: stand() }));
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await appDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  function call(path: string, options: { tenant?: string; method?: string; body?: unknown } = {}) {
    return app.request(path, {
      method: options.method ?? "GET",
      headers: {
        "x-restow-tenant": options.tenant ?? contoso,
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  }

  async function json<T>(response: Response, status = 200): Promise<T> {
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  }

  const objectList = async () =>
    json<ObjectSuspicionsDto>(await call(`/suspicions?kind=endpoint&objectId=${machine}`));

  it("lists an object's judgements with its open episode and the last clean restore point", async () => {
    const list = await objectList();
    expect(list.restorePoints.map((point) => point.restorePointId)).toEqual([
      "still-snapshot",
      "attack-snapshot",
      "clean-snapshot",
      "older-snapshot",
    ]);
    expect(list.open).toBe(true);
    expect(list.openSince).toBe(ago(48).toISOString());
    expect(list.lastClean).toEqual({
      restorePointId: "clean-snapshot",
      restorePointAt: ago(72).toISOString(),
    });
    expect(list.restorePoints[1]).toMatchObject({
      verdict: "suspicious",
      active: true,
      alerted: true,
      falseAlarm: null,
      findings: [{ code: "ransom_notes", value: 40 }],
    });
  });

  it("lists the objects with an open episode, each tenant only its own", async () => {
    const open = await json<{ objects: OpenSuspicionDto[] }>(await call("/suspicions/open"));
    expect(open.objects).toEqual([
      expect.objectContaining({
        objectKind: "endpoint",
        objectId: machine,
        suspicionId: ids.still,
        restorePointId: "still-snapshot",
      }),
    ]);
    // Contoso cannot reach Fabrikam's judgement, not even by id.
    const foreign = await call(`/suspicions/${ids.foreign}/false-alarm`, {
      method: "POST",
      body: {},
    });
    expect(foreign.status).toBe(404);
  });

  it("refuses a false alarm for a restore point without findings and a malformed request", async () => {
    expect(
      (await call(`/suspicions/${ids.clean}/false-alarm`, { method: "POST", body: {} })).status,
    ).toBe(409);
    expect((await call("/suspicions?kind=printer&objectId=x")).status).toBe(422);
    expect(
      (
        await call(`/suspicions/${ids.still}/false-alarm`, {
          method: "POST",
          body: { note: "x".repeat(1001) },
        })
      ).status,
    ).toBe(422);
  });

  it("records a false alarm, audited, which ends the episode, and takes it back", async () => {
    for (const name of ["attack", "still"]) {
      const marked = await json<SuspicionDto>(
        await call(`/suspicions/${ids[name]}/false-alarm`, {
          method: "POST",
          body: { note: "Planned move of the project folders" },
        }),
      );
      expect(marked).toMatchObject({
        active: false,
        falseAlarm: { by: "admin@contoso.example", note: "Planned move of the project folders" },
      });
    }
    const after = await objectList();
    expect(after.open).toBe(false);
    expect(after.lastClean?.restorePointId).toBe("still-snapshot");
    expect((await json<{ objects: unknown[] }>(await call("/suspicions/open"))).objects).toEqual(
      [],
    );

    const log = await owner
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, contoso),
          eq(auditLog.action, SUSPICION_AUDIT_ACTIONS.falseAlarm),
        ),
      );
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ targetType: "restore_point", actor: "admin@contoso.example" });
    expect(log[0]?.details).toMatchObject({
      objectKind: "endpoint",
      objectId: machine,
      findings: ["ransom_notes"],
    });

    const back = await json<SuspicionDto>(
      await call(`/suspicions/${ids.still}/false-alarm`, { method: "DELETE" }),
    );
    expect(back).toMatchObject({ active: true, falseAlarm: null });
    expect((await objectList()).open).toBe(true);
    expect((await call(`/suspicions/${ids.still}/false-alarm`, { method: "DELETE" })).status).toBe(
      404,
    );
    const revoked = await owner
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, SUSPICION_AUDIT_ACTIONS.falseAlarmRevoked));
    expect(revoked).toHaveLength(1);
  });

  it("keeps the installation's thresholds: defaults, a change, audited, back to the defaults", async () => {
    const actor = { id: adminId, email: "owner@provider.example", ip: "192.0.2.4" };
    await expect(updateRansomwareSettings(owner, {}, actor)).rejects.toThrow(
      /Finish the setup wizard/,
    );
    await owner.insert(settings).values({ singleton: true, operatingMode: "local" });
    expect((await getRansomwareSettings(owner)).settings).toEqual(DEFAULT_RANSOMWARE_SETTINGS);

    const input = ransomwareSettingsSchema.parse({
      changeRate: { minItems: 2000 },
      entropy: { enabled: false },
    });
    const saved = await updateRansomwareSettings(owner, input, actor);
    expect(saved.settings.changeRate.minItems).toBe(2000);
    expect(saved.settings.entropy.enabled).toBe(false);
    expect(saved.settings.names).toEqual(DEFAULT_RANSOMWARE_SETTINGS.names);
    expect((await getRansomwareSettings(owner)).settings.changeRate.minItems).toBe(2000);
    const log = await owner
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "settings.ransomware.updated"), isNull(auditLog.tenantId)));
    expect(log[0]?.details).toMatchObject({ before: {}, after: input });

    await updateRansomwareSettings(owner, {}, actor);
    expect((await getRansomwareSettings(owner)).settings).toEqual(DEFAULT_RANSOMWARE_SETTINGS);
  });

  it("refuses thresholds out of range or unknown", () => {
    expect(ransomwareSettingsSchema.safeParse({ baselineRuns: 1000 }).success).toBe(false);
    expect(ransomwareSettingsSchema.safeParse({ entropy: { highBits: 9 } }).success).toBe(false);
    expect(ransomwareSettingsSchema.safeParse({ changeRate: { minItems: 1.5 } }).success).toBe(
      false,
    );
    expect(ransomwareSettingsSchema.safeParse({ surprise: true }).success).toBe(false);
    expect(ransomwareSettingsSchema.safeParse({ names: { minNoteCopies: 3 } }).success).toBe(true);
  });
});
