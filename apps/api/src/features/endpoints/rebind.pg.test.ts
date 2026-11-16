/**
 * Rebinding a machine against Postgres (docs/BAREMETAL.md 11, 21.2), bare metal M3: a rebind token
 * redeemed with the existing install command (`POST /agent/v1/enroll`) or from the recovery ISO's
 * session gives the existing machine a new agent secret and keeps its repository, password and
 * runs; the old secret is refused from then on. A revoked machine comes back only with `unrevoke`,
 * another operating system is refused and the token stays usable, pending uninstall orders end,
 * the rebind is audited and alerted, and the first good backup after it is the new baseline of the
 * ransomware signals. The token is valid for at most 24 hours (CHECK).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser. No restic: a
 * rebind initialises nothing.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { hashSecret } from "@restow/core";
import {
  auditLog,
  endpointEnrollmentTokens,
  endpointRecoveries,
  endpointRuns,
  endpoints,
  endpointTasks,
  notifications,
} from "@restow/db";
import { and, count, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  basic,
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "./testing/fixture.js";
import { insertMachine, sessionBasic } from "./testing/recovery.js";

const DATABASE = "restow_api_rebind_test";
const INSTANCE = { url: "https://restow.test.example", configured: true };

describe.skipIf(!testDatabaseAdminUrl)("rebinding a machine", () => {
  let fixture: EndpointFixture;
  let app: Hono;
  let rebind: typeof import("./rebind.js");
  let service: typeof import("./service.js");
  let shared: typeof import("../../db.js");
  let storeSecret: (tenantId: string, plaintext: string) => Promise<string>;
  let ip = 1;
  const actor = () => ({
    label: "admin@contoso.example",
    userId: fixture.adminId,
    ip: "192.0.2.1",
  });

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    shared = await import("../../db.js");
    rebind = await import("./rebind.js");
    service = await import("./service.js");
    const secrets = await import("../../lib/secrets.js");
    storeSecret = async (tenantId, plaintext) =>
      (await secrets.storeSecret(shared.db, { tenantId, kind: "endpoint_repository", plaintext }))
        .id;
    const { recoveryRoutes } = await import("./recovery-routes.js");
    const { agentRoutes } = await import("./agent-routes.js");
    const { errorHandler } = await import("../../problem.js");
    app = new Hono();
    app.onError(errorHandler);
    app.route("/agent/v1/recovery", recoveryRoutes);
    app.route("/agent/v1", agentRoutes);
  }, 90_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  const machine = (options: { status?: "active" | "revoked"; os?: "linux" | "darwin" } = {}) =>
    insertMachine(fixture.db, storeSecret, { tenantId: fixture.tenantId, ...options });

  const token = (
    endpointId: string,
    input: { purpose?: "reinstall" | "baremetal"; unrevoke?: boolean; validityHours?: number } = {},
  ) =>
    rebind.createRebindToken(
      shared.db,
      fixture.tenantId,
      endpointId,
      { validityHours: 1, purpose: "reinstall", unrevoke: false, ...input },
      actor(),
      INSTANCE,
    );

  const address = () => `203.0.113.${ip++ % 250}`;

  const enroll = (value: string, extra: Record<string, unknown> = {}) =>
    app.request("/agent/v1/enroll", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": address() },
      body: JSON.stringify({
        token: value,
        hostname: "web01-new",
        os: "linux",
        arch: "amd64",
        agentVersion: "0.5.0",
        osVersion: "Debian GNU/Linux 12",
        hooks: "off",
        ...extra,
      }),
    });

  const agent = (who: { id: string; secret: string }, path: string, init: RequestInit = {}) =>
    app.request(`/agent/v1${path}`, {
      ...init,
      headers: {
        ...basic(who.id, who.secret),
        "content-type": "application/json",
        "x-forwarded-for": address(),
      },
    });

  const tokenRow = async (id: string) =>
    (
      await fixture.db
        .select()
        .from(endpointEnrollmentTokens)
        .where(eq(endpointEnrollmentTokens.id, id))
    )[0];

  it("gives the existing machine a new secret with the install command, and keeps everything else", async () => {
    const target = await machine();
    const [machines] = await fixture.db.select({ n: count() }).from(endpoints);
    const created = await token(target.id);
    expect(created).toMatchObject({
      kind: "rebind",
      purpose: "reinstall",
      endpointId: target.id,
      unrevoke: false,
      os: "linux",
      instanceUrl: INSTANCE.url,
    });
    expect(created.token).toMatch(/^rset_/);
    expect(created.commands.install).toContain("/install/linux.sh");
    expect(new Date(created.expiresAt).getTime() - new Date(created.createdAt).getTime()).toBe(
      3600_000,
    );
    const response = await enroll(created.token);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      endpointId: string;
      agentSecret: string;
      repository: { url: string; password: string };
      rebound?: boolean;
      config: { configVersion: number };
    };
    expect(body).toMatchObject({
      endpointId: target.id,
      rebound: true,
      repository: {
        url: `rest:${INSTANCE.url}/agent/restic/${target.id}/`,
        password: target.repositoryPassword,
      },
      config: { configVersion: 2 },
    });
    expect(body.agentSecret).toMatch(/^rsea_/);
    // No machine was made, the runs stay.
    const [after] = await fixture.db.select({ n: count() }).from(endpoints);
    expect(after?.n).toBe(machines?.n);
    const runs = await fixture.db
      .select()
      .from(endpointRuns)
      .where(eq(endpointRuns.endpointId, target.id));
    expect(runs).toHaveLength(1);
    // The previous installation is refused, the new one is the machine.
    expect((await agent({ id: target.id, secret: target.agentSecret }, "/config")).status).toBe(
      401,
    );
    expect((await agent({ id: target.id, secret: body.agentSecret }, "/config")).status).toBe(200);
    const [row] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, target.id));
    expect(row).toMatchObject({ hostname: "web01-new", osVersion: "Debian GNU/Linux 12" });
    expect(row?.settings.activityBaselinePending).toBe(true);
    expect((await tokenRow(created.id))?.usedByEndpointId).toBe(target.id);
    const [audit] = await fixture.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "endpoint.rebound"), eq(auditLog.target, target.id)));
    expect(audit?.details).toMatchObject({
      previousHostname: `host-${target.id.slice(0, 8)}`,
      hostname: "web01-new",
      purpose: "reinstall",
      via: "enroll",
      tokenId: created.id,
    });
    const [tokenAudit] = await fixture.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "endpoint.rebind_token.created"), eq(auditLog.target, created.id)),
      );
    expect(tokenAudit).toMatchObject({ targetType: "endpoint_enrollment_token" });
    const bells = await fixture.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.event, "endpoint.rebound"),
          sql`${notifications.details}->>'endpointId' = ${target.id}`,
        ),
      );
    expect(bells).toHaveLength(1);
    // The token list tells a rebind token from an enrollment token.
    const listed = await service.listEnrollmentTokens(shared.db, fixture.tenantId, {
      state: "all",
    });
    expect(listed.items.find((item) => item.id === created.id)).toMatchObject({
      kind: "rebind",
      purpose: "reinstall",
      endpointId: target.id,
      state: "used",
    });

    // The first good backup after the rebind is the new baseline, the next one is not.
    const who = { id: target.id, secret: body.agentSecret };
    for (const baseline of [true, false]) {
      const start = await agent(who, "/runs", {
        method: "POST",
        body: JSON.stringify({ kind: "backup", startedAt: new Date().toISOString() }),
      });
      const { runId } = (await start.json()) as { runId: string };
      const finished = await agent(who, `/runs/${runId}/finish`, {
        method: "POST",
        body: JSON.stringify({
          status: "succeeded",
          finishedAt: new Date().toISOString(),
          snapshotId: randomBytes(32).toString("hex"),
          logTail: "",
          errors: [],
        }),
      });
      expect(finished.status, await finished.clone().text()).toBe(200);
      const [run] = await fixture.db.select().from(endpointRuns).where(eq(endpointRuns.id, runId));
      expect(run?.activityBaseline).toBe(baseline);
    }
    const [cleared] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, target.id));
    expect(cleared?.settings.activityBaselinePending).toBeUndefined();
  });

  it("brings a revoked machine back only with unrevoke", async () => {
    const target = await machine({ status: "revoked" });
    const plain = await token(target.id);
    const refused = await enroll(plain.token);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { type: string }).type).toBe(
      "urn:restow:problem:endpoint-revoked",
    );
    // Refused after the claim: the token is put back.
    expect((await tokenRow(plain.id))?.usedAt).toBeNull();
    const back = await token(target.id, { unrevoke: true });
    expect((await enroll(back.token)).status).toBe(201);
    const [row] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, target.id));
    expect(row).toMatchObject({ status: "active", revokedAt: null });
    const unrevoked = await fixture.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "endpoint.unrevoked"), eq(auditLog.target, target.id)));
    expect(unrevoked).toHaveLength(1);
    // Only for a revoked machine.
    await expect(token((await machine()).id, { unrevoke: true })).rejects.toMatchObject({
      status: 422,
    });
  });

  it("refuses another operating system and leaves the token usable", async () => {
    const target = await machine();
    const created = await token(target.id);
    const refused = await enroll(created.token, { os: "darwin" });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { type: string }).type).toBe(
      "urn:restow:problem:endpoint-rebind-os-mismatch",
    );
    expect((await tokenRow(created.id))?.usedAt).toBeNull();
    expect((await enroll(created.token)).status).toBe(201);
    // Used once: a second time is an unknown token.
    expect((await enroll(created.token)).status).toBe(401);
  });

  it("rotates nothing when the repository password is missing, and keeps the token for a retry", async () => {
    const target = await machine();
    const created = await token(target.id);
    const [before] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, target.id));
    await fixture.db
      .update(endpoints)
      .set({ repositorySecretId: null })
      .where(eq(endpoints.id, target.id));
    const rebound = () =>
      fixture.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "endpoint.rebound"), eq(auditLog.target, target.id)));
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await enroll(created.token);
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { type: string }).type).toBe(
        "urn:restow:problem:endpoint-repository-unavailable",
      );
      // Rolled back: the old installation keeps its secret, nothing is audited or alerted.
      const [row] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, target.id));
      expect(row?.secretHash).toBe(before?.secretHash);
      expect(await rebound()).toHaveLength(0);
      expect((await tokenRow(created.id))?.usedAt).toBeNull();
    }
    await fixture.db
      .update(endpoints)
      .set({ repositorySecretId: before?.repositorySecretId ?? null })
      .where(eq(endpoints.id, target.id));
    expect((await enroll(created.token)).status).toBe(201);
    expect(await rebound()).toHaveLength(1);
    expect((await tokenRow(created.id))?.usedAt).not.toBeNull();
  });

  it("ends the uninstall order meant for the previous installation", async () => {
    const target = await machine();
    const [task] = await fixture.db
      .insert(endpointTasks)
      .values({
        tenantId: fixture.tenantId,
        endpointId: target.id,
        kind: "uninstall",
        params: {},
        status: "delivered",
      })
      .returning();
    expect((await enroll((await token(target.id)).token)).status).toBe(201);
    const [after] = await fixture.db
      .select()
      .from(endpointTasks)
      .where(eq(endpointTasks.id, task?.id as string));
    expect(after).toMatchObject({ status: "failed", errorMessage: "machine rebound" });
  });

  it("keeps a rebind token to 24 hours, an enrollment token as before", async () => {
    const target = await machine();
    const day = await token(target.id, { validityHours: 24 });
    expect(new Date(day.expiresAt).getTime() - new Date(day.createdAt).getTime()).toBe(
      24 * 3600_000,
    );
    const refused = await fixture.db
      .insert(endpointEnrollmentTokens)
      .values({
        tenantId: fixture.tenantId,
        tokenHash: randomBytes(16).toString("hex"),
        profile: "server",
        endpointId: target.id,
        purpose: "baremetal",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 25 * 3600_000),
      })
      .then(
        () => null,
        (error: { cause?: { constraint?: string } }) => error.cause?.constraint,
      );
    expect(refused).toBe("endpoint_enrollment_tokens_rebind_24h");
    await fixture.db.insert(endpointEnrollmentTokens).values({
      tenantId: fixture.tenantId,
      tokenHash: randomBytes(16).toString("hex"),
      profile: "server",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 25 * 3600_000),
    });
    // A removed machine has no page and gets no token.
    await fixture.db
      .update(endpoints)
      .set({ status: "revoked", removedAt: new Date() })
      .where(eq(endpoints.id, target.id));
    await expect(token(target.id)).rejects.toMatchObject({ status: 404 });
  });

  describe("from the recovery ISO", () => {
    async function finishedSession(
      endpointId: string,
      status: "succeeded" | "active",
      finishedAgoMs = 0,
    ) {
      const secret = randomBytes(32).toString("hex");
      const now = Date.now();
      const [row] = await fixture.db
        .insert(endpointRecoveries)
        .values({
          tenantId: fixture.tenantId,
          endpointId,
          kind: "code",
          status,
          codeHash: randomBytes(32).toString("hex"),
          instanceOrigin: INSTANCE.url,
          issuedAt: new Date(now - 3600_000),
          expiresAt: new Date(now + 3600_000),
          usedAt: new Date(now - 3000_000),
          sessionSecretHash: hashSecret(secret),
          finishedAt: status === "succeeded" ? new Date(now - finishedAgoMs) : null,
        })
        .returning();
      return { id: row?.id as string, auth: sessionBasic(row?.id as string, secret) };
    }

    const rebindFrom = (auth: Record<string, string>, value: string) =>
      app.request("/agent/v1/recovery/sessions/current/rebind", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "x-forwarded-for": address() },
        body: JSON.stringify({
          token: value,
          hostname: "web01",
          os: "linux",
          arch: "amd64",
          agentVersion: "0.5.0",
          osVersion: "Debian GNU/Linux 12",
          hooks: "scripts",
        }),
      });

    it("rebinds after a successful recovery, within 15 minutes, with a token of the same machine", async () => {
      const target = await machine();
      const created = await token(target.id, { purpose: "baremetal" });
      const running = await finishedSession(target.id, "active");
      const early = await rebindFrom(running.auth, created.token);
      expect(early.status).toBe(409);
      expect(((await early.json()) as { type: string }).type).toBe(
        "urn:restow:problem:recovery-state-conflict",
      );
      const late = await finishedSession(target.id, "succeeded", 16 * 60 * 1000);
      expect((await rebindFrom(late.auth, created.token)).status).toBe(409);
      const other = await machine();
      const foreign = await token(other.id);
      const done = await finishedSession(target.id, "succeeded", 60_000);
      const wrong = await rebindFrom(done.auth, foreign.token);
      expect(wrong.status).toBe(401);
      expect((await tokenRow(foreign.id))?.usedAt).toBeNull();
      const response = await rebindFrom(done.auth, created.token);
      expect(response.status, await response.clone().text()).toBe(201);
      expect(await response.json()).toMatchObject({ endpointId: target.id, rebound: true });
      const [audit] = await fixture.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "endpoint.rebound"), eq(auditLog.target, target.id)));
      expect(audit?.details).toMatchObject({
        via: "recovery",
        recoveryId: done.id,
        purpose: "baremetal",
      });
      // Not a used token, and not an id that is no session.
      expect((await rebindFrom(done.auth, created.token)).status).toBe(401);
      expect((await rebindFrom(sessionBasic(randomUUID(), "x"), created.token)).status).toBe(401);
    });
  });
});
