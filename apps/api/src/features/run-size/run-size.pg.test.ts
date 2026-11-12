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
  loadInstallationSpaceRule,
  notifications,
  providers,
  RunSizeGuard,
  type RunSizeTx,
  reportDeliveries,
  reportRules,
  runSizeHoldOfRun,
  runSizeHolds,
  runSizeRuns,
  runSizeSettings,
  settings,
  storageTargets,
  tenants,
  user,
} from "@restow/db";
import { and, eq, isNull } from "drizzle-orm";
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
import {
  installationSpaceRuleView,
  RUN_SIZE_AUDIT_ACTIONS,
  RUN_SIZE_PROBLEMS,
  updateInstallationSpaceRule,
} from "./service.js";

const DATABASE = "restow_api_run_size_test";
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

describe.skipIf(!testDatabaseAdminUrl)("the run size guard against Postgres (#99)", () => {
  let owner: Database;
  let appDb: Database;
  let providerPool: Database;
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
    space?:
      | { freeBytes: number; totalBytes: number }
      | (() => { freeBytes: number; totalBytes: number }),
    tenantId = contoso,
    transaction?: (fn: (tx: RunSizeTx) => Promise<unknown>) => Promise<unknown>,
  ) {
    return new RunSizeGuard({
      tenantId,
      kind: "endpoint",
      objectId: machine,
      runId,
      transaction: (transaction ??
        ((fn: (tx: RunSizeTx) => Promise<unknown>) =>
          withTenantTx(appDb, tenantId, (tx) => fn(tx as RunSizeTx)))) as never,
      space: space ? async () => (typeof space === "function" ? space() : space) : undefined,
      installationTimeZone: "Europe/Berlin",
      installationSpaceRule: () => loadInstallationSpaceRule(providerPool),
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
    providerPool = createDb(roles.providerUrl);
    await owner.insert(settings).values({}).onConflictDoNothing();
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
    app.route(
      "/run-size",
      buildRunSizeRoutes({
        db: appDb,
        requireAdmin: stand(),
        installationSpace: () => loadInstallationSpaceRule(providerPool),
      }),
    );
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await Promise.all([owner?.$client.end(), appDb?.$client.end(), providerPool?.$client.end()]);
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  beforeEach(async () => {
    await owner.delete(runSizeHolds);
    await owner.delete(runSizeSettings);
    await owner.delete(runSizeRuns);
    await owner.delete(notifications);
    await owner.delete(reportDeliveries);
    await owner.delete(storageTargets);
    await owner.update(settings).set({ runSpaceRule: {} });
    // Most tests here are about holding a run for its size: the tenant holds (the default,
    // `warn`, has its own tests below).
    await owner
      .insert(runSizeSettings)
      .values({ tenantId: contoso, settings: { mode: "hold" }, updatedBy: "test" });
  });

  /** The tenant back to the default: a run past its size limit goes on with a notice. */
  const warnByDefault = () =>
    owner
      .delete(runSizeSettings)
      .where(and(eq(runSizeSettings.tenantId, contoso), isNull(runSizeSettings.objectKind)));
  const notices = () =>
    owner
      .select()
      .from(notifications)
      .where(eq(notifications.event, "backup.unusually_large_notice"));

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

  it("holds a run that would leave the target less than it keeps: 5 %, at least 20 GiB, at most 500 GiB", async () => {
    /** Where a run on a target of `totalGib` with `freeGib` free is held: after how many MiB. */
    async function heldAfter(freeGib: number, totalGib: number) {
      await owner.delete(runSizeHolds);
      const run = guard(randomUUID(), { freeBytes: freeGib * GIB, totalBytes: totalGib * GIB });
      return (await upload(run, 256 * MIB, 4000)).stored / MIB;
    }
    // 1000 GiB: 5 % is 50 GiB, kept free; 1 GiB above it, four uploads of 256 MiB go through.
    expect(await heldAfter(51, 1000)).toBe(1024);
    const [hold] = await holds();
    expect(hold).toMatchObject({
      reason: "space",
      // What was read, less what the run was let upload since.
      freeBytes: 50 * GIB,
      totalBytes: 1000 * GIB,
      limitBytes: null,
    });
    // 100 GiB: 5 % would be 5 GiB, the minimum keeps 20 GiB free.
    expect(await heldAfter(21, 100)).toBe(1024);
    // 20 TiB: 5 % would be 1 TiB, the maximum keeps 500 GiB free.
    expect(await heldAfter(501, 20 * 1024)).toBe(1024);
    // A 40 GiB disk keeps at most a quarter free (10 GiB), not the 20 GiB minimum.
    expect(await heldAfter(11, 40)).toBe(1024);
    // A target that reports free space but no size keeps the minimum.
    expect(await heldAfter(21, 0)).toBe(1024);
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
    expect(await foreign.json()).toEqual({ open: [], recent: [], notices: [] });
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
    const [setting] = await owner
      .select()
      .from(runSizeSettings)
      .where(eq(runSizeSettings.objectId, machine));
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
      effective: { factor: 5, minBytes: GIB },
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

  it("does not remember a failed first question: the next upload asks again (review 3)", async () => {
    let calls = 0;
    let failOnce = true;
    const flaky = (fn: (tx: RunSizeTx) => Promise<unknown>) => {
      calls++;
      if (failOnce) {
        failOnce = false;
        return Promise.reject(new Error("deadlock detected"));
      }
      return withTenantTx(appDb, contoso, (tx) => fn(tx as RunSizeTx));
    };
    const run = guard(randomUUID(), undefined, contoso, flaky);
    await expect(run.admit(MIB)).rejects.toThrow("deadlock detected");
    expect(await run.admit(MIB)).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("keeps a run's approval and its bytes across processes: a restart, a retry (review 4)", async () => {
    // Bytes: a run that stored 15 GiB is counted from there after a restart.
    const runId = randomUUID();
    expect((await upload(guard(runId), GIB, 16)).stored).toBe(16 * GIB);
    const [stored] = await owner.select().from(runSizeRuns).where(eq(runSizeRuns.runId, runId));
    // The last upload is written with the next one (at most 256 MiB or 30 s are lost).
    expect(stored?.writtenBytes).toBe(15 * GIB);
    expect(await guard(runId).admit(6 * GIB)).toMatchObject({ ok: false });

    // The approval: used by a run, kept by the run, whatever process asks next.
    await owner.delete(runSizeHolds);
    await upload(guard(randomUUID()), GIB, 30);
    const [hold] = await holds();
    await call("POST", `/run-size/holds/${hold?.id}/continue`, {});
    const allowed = randomUUID();
    expect((await upload(guard(allowed), GIB, 5)).stored).toBe(5 * GIB);
    // The api restarts: a new guard for the same run, the approval was used already.
    expect((await upload(guard(allowed), GIB, 40)).stored).toBe(40 * GIB);
    const [run] = await owner.select().from(runSizeRuns).where(eq(runSizeRuns.runId, allowed));
    expect(run?.exemption).toBe("continued");
  });

  it("takes a run that begins a new repository as its first, and starts the history again (review 1)", async () => {
    const reset = guard(randomUUID());
    // restic's config: a new repository.
    expect(await reset.admit(512, { startsRepository: true, metadata: true })).toEqual({
      ok: true,
    });
    expect((await upload(reset, GIB, 40)).stored).toBe(40 * GIB);
    expect(await holds()).toEqual([]);
    // The runs before the reset are no history of the new repository: the next run is a first
    // run as well (fewer than three runs since), not ten times the old incrementals.
    expect((await upload(guard(randomUUID()), GIB, 30)).stored).toBe(30 * GIB);
    expect(await holds()).toEqual([]);
  });

  it("ends a hold for space by itself once the target has room, and never refuses metadata (review 2)", async () => {
    let space = { freeBytes: 20.5 * GIB, totalBytes: 100 * GIB };
    const first = guard(randomUUID(), () => space);
    // The index and the snapshot of a run whose data went in are small: never held for space.
    expect(await first.admit(GIB, { metadata: true })).toEqual({ ok: true });
    expect(await first.admit(GIB)).toMatchObject({ ok: false });
    const [hold] = await holds();
    expect(hold?.reason).toBe("space");
    // "Raise the limit" makes no room: refused for a hold for space.
    const raise = await call("POST", `/run-size/holds/${hold?.id}/raise`, { limitGib: 100 });
    expect(raise.status).toBe(422);
    // Still short (not half again the 20 GiB it keeps): the next run is held as well.
    space = { freeBytes: 29 * GIB, totalBytes: 100 * GIB };
    expect(await guard(randomUUID(), () => space).admit(MIB)).toMatchObject({ ok: false });
    // Retention made room: the next run goes ahead, the hold ends by itself.
    space = { freeBytes: 30 * GIB, totalBytes: 100 * GIB };
    expect(await guard(randomUUID(), () => space).admit(MIB)).toEqual({ ok: true });
    const [after] = await holds();
    expect(after).toMatchObject({ status: "resolved", resolution: "space_freed" });
  });

  it("counts what parallel uploads took since the last reading of the space (review)", async () => {
    const run = guard(randomUUID(), { freeBytes: 21 * GIB, totalBytes: 100 * GIB });
    expect((await run.admit(GIB / 2)).ok).toBe(true);
    expect((await run.admit(GIB / 2)).ok).toBe(true);
    // 21 GiB read once, 1 GiB admitted since: this one would leave less than 20 GiB.
    expect(await run.admit(GIB / 2)).toMatchObject({ ok: false });
  });

  it("ends the hold of a removed machine (review 6)", async () => {
    await upload(guard(randomUUID()), GIB, 30);
    await owner.update(endpoints).set({ removedAt: new Date() }).where(eq(endpoints.id, machine));
    try {
      const listed = (await (await call("GET", "/run-size/holds")).json()) as {
        open: unknown[];
        recent: { resolution: string }[];
      };
      expect(listed.open).toEqual([]);
      expect(listed.recent[0]?.resolution).toBe("object_removed");
    } finally {
      await owner.update(endpoints).set({ removedAt: null }).where(eq(endpoints.id, machine));
    }
  });

  it("ends a hold the new settings no longer make; merges an object's settings; only the tenant's objects (review 7)", async () => {
    await upload(guard(randomUUID()), GIB, 30);
    // The tenant now lets every run add 30 GiB: 21 GiB is no hold any more.
    const tenant = await call("PUT", "/run-size/settings", { override: { minGib: 30 } });
    expect(tenant.status).toBe(200);
    expect((await holds())[0]).toMatchObject({
      status: "resolved",
      resolution: "settings_changed",
    });
    // An object's settings are merged: switching it off keeps its own limit.
    await call("PUT", "/run-size/settings", {
      kind: "endpoint",
      objectId: machine,
      override: { limitGib: 50 },
    });
    await call("PUT", "/run-size/settings", {
      kind: "endpoint",
      objectId: machine,
      override: { enabled: false },
    });
    const [own] = await owner
      .select()
      .from(runSizeSettings)
      .where(eq(runSizeSettings.objectId, machine));
    expect(own?.settings).toEqual({ limitBytes: 50 * GIB, enabled: false });
    // Not this tenant's object (or no object at all): not found.
    const foreign = await call(
      "PUT",
      "/run-size/settings",
      { kind: "endpoint", objectId: machine, override: { enabled: false } },
      fabrikam,
    );
    expect(foreign.status).toBe(404);
    const unknown = await call("PUT", "/run-size/settings", {
      kind: "file_share",
      objectId: machine,
      override: { enabled: false },
    });
    expect(unknown.status).toBe(404);
  });

  it("continue once lifts the size check only; a hold for space cannot be continued (#99)", async () => {
    await upload(guard(randomUUID()), GIB, 30);
    const [sizeHold] = await holds();
    expect((await call("POST", `/run-size/holds/${sizeHold?.id}/continue`, {})).status).toBe(200);
    // The allowed run passes the size limit (20 GiB), but the target keeps 500 GiB free.
    const allowed = guard(randomUUID(), { freeBytes: 525 * GIB, totalBytes: 10_240 * GIB });
    expect((await upload(allowed, GIB, 40)).stored).toBe(25 * GIB);
    const open = (await holds()).filter((hold) => hold.status === "pending");
    expect(open).toMatchObject([{ reason: "space" }]);
    const refused = await call("POST", `/run-size/holds/${open[0]?.id}/continue`, {});
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ type: RUN_SIZE_PROBLEMS.continueNotForSpace });
    expect((await holds()).find((hold) => hold.id === open[0]?.id)?.status).toBe("pending");
  });

  it("the space rule: the installation's, the tenant's on its own targets, a target's own (#99)", async () => {
    const actor = { userId: adminId, label: "admin@contoso.example", ip: null };
    // 30 GiB free of 200 GiB (a quarter, 50 GiB, is the most any rule keeps free here).
    const roomy = { freeBytes: 30 * GIB, totalBytes: 200 * GIB };
    // The installation keeps 40 GiB free on every target: 30 GiB free is too little.
    const installation = await updateInstallationSpaceRule(
      providerPool,
      { minBytes: 40 * GIB },
      actor,
    );
    expect(installation).toMatchObject({
      override: { minBytes: 40 * GIB },
      effective: { enabled: true, percent: 5, minBytes: 40 * GIB, maxBytes: 500 * GIB },
    });
    expect(await guard(randomUUID(), roomy).admit(MIB)).toMatchObject({ ok: false });
    await owner.delete(runSizeHolds);

    // On the installation's shared default target, the tenant's own rule does not count.
    const shared = await call("PUT", "/run-size/settings", { space: { minGib: 10 } });
    expect(shared.status).toBe(200);
    expect(await shared.json()).toMatchObject({
      space: {
        sharedTarget: true,
        override: { minBytes: 10 * GIB },
        effective: { minBytes: 40 * GIB },
      },
    });
    expect(await guard(randomUUID(), roomy).admit(MIB)).toMatchObject({ ok: false });
    await owner.delete(runSizeHolds);

    // On its own target the tenant's applies (10 GiB kept, 30 GiB free: room).
    const [target] = await owner
      .insert(storageTargets)
      .values({
        tenantId: contoso,
        name: "NAS",
        kind: "local",
        role: "primary",
        config: { basePath: "/srv/nas" },
      })
      .returning();
    const view = (await (await call("GET", "/run-size/settings")).json()) as {
      space: { sharedTarget: boolean; effective: { minBytes: number } };
    };
    expect(view.space).toMatchObject({ sharedTarget: false, effective: { minBytes: 10 * GIB } });
    expect(await guard(randomUUID(), roomy).admit(MIB)).toEqual({ ok: true });

    // The target's own rule comes first: 35 % of 200 GiB, at most a quarter (50 GiB), kept.
    const own = await call("PUT", `/run-size/targets/${target?.id}`, {
      space: { percent: 35, maxGib: 100 },
    });
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject([
      {
        targetId: target?.id,
        override: { percent: 35, maxBytes: 100 * GIB },
        effective: { percent: 35, minBytes: 10 * GIB },
      },
    ]);
    expect(await guard(randomUUID(), roomy).admit(MIB)).toMatchObject({ ok: false });
    expect((await holds())[0]).toMatchObject({ reason: "space", status: "pending" });
    // Nonsense is refused: at most less than at least; a target of another tenant.
    expect(
      (await call("PUT", `/run-size/targets/${target?.id}`, { space: { maxGib: 5 } })).status,
    ).toBe(422);
    expect(
      (
        await call(
          "PUT",
          `/run-size/targets/${target?.id}`,
          { space: { enabled: false } },
          fabrikam,
        )
      ).status,
    ).toBe(404);
    expect(
      (await call("PUT", `/run-size/targets/${target?.id}`, { space: { percent: 80 } })).status,
    ).toBe(422);

    // Switched off for the target: its hold for space ends, the next run goes ahead.
    const off = await call("PUT", `/run-size/targets/${target?.id}`, { space: { enabled: false } });
    expect(off.status).toBe(200);
    expect((await holds())[0]).toMatchObject({
      status: "resolved",
      resolution: "settings_changed",
    });
    expect(await guard(randomUUID(), { freeBytes: GIB, totalBytes: 100 * GIB }).admit(MIB)).toEqual(
      { ok: true },
    );

    const audited = await owner
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, RUN_SIZE_AUDIT_ACTIONS.spaceRuleChanged));
    expect(audited.map((row) => [row.targetType, row.tenantId])).toEqual([
      ["installation", null],
      ["tenant", contoso],
      ["storage_target", contoso],
      ["storage_target", contoso],
    ]);
    expect(audited[3]?.details).toMatchObject({
      scope: "target",
      holdsEnded: 1,
      after: { enabled: false },
    });
  });

  it("the installation's rule switched off ends the holds for space of every tenant; at most below at least is refused (#99)", async () => {
    const actor = { userId: adminId, label: "admin@contoso.example", ip: null };
    expect(
      await guard(randomUUID(), { freeBytes: GIB, totalBytes: 100 * GIB }).admit(MIB),
    ).toMatchObject({ ok: false });
    await expect(
      updateInstallationSpaceRule(providerPool, { minBytes: 600 * GIB }, actor),
    ).rejects.toMatchObject({ status: 422 });
    const off = await updateInstallationSpaceRule(providerPool, { enabled: false }, actor);
    expect(off.effective.enabled).toBe(false);
    expect((await holds())[0]).toMatchObject({
      status: "resolved",
      resolution: "settings_changed",
    });
    // Back to the defaults.
    await updateInstallationSpaceRule(providerPool, null, actor);
    expect(await installationSpaceRuleView(providerPool)).toMatchObject({
      override: null,
      effective: { enabled: true, percent: 5, minBytes: 20 * GIB, maxBytes: 500 * GIB },
    });
  });

  describe("the size check warns by default (#99, maintainer decision) [ALERT-010]", () => {
    it("lets a run past its limit go on, with one notice per run and no hold", async () => {
      await warnByDefault();
      await owner.insert(reportRules).values({
        tenantId: contoso,
        name: "Large backups",
        trigger: "event",
        events: ["backup.unusually_large_notice"],
        emailRecipients: ["ops@contoso.example"],
      });
      try {
        const runId = randomUUID();
        // 20 GiB is the limit; the run writes 30 GiB and is not stopped.
        expect((await upload(guard(runId), GIB, 30)).stored).toBe(30 * GIB);
        expect(await holds()).toEqual([]);
        const [notice, ...more] = await notices();
        expect(more).toEqual([]);
        expect(notice).toMatchObject({ tenantId: contoso, level: "warning" });
        expect(notice?.details).toMatchObject({
          objectName: "fileserver01",
          endpointId: machine,
          runId,
          mode: "warn",
          bytes: 21 * GIB,
          limitBytes: 20 * GIB,
          medianBytes: 2 * GIB,
        });
        expect(notice?.message).toContain("goes on");
        expect(notice?.message).toContain("exclude it");
        const deliveries = await owner
          .select()
          .from(reportDeliveries)
          .where(eq(reportDeliveries.event, "backup.unusually_large_notice"));
        expect(deliveries.map((row) => row.subjectKey)).toEqual([`size_notice:endpoint:${runId}`]);
        // The same run in another process (an api restart): no second notice.
        expect((await upload(guard(runId), GIB, 10)).stored).toBe(10 * GIB);
        expect(await notices()).toHaveLength(1);
        // The next large run: a notice of its own.
        await upload(guard(randomUUID()), GIB, 30);
        expect(await notices()).toHaveLength(2);
        // Warnings lists them with what the object does now, and no hold card.
        const listed = (await (await call("GET", "/run-size/holds")).json()) as {
          open: unknown[];
          notices: { runId: string; objectName: string; bytes: number; mode: string }[];
        };
        expect(listed.open).toEqual([]);
        expect(listed.notices).toHaveLength(2);
        expect(listed.notices[1]).toMatchObject({
          runId,
          objectName: "fileserver01",
          bytes: 21 * GIB,
          limitBytes: 20 * GIB,
          mode: "warn",
        });
        // Another tenant sees none of them.
        const foreign = (await (
          await call("GET", "/run-size/holds", undefined, fabrikam)
        ).json()) as {
          notices: unknown[];
        };
        expect(foreign.notices).toEqual([]);
      } finally {
        await owner.delete(reportRules).where(eq(reportRules.name, "Large backups"));
      }
    });

    it("still holds a run for space", async () => {
      await warnByDefault();
      // Past its size limit (a notice), then the target runs short: held for space.
      const run = guard(randomUUID(), { freeBytes: 72 * GIB, totalBytes: 1000 * GIB });
      expect((await upload(run, GIB, 40)).stored).toBe(22 * GIB);
      expect(await notices()).toHaveLength(1);
      expect(await holds()).toMatchObject([{ reason: "space", status: "pending" }]);
    });

    it("switches an object to holding from its notice, and back; a hold for size ends with warn", async () => {
      await warnByDefault();
      await upload(guard(randomUUID()), GIB, 30);
      const toHold = await call("PUT", "/run-size/settings", {
        kind: "endpoint",
        objectId: machine,
        override: { mode: "hold" },
      });
      expect(toHold.status).toBe(200);
      expect(await toHold.json()).toMatchObject({
        effective: { mode: "warn" },
        objects: [{ objectId: machine, override: { mode: "hold" }, effective: { mode: "hold" } }],
      });
      const listed = (await (await call("GET", "/run-size/holds")).json()) as {
        notices: { mode: string }[];
      };
      expect(listed.notices[0]?.mode).toBe("hold");
      // The next large run of the object is held.
      expect((await upload(guard(randomUUID()), GIB, 30)).stored).toBe(20 * GIB);
      expect(await holds()).toMatchObject([{ reason: "size", status: "pending" }]);
      expect(await notices()).toHaveLength(1);
      // Back to warn: the hold it would no longer make ends, the next run goes on.
      await call("PUT", "/run-size/settings", {
        kind: "endpoint",
        objectId: machine,
        override: { mode: "warn" },
      });
      expect((await holds())[0]).toMatchObject({
        status: "resolved",
        resolution: "settings_changed",
      });
      expect((await upload(guard(randomUUID()), GIB, 30)).stored).toBe(30 * GIB);
      // Nonsense is refused.
      expect((await call("PUT", "/run-size/settings", { override: { mode: "stop" } })).status).toBe(
        422,
      );
    });

    it("ends a hold for size from before at the next run of an object that warns now", async () => {
      await upload(guard(randomUUID()), GIB, 30);
      expect(await holds()).toMatchObject([{ reason: "size", status: "pending" }]);
      // The tenant's row gone without a decision (an update to the default): the next run goes.
      await warnByDefault();
      expect((await upload(guard(randomUUID()), GIB, 30)).stored).toBe(30 * GIB);
      expect((await holds())[0]).toMatchObject({
        status: "resolved",
        resolution: "settings_changed",
      });
    });
  });
});
