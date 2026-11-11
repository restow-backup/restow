/**
 * Postgres-backed tests of the size and space guard of backup runs (#99, docs/STORAGE.md
 * "Unusually large runs"): a machine's run measured against its earlier runs is held once it
 * passes ten times the usual (the hold, the alert in the bell and the rules, once), later runs
 * of the machine are held at their first upload, a run is held when the target would keep too
 * little free space, and an administrator decides through the routes (continue once, which the
 * next run uses; raise the limit; switch the guard off), every decision audited, tenant B never
 * seeing A's holds.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_run_size_test` is recreated there and dropped after).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { defaultEndpointConfig } from "@restow/core";
import {
  auditLog,
  createDb,
  type Database,
  endpointRuns,
  endpoints,
  notifications,
  providers,
  RunSizeGuard,
  type RunSizeTx,
  reportDeliveries,
  reportRules,
  runSizeHoldOfRun,
  runSizeHolds,
  runSizeSettings,
  tenants,
  user,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import type { TenantEnv } from "../../middleware/session.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { buildRunSizeRoutes } from "./routes.js";
import { RUN_SIZE_AUDIT_ACTIONS } from "./service.js";

const DATABASE = "restow_api_run_size_test";
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

describe.skipIf(!testDatabaseAdminUrl)("the run size guard against Postgres (#99)", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let contoso: string;
  let fabrikam: string;
  let machine: string;
  const adminId = randomUUID();

  function stand(): MiddlewareHandler<TenantEnv> {
    return async (c, next) => {
      c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
      c.set("user", { id: adminId, email: "admin@contoso.example" } as unknown as SessionUser);
      await next();
    };
  }

  const call = (method: string, path: string, body?: unknown, tenantId = contoso) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", "x-restow-tenant": tenantId },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** A finished backup run of the machine that added `bytes`. */
  async function finishedRun(bytes: number, hoursAgo: number) {
    const at = new Date(Date.now() - hoursAgo * 3_600_000);
    await owner.insert(endpointRuns).values({
      tenantId: contoso,
      endpointId: machine,
      kind: "backup",
      status: "succeeded",
      startedAt: at,
      finishedAt: at,
      createdAt: at,
      stats: { dataAdded: bytes * 2, dataAddedPacked: bytes } as never,
    });
  }

  function guard(
    runId: string,
    space?: { freeBytes: number; totalBytes: number },
    tenantId = contoso,
  ) {
    return new RunSizeGuard({
      tenantId,
      kind: "endpoint",
      objectId: machine,
      runId,
      transaction: (fn) => withTenantTx(appDb, tenantId, (tx) => fn(tx as RunSizeTx)),
      space: space ? async () => space : undefined,
      installationTimeZone: "Europe/Berlin",
    });
  }

  /** Uploads of `packBytes` until the guard refuses one; the bytes that went through. */
  async function upload(run: RunSizeGuard, packBytes: number, count: number) {
    let stored = 0;
    for (let index = 0; index < count; index++) {
      const admission = await run.admit(packBytes);
      if (!admission.ok) {
        return { stored, admission };
      }
      run.record(packBytes);
      stored += packBytes;
    }
    return { stored, admission: { ok: true as const } };
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
    const [row] = await owner
      .insert(endpoints)
      .values({
        tenantId: contoso,
        hostname: "fileserver01",
        os: "linux",
        arch: "amd64",
        profile: "server",
        secretHash: randomUUID(),
        config: defaultEndpointConfig("linux", "server", { timeZone: "Europe/Berlin" }),
      })
      .returning();
    machine = row?.id ?? "";
    // Usually 2 GiB stored a day (4 GiB before compression): the limit is 20 GiB.
    for (const [index, bytes] of [2, 2, 3, 1, 2].entries()) {
      await finishedRun(bytes * GIB, 24 * (index + 1));
    }
    await owner.insert(reportRules).values({
      tenantId: contoso,
      name: "Held backups",
      trigger: "event",
      events: ["backup.unusually_large"],
      emailRecipients: ["ops@contoso.example"],
    });
    app = new Hono();
    app.onError(errorHandler);
    app.route("/run-size", buildRunSizeRoutes({ db: appDb, requireAdmin: stand() }));
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await Promise.all([owner?.$client.end(), appDb?.$client.end()]);
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  beforeEach(async () => {
    await owner.delete(runSizeHolds);
    await owner.delete(runSizeSettings);
    await owner.delete(notifications);
    await owner.delete(reportDeliveries);
  });

  const holds = () => owner.select().from(runSizeHolds);

  it("holds a run that passes ten times the usual, alerts once, and holds the next runs", async () => {
    const first = guard(randomUUID());
    // 19 GiB in packs of 1 GiB go through; the 21st would pass 20 GiB.
    const result = await upload(first, GIB, 30);
    expect(result.stored).toBe(20 * GIB);
    expect(result.admission).toMatchObject({ ok: false });
    const [hold] = await holds();
    expect(hold).toMatchObject({
      tenantId: contoso,
      objectKind: "endpoint",
      objectId: machine,
      objectName: "fileserver01",
      reason: "size",
      status: "pending",
      bytes: 21 * GIB,
      limitBytes: 20 * GIB,
      medianBytes: 2 * GIB,
      historyRuns: 5,
    });
    // Asked again, the run is refused without another alert.
    expect((await first.admit(MIB)).ok).toBe(false);
    const bell = await owner
      .select()
      .from(notifications)
      .where(eq(notifications.event, "backup.unusually_large"));
    expect(bell).toHaveLength(1);
    expect(bell[0]).toMatchObject({ tenantId: contoso, level: "warning" });
    expect(bell[0]?.details).toMatchObject({
      holdId: hold?.id,
      objectName: "fileserver01",
      endpointId: machine,
      bytes: 21 * GIB,
    });
    expect(bell[0]?.message).toContain("usually 2.0 GiB");
    const deliveries = await owner.select().from(reportDeliveries);
    expect(deliveries.map((row) => [row.event, row.subjectKey])).toEqual([
      ["backup.unusually_large", `size_hold:${hold?.id}`],
    ]);

    // The next run of the machine is held at its first upload, however small.
    const nextRun = randomUUID();
    const nextStarted = new Date(Date.now() - 1000);
    const next = guard(nextRun);
    expect(await next.admit(MIB)).toMatchObject({ ok: false, holdId: hold?.id });
    const [after] = await holds();
    expect(after?.refusedRuns).toBe(1);
    // Both runs are told apart from other failures when they end; a run before the hold is not.
    const holdOf = (runId: string, startedAt: Date) =>
      withTenantTx(appDb, contoso, (tx) =>
        runSizeHoldOfRun(tx as RunSizeTx, "endpoint", machine, runId, startedAt),
      );
    expect((await holdOf(hold?.runId as string, new Date(0)))?.id).toBe(hold?.id);
    expect((await holdOf(nextRun, nextStarted))?.id).toBe(hold?.id);
    expect(await holdOf(randomUUID(), new Date(Date.now() + 60_000))).toBeNull();
    expect(
      await owner
        .select()
        .from(notifications)
        .where(eq(notifications.event, "backup.unusually_large")),
    ).toHaveLength(1);
  });

  it("holds a run that would leave the target less than 2 % free", async () => {
    const run = guard(randomUUID(), { freeBytes: 2.5 * GIB, totalBytes: 100 * GIB });
    expect((await run.admit(256 * MIB)).ok).toBe(true);
    run.record(256 * MIB);
    expect(await run.admit(GIB)).toMatchObject({ ok: false });
    const [hold] = await holds();
    expect(hold).toMatchObject({
      reason: "space",
      freeBytes: 2.5 * GIB,
      totalBytes: 100 * GIB,
      limitBytes: null,
    });
  });

  it("continue once: the next run goes through whatever it adds and closes the hold; audited", async () => {
    await upload(guard(randomUUID()), GIB, 30);
    const [hold] = await holds();
    const listed = await call("GET", "/run-size/holds");
    expect(((await listed.json()) as { open: { id: string }[] }).open.map((row) => row.id)).toEqual(
      [hold?.id],
    );
    // Another tenant sees nothing and decides nothing.
    const foreign = await call("GET", "/run-size/holds", undefined, fabrikam);
    expect(await foreign.json()).toEqual({ open: [], recent: [] });
    expect((await call("POST", `/run-size/holds/${hold?.id}/continue`, {}, fabrikam)).status).toBe(
      404,
    );

    const approved = await call("POST", `/run-size/holds/${hold?.id}/continue`, {
      note: "the archive move was planned",
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ status: "approved" });
    expect((await call("POST", `/run-size/holds/${hold?.id}/continue`, {})).status).toBe(409);

    const allowedRun = randomUUID();
    const big = guard(allowedRun);
    expect((await upload(big, GIB, 40)).stored).toBe(40 * GIB);
    const [used] = await holds();
    expect(used).toMatchObject({
      status: "resolved",
      resolution: "continued",
      consumedRunId: allowedRun,
    });
    // Once only: the run after it is measured again.
    expect((await upload(guard(randomUUID()), GIB, 30)).stored).toBe(20 * GIB);

    const audited = await owner
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, RUN_SIZE_AUDIT_ACTIONS.continued), eq(auditLog.tenantId, contoso)),
      );
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ target: machine, targetType: "endpoint" });
    expect(audited[0]?.details).toMatchObject({
      objectName: "fileserver01",
      note: "the archive move was planned",
    });
  });

  it("raise the limit: the object's own limit, the hold ends, the next run may add that much", async () => {
    await upload(guard(randomUUID()), GIB, 30);
    const [hold] = await holds();
    const tooSmall = await call("POST", `/run-size/holds/${hold?.id}/raise`, { limitGib: 10 });
    expect(tooSmall.status).toBe(422);
    const raised = await call("POST", `/run-size/holds/${hold?.id}/raise`, { limitGib: 50 });
    expect(raised.status).toBe(200);
    expect(await raised.json()).toMatchObject({ status: "resolved", resolution: "limit_raised" });
    const [setting] = await owner.select().from(runSizeSettings);
    expect(setting).toMatchObject({
      objectKind: "endpoint",
      objectId: machine,
      settings: { limitBytes: 50 * GIB },
    });
    expect((await upload(guard(randomUUID()), GIB, 60)).stored).toBe(50 * GIB);
    const audited = await owner
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, RUN_SIZE_AUDIT_ACTIONS.limitRaised));
    expect(audited[0]?.details).toMatchObject({ limitBytes: 50 * GIB, previousLimitBytes: null });
  });

  it("settings: per tenant and per object; off for the object ends its hold; audited", async () => {
    // The tenant's: five times the usual, at least 1 GiB.
    const tenant = await call("PUT", "/run-size/settings", {
      override: { factor: 5, minGib: 1 },
    });
    expect(tenant.status).toBe(200);
    expect(await tenant.json()).toMatchObject({
      tenant: { factor: 5, minBytes: GIB },
      effective: { factor: 5, minBytes: GIB, minFreePercent: 2 },
    });
    expect((await upload(guard(randomUUID()), GIB, 30)).stored).toBe(10 * GIB);
    expect(await holds()).toHaveLength(1);

    const off = await call("PUT", "/run-size/settings", {
      kind: "endpoint",
      objectId: machine,
      override: { enabled: false },
    });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({
      objects: [{ kind: "endpoint", objectId: machine, objectName: "fileserver01" }],
    });
    expect((await holds())[0]).toMatchObject({ status: "resolved", resolution: "guard_off" });
    expect((await upload(guard(randomUUID()), GIB, 40)).stored).toBe(40 * GIB);

    // Cleared again: the tenant's settings apply.
    await call("PUT", "/run-size/settings", {
      kind: "endpoint",
      objectId: machine,
      override: null,
    });
    expect((await upload(guard(randomUUID()), GIB, 30)).stored).toBe(10 * GIB);
    // Nonsense is refused.
    expect((await call("PUT", "/run-size/settings", { override: { factor: 1 } })).status).toBe(422);
    expect(
      (await call("PUT", "/run-size/settings", { kind: "endpoint", override: {} })).status,
    ).toBe(422);
    const audited = await owner
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, RUN_SIZE_AUDIT_ACTIONS.settingsChanged));
    expect(audited.map((row) => row.targetType)).toEqual(["tenant", "endpoint", "endpoint"]);
    expect(audited[1]?.details).toMatchObject({ holdsEnded: 1, after: { enabled: false } });
  });
});
