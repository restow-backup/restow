/**
 * Postgres-backed tests of removing a machine (#65, removal.ts): only a revoked machine with its
 * hostname typed, refused while a legal hold over the tenant or a suspicious restore point holds
 * the backups (deleting now), "keep until they expire" dated by the machine's retention, and a
 * removed machine gone from every list and lookup while its runs and audit entries stay. Row
 * Level Security keeps every tenant to its own machines.
 *
 * The database `restow_api_endpoint_removal_test` is recreated on the server
 * RESTOW_TEST_DATABASE_URL points at and dropped after.
 */
import { randomUUID } from "node:crypto";
import { defaultEndpointConfig } from "@restow/core";
import {
  auditLog,
  backupJobMembers,
  backupJobs,
  type EndpointSettings,
  endpointRuns,
  endpoints,
  legalHolds,
  restorePointSuspicions,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EndpointFixture, startFixture, testDatabaseAdminUrl } from "./testing/fixture.js";

const DATABASE = "restow_api_endpoint_removal_test";

type Removal = typeof import("./removal.js");
type Service = typeof import("./service.js");
type Shared = typeof import("../../db.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-20T12:00:00.000Z");

describe.skipIf(!testDatabaseAdminUrl)("removing a machine against Postgres", () => {
  let fixture: EndpointFixture;
  let shared: Shared;
  let removal: Removal;
  let service: Service;

  const actor = () => ({
    label: "admin@contoso.example",
    userId: fixture.adminId,
    ip: "192.0.2.1",
  });

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    shared = await import("../../db.js");
    removal = await import("./removal.js");
    service = await import("./service.js");
  }, 90_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  async function machine(
    fields: {
      tenantId?: string;
      status?: "active" | "revoked";
      hostname?: string;
      lastSuccessAt?: Date | null;
      settings?: EndpointSettings;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await fixture.db.insert(endpoints).values({
      id,
      tenantId: fixture.tenantId,
      hostname: fields.hostname ?? `host-${id.slice(0, 6)}`,
      os: "linux",
      arch: "amd64",
      profile: "server",
      status: fields.status ?? "revoked",
      revokedAt: fields.status === "active" ? null : new Date(NOW.getTime() - DAY),
      secretHash: "h",
      config: defaultEndpointConfig("linux", "server", { timeZone: "Europe/Berlin" }),
      settings: fields.settings ?? {},
      lastSuccessAt:
        fields.lastSuccessAt === undefined
          ? new Date(NOW.getTime() - 3 * DAY)
          : fields.lastSuccessAt,
      repositoryBytes: 4096,
      ...(fields.tenantId ? { tenantId: fields.tenantId } : {}),
    });
    return id;
  }

  const remove = (
    id: string,
    input: { mode: "delete" | "expire"; confirmHostname: string },
    options: { tenantId?: string; suspicionHoldsApply?: boolean } = {},
  ) =>
    removal.removeEndpoint(shared.db, options.tenantId ?? fixture.tenantId, id, input, actor(), {
      now: NOW,
      suspicionHoldsApply: options.suspicionHoldsApply,
    });

  async function hostnameOf(id: string): Promise<string> {
    const [row] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, id));
    return row?.hostname ?? "";
  }

  async function problemOf(promise: Promise<unknown>): Promise<{ status: number; type?: string }> {
    try {
      await promise;
    } catch (error) {
      const problem = error as { status: number; type?: string };
      return { status: problem.status, type: problem.type };
    }
    throw new Error("expected a problem");
  }

  it("removes only a revoked machine, with its hostname typed exactly", async () => {
    const active = await machine({ status: "active" });
    expect(
      await problemOf(
        remove(active, { mode: "delete", confirmHostname: await hostnameOf(active) }),
      ),
    ).toEqual({ status: 409, type: "urn:restow:problem:endpoint-not-revoked" });

    const revoked = await machine();
    expect(await problemOf(remove(revoked, { mode: "delete", confirmHostname: "other" }))).toEqual({
      status: 422,
      type: "urn:restow:problem:endpoint-confirm-hostname",
    });
    const [row] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, revoked));
    expect(row?.removedAt).toBeNull();
  });

  it("deletes at once: gone from every list and lookup, out of its job, audited, history kept", async () => {
    const id = await machine({ hostname: "paperless" });
    const [job] = await fixture.db
      .insert(backupJobs)
      .values({ tenantId: fixture.tenantId, kind: "endpoint", name: `Machines ${id.slice(0, 4)}` })
      .returning();
    await fixture.db
      .insert(backupJobMembers)
      .values({ tenantId: fixture.tenantId, jobId: job?.id ?? "", endpointId: id });
    await fixture.db.insert(endpointRuns).values({
      tenantId: fixture.tenantId,
      endpointId: id,
      kind: "backup",
      status: "succeeded",
      startedAt: new Date(NOW.getTime() - 3 * DAY),
    });
    const before = (await service.listEndpoints(shared.db, fixture.tenantId, {}, NOW)).items;
    expect(before.map((item) => item.id)).toContain(id);

    const result = await remove(id, { mode: "delete", confirmHostname: " paperless " });
    expect(result).toMatchObject({
      id,
      mode: "delete",
      state: "scheduled",
      dueAt: NOW.toISOString(),
      expiresAt: null,
      requestedBy: "admin@contoso.example",
      repositoryBytes: 4096,
    });

    const after = (await service.listEndpoints(shared.db, fixture.tenantId, {}, NOW)).items;
    expect(after.map((item) => item.id)).not.toContain(id);
    // Until its backups are gone, its page opens for restoring from them, and only for that.
    const kept = await service.getEndpoint(
      shared.db,
      fixture.tenantId,
      id,
      "https://restow.test.example",
    );
    expect(kept.removed).toMatchObject({ mode: "delete", state: "scheduled" });
    await expect(
      service.revokeEndpoint(shared.db, fixture.tenantId, id, actor()),
    ).rejects.toMatchObject({ status: 404 });
    // A second removal finds nothing to remove.
    expect(
      (await problemOf(remove(id, { mode: "delete", confirmHostname: "paperless" }))).status,
    ).toBe(404);

    const members = await fixture.db
      .select()
      .from(backupJobMembers)
      .where(eq(backupJobMembers.endpointId, id));
    expect(members).toEqual([]);
    const runs = await fixture.db
      .select()
      .from(endpointRuns)
      .where(eq(endpointRuns.endpointId, id));
    expect(runs).toHaveLength(1);
    const [entry] = await fixture.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.target, id), eq(auditLog.action, "endpoint.removed")));
    expect(entry?.details).toMatchObject({
      hostname: "paperless",
      mode: "delete",
      leftJobs: [job?.id],
    });

    const listed = await removal.listRemovals(shared.db, fixture.tenantId);
    expect(listed.items.map((item) => item.id)).toContain(id);

    // Once its backups are deleted, the machine is gone for every reader.
    const [row] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, id));
    await fixture.db
      .update(endpoints)
      .set({ removal: { ...(row?.removal as object), state: "done" } as never })
      .where(eq(endpoints.id, id));
    await expect(
      service.getEndpoint(shared.db, fixture.tenantId, id, "https://restow.test.example"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("keeps the backups until the machine's retention lets the newest one go", async () => {
    const newest = new Date("2026-10-01T08:00:00.000Z");
    const id = await machine({
      lastSuccessAt: newest,
      settings: { retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 3 } },
    });
    const result = await remove(id, { mode: "expire", confirmHostname: await hostnameOf(id) });
    expect(result).toMatchObject({
      mode: "expire",
      state: "scheduled",
      expiresAt: "2027-01-01T08:00:00.000Z",
      dueAt: "2027-01-01T08:00:00.000Z",
    });

    // The default retention: twelve months.
    const defaults = await machine({ lastSuccessAt: newest });
    expect(
      (await remove(defaults, { mode: "expire", confirmHostname: await hostnameOf(defaults) }))
        .expiresAt,
    ).toBe("2027-10-01T08:00:00.000Z");

    // Long expired, or never backed up: due now.
    const old = await machine({ lastSuccessAt: new Date("2024-01-01T00:00:00.000Z") });
    expect(
      (await remove(old, { mode: "expire", confirmHostname: await hostnameOf(old) })).dueAt,
    ).toBe(NOW.toISOString());
    const never = await machine({ lastSuccessAt: null });
    expect(
      (await remove(never, { mode: "expire", confirmHostname: await hostnameOf(never) })).dueAt,
    ).toBe(NOW.toISOString());

    // A retention that keeps everything never lets anything go.
    const forever = await machine({
      settings: { retention: { keepDaily: 0, keepWeekly: 0, keepMonthly: 0 } },
    });
    expect(
      await problemOf(
        remove(forever, { mode: "expire", confirmHostname: await hostnameOf(forever) }),
      ),
    ).toEqual({ status: 409, type: "urn:restow:problem:endpoint-removal-never-expires" });
  });

  it("refuses deleting now under a legal hold over the tenant, but keeps until expiry", async () => {
    const [hold] = await fixture.db
      .insert(legalHolds)
      .values({ tenantId: fixture.tenantId, reason: "Litigation" })
      .returning();
    try {
      const id = await machine();
      expect(
        await problemOf(remove(id, { mode: "delete", confirmHostname: await hostnameOf(id) })),
      ).toEqual({ status: 409, type: "urn:restow:problem:endpoint-removal-legal-hold" });
      expect(
        (await remove(id, { mode: "expire", confirmHostname: await hostnameOf(id) })).state,
      ).toBe("scheduled");
      // The other tenant's machines are not held by it.
      const other = await machine({ tenantId: fixture.otherTenantId });
      expect(
        (
          await remove(
            other,
            { mode: "delete", confirmHostname: await hostnameOf(other) },
            { tenantId: fixture.otherTenantId },
          )
        ).state,
      ).toBe("scheduled");
    } finally {
      await fixture.db
        .update(legalHolds)
        .set({ active: false, releasedAt: NOW })
        .where(eq(legalHolds.id, hold?.id ?? ""));
    }
  });

  it("refuses deleting now while a suspicious restore point holds the machine", async () => {
    const id = await machine();
    await fixture.db.insert(restorePointSuspicions).values({
      tenantId: fixture.tenantId,
      objectKind: "endpoint",
      objectId: id,
      runId: randomUUID(),
      restorePointId: "a".repeat(64),
      restorePointAt: new Date(NOW.getTime() - 2 * DAY),
      verdict: "suspicious",
      metrics: { itemsChanged: 900, itemsTotal: 1000, bytesAdded: 1 },
      signaturesVersion: "1",
    });
    expect(
      await problemOf(remove(id, { mode: "delete", confirmHostname: await hostnameOf(id) })),
    ).toEqual({ status: 409, type: "urn:restow:problem:endpoint-removal-suspicion-hold" });
    // The owner switched the hold off: nothing holds.
    expect(
      (
        await remove(
          id,
          { mode: "delete", confirmHostname: await hostnameOf(id) },
          { suspicionHoldsApply: false },
        )
      ).state,
    ).toBe("scheduled");
  });

  it("keeps every tenant to its own machines", async () => {
    const theirs = await machine({ tenantId: fixture.otherTenantId, hostname: "fabrikam-srv" });
    expect(
      (await problemOf(remove(theirs, { mode: "delete", confirmHostname: "fabrikam-srv" }))).status,
    ).toBe(404);
    const [row] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, theirs));
    expect(row?.removedAt).toBeNull();
    const ours = (await removal.listRemovals(shared.db, fixture.tenantId)).items.map(
      (item) => item.id,
    );
    expect(ours).not.toContain(theirs);
    const others = (await removal.listRemovals(shared.db, fixture.otherTenantId)).items;
    expect(others.map((item) => item.hostname)).not.toContain("paperless");
  });

  it("suggests revoking a machine without contact for longer than its setting", async () => {
    const quiet = await machine({ status: "active", settings: { revokeHintAfterDays: 10 } });
    await fixture.db
      .update(endpoints)
      .set({ lastSeenAt: new Date(NOW.getTime() - 11 * DAY) })
      .where(eq(endpoints.id, quiet));
    const recent = await machine({ status: "active" });
    await fixture.db
      .update(endpoints)
      .set({ lastSeenAt: new Date(NOW.getTime() - 11 * DAY) })
      .where(eq(endpoints.id, recent));
    const items = (await service.listEndpoints(shared.db, fixture.tenantId, {}, NOW)).items;
    expect(items.find((item) => item.id === quiet)?.attention).toContain("revoke_suggested");
    // The default is 30 days.
    expect(items.find((item) => item.id === recent)?.attention).not.toContain("revoke_suggested");
  });
});
