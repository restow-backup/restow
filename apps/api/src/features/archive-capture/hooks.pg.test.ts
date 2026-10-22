/**
 * The public Graph hooks against Postgres, on the application and installation roles: the
 * validation echo, 202 for everything else, a notification recorded once as pending with
 * the stream due, a wrong clientState or an unknown subscription ignored, tenant
 * isolation, the lifecycle events, the 1 MiB body limit and 404 while the gate is closed.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the
 * database `restow_api_graph_hooks_test` is recreated there and dropped after).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { hashClientState, newClientState } from "@restow/core";
import {
  archiveCaptureStreams,
  createDb,
  type Database,
  graphSubscriptions,
  protectedObjects,
  providers,
  sources,
  tenants,
} from "@restow/db";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_graph_hooks_test";

describe.skipIf(!testDatabaseAdminUrl)("graph hooks against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let gateOpen = true;
  const fixtures: Array<{
    tenantId: string;
    objectId: string;
    subscriptionId: string;
    clientState: string;
  }> = [];

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    providerDb = createDb(roles.providerUrl);
    const { buildGraphHookRoutes } = await import("./hooks.js");
    const { errorHandler } = await import("../../problem.js");
    const { requestBodyLimit } = await import("../../middleware/body-limit.js");

    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    for (const name of ["Contoso", "Fabrikam"]) {
      const [tenant] = await owner
        .insert(tenants)
        .values({ providerId: provider?.id ?? "", name, slug: name.toLowerCase() })
        .returning();
      const tenantId = tenant?.id ?? "";
      const [source] = await owner
        .insert(sources)
        .values({ tenantId, kind: "m365", name: `${name} 365`, status: "active" })
        .returning();
      const [object] = await owner
        .insert(protectedObjects)
        .values({
          tenantId,
          sourceId: source?.id ?? "",
          kind: "mailbox",
          externalId: `anna@${name.toLowerCase()}.example`,
        })
        .returning();
      await owner.insert(archiveCaptureStreams).values({
        tenantId,
        protectedObjectId: object?.id ?? "",
        sourceId: source?.id ?? "",
        way: "graph_sync",
        status: "live",
        nextDueAt: new Date(Date.now() + 3_600_000),
      });
      const clientState = newClientState();
      const subscriptionId = randomUUID();
      await owner.insert(graphSubscriptions).values({
        tenantId,
        sourceId: source?.id ?? "",
        protectedObjectId: object?.id ?? "",
        subscriptionId,
        resource: "users/x/messages",
        clientStateHash: hashClientState(clientState),
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      fixtures.push({ tenantId, objectId: object?.id ?? "", subscriptionId, clientState });
    }

    app = new Hono();
    app.onError(errorHandler);
    app.use("*", requestBodyLimit);
    app.route(
      "/api/v1/hooks/graph",
      buildGraphHookRoutes({ db: appDb, providerDb, enabled: async () => gateOpen }),
    );
  }, 60_000);

  afterEach(() => {
    gateOpen = true;
  });

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await appDb?.$client.end();
    await providerDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    if (roles) {
      await roles.drop(testDatabaseAdminUrl as string);
    }
  }, 60_000);

  const post = (path: string, body: unknown, query = "") =>
    app.request(`/api/v1/hooks/graph/${path}${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  const notification = (
    f: (typeof fixtures)[number],
    messageId: string,
    clientState: string = f.clientState,
  ) => ({
    subscriptionId: f.subscriptionId,
    clientState,
    changeType: "created",
    resource: `Users/x/Messages/${messageId}`,
    resourceData: { id: messageId },
  });

  async function pending(objectId: string): Promise<string[]> {
    const result = await owner.execute<{ ref: string }>(sql`
      select external_ref as ref from archive_capture_pending
       where protected_object_id = ${objectId} order by external_ref
    `);
    return result.rows.map((row) => row.ref);
  }

  async function due(objectId: string): Promise<boolean> {
    const [row] = await owner
      .select()
      .from(archiveCaptureStreams)
      .where(eq(archiveCaptureStreams.protectedObjectId, objectId));
    return (row?.nextDueAt?.getTime() ?? Infinity) <= Date.now() && row?.dirtySince !== null;
  }

  it("echoes the validation token as plain text on both hooks", async () => {
    for (const path of ["notifications", "lifecycle"]) {
      const res = await app.request(
        `/api/v1/hooks/graph/${path}?validationToken=${encodeURIComponent("Validation: Token <42>")}`,
        { method: "POST", headers: { "content-type": "text/plain" } },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).toBe("Validation: Token <42>");
    }
  });

  it("records a notification once as pending and makes the stream due", async () => {
    const [contoso, fabrikam] = fixtures as [(typeof fixtures)[0], (typeof fixtures)[0]];
    const res = await post("notifications", {
      value: [notification(contoso, "AAMk-1"), notification(contoso, "AAMk-1")],
    });
    expect(res.status).toBe(202);
    expect(
      await post("notifications", { value: [notification(contoso, "AAMk-1")] }),
    ).toHaveProperty("status", 202);
    expect(await pending(contoso.objectId)).toEqual(["AAMk-1"]);
    expect(await due(contoso.objectId)).toBe(true);
    expect(await pending(fabrikam.objectId)).toEqual([]);
    const [subscription] = await owner
      .select()
      .from(graphSubscriptions)
      .where(eq(graphSubscriptions.subscriptionId, contoso.subscriptionId));
    expect(subscription?.lastNotificationAt).not.toBeNull();
  });

  it("ignores a wrong clientState, an unknown subscription and garbage, still 202", async () => {
    const [, fabrikam] = fixtures as [(typeof fixtures)[0], (typeof fixtures)[0]];
    const [contoso] = fixtures as [(typeof fixtures)[0]];
    for (const body of [
      { value: [notification(fabrikam, "forged", contoso.clientState)] },
      { value: [notification(fabrikam, "forged", "")] },
      { value: [{ ...notification(fabrikam, "forged"), subscriptionId: randomUUID() }] },
      "{not json",
      "",
      { value: "nope" },
    ]) {
      expect((await post("notifications", body)).status).toBe(202);
    }
    expect(await pending(fabrikam.objectId)).toEqual([]);
    expect(await due(fabrikam.objectId)).toBe(false);
  });

  it("records the lifecycle events on the subscription", async () => {
    const [, fabrikam] = fixtures as [(typeof fixtures)[0], (typeof fixtures)[0]];
    const event = (lifecycleEvent: string) =>
      post("lifecycle", {
        value: [
          {
            subscriptionId: fabrikam.subscriptionId,
            clientState: fabrikam.clientState,
            lifecycleEvent,
          },
        ],
      });
    const row = async () =>
      (
        await owner
          .select()
          .from(graphSubscriptions)
          .where(eq(graphSubscriptions.subscriptionId, fabrikam.subscriptionId))
      )[0];

    expect((await event("missed")).status).toBe(202);
    expect(await row()).toMatchObject({ status: "active", lastLifecycleEvent: "missed" });
    expect(await due(fabrikam.objectId)).toBe(true);

    expect((await event("reauthorizationRequired")).status).toBe(202);
    expect((await row())?.status).toBe("reauthorization_required");

    // A forged event changes nothing.
    await post("lifecycle", {
      value: [
        {
          subscriptionId: fabrikam.subscriptionId,
          clientState: "forged",
          lifecycleEvent: "subscriptionRemoved",
        },
      ],
    });
    expect((await row())?.status).toBe("reauthorization_required");

    expect((await event("subscriptionRemoved")).status).toBe(202);
    expect(await row()).toMatchObject({
      status: "removed",
      lastLifecycleEvent: "subscriptionRemoved",
    });
  });

  it("refuses a body over 1 MiB", async () => {
    const res = await post("notifications", { value: [], pad: "x".repeat(1024 * 1024 + 10) });
    expect(res.status).toBe(413);
  });

  it("answers 404 while the gate is closed", async () => {
    gateOpen = false;
    expect((await post("notifications", { value: [] })).status).toBe(404);
    expect((await post("lifecycle", {}, "?validationToken=abc")).status).toBe(404);
  });
});
