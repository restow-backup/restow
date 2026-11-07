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
  notifications,
  reportEvents,
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
    input: { mode: "delete" | "expire"; confirmHostname: string; reason?: string },
    options: { tenantId?: string; suspicionHoldsApply?: boolean } = {},
  ) =>
    removal.removeEndpoint(
      shared.db,
      options.tenantId ?? fixture.tenantId,
      id,
      // A deletion needs a reason (0.5.0); the tests that are not about it give one.
      input.mode === "delete" && input.reason === undefined
        ? { ...input, reason: "Machine sold" }
        : input,
      actor(),
      { now: NOW, suspicionHoldsApply: options.suspicionHoldsApply },
    );

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

  it("schedules deleting in seven days: still listed, out of its job, audited, alerted", async () => {
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

    const due = new Date(NOW.getTime() + removal.BACKUP_DELETION_DELAY_DAYS * DAY).toISOString();
    expect(removal.BACKUP_DELETION_DELAY_DAYS).toBe(7);
    const result = await remove(id, {
      mode: "delete",
      confirmHostname: " paperless ",
      reason: "  Machine sold  ",
    });
    expect(result).toMatchObject({
      id,
      mode: "delete",
      state: "scheduled",
      dueAt: due,
      expiresAt: null,
      requestedBy: "admin@contoso.example",
      repositoryBytes: 4096,
      reason: "Machine sold",
      cancellable: true,
    });

    // Until the worker starts, the machine stays listed (revoked) and its page says when.
    const listed = (await service.listEndpoints(shared.db, fixture.tenantId, {}, NOW)).items;
    expect(listed.map((item) => item.id)).toContain(id);
    const detail = await service.getEndpoint(
      shared.db,
      fixture.tenantId,
      id,
      "https://restow.test.example",
    );
    expect(detail.removed).toBeNull();
    expect(detail.backupDeletion).toEqual({
      dueAt: due,
      requestedAt: NOW.toISOString(),
      requestedBy: "admin@contoso.example",
      reason: "Machine sold",
      state: "scheduled",
      heldBy: null,
    });
    // Not among the removed machines yet; and asking again is refused.
    expect(
      (await removal.listRemovals(shared.db, fixture.tenantId)).items.map((item) => item.id),
    ).not.toContain(id);
    expect(await problemOf(remove(id, { mode: "expire", confirmHostname: "paperless" }))).toEqual({
      status: 409,
      type: "urn:restow:problem:endpoint-removal-scheduled",
    });

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
      .where(and(eq(auditLog.target, id), eq(auditLog.action, "endpoint.removal.scheduled")));
    expect(entry?.details).toMatchObject({
      hostname: "paperless",
      mode: "delete",
      dueAt: due,
      reason: "Machine sold",
      leftJobs: [job?.id],
      queued: false,
    });
    // The critical alert: in the bell and for the provider's recipients (report_events).
    const [alert] = await fixture.db
      .select()
      .from(reportEvents)
      .where(
        and(
          eq(reportEvents.tenantId, fixture.tenantId),
          eq(reportEvents.event, "endpoint.backups_deletion_scheduled"),
        ),
      );
    expect(alert).toMatchObject({ level: "warning" });
    expect(alert?.details).toMatchObject({
      endpointId: id,
      objectName: "paperless",
      dueAt: due,
      reason: "Machine sold",
    });
    const bell = await fixture.db
      .select()
      .from(notifications)
      .where(eq(notifications.event, "endpoint.backups_deletion_scheduled"));
    expect(bell.length).toBeGreaterThan(0);
  });

  it("needs a reason to delete, not to keep until expiry", async () => {
    const id = await machine();
    expect(
      await problemOf(
        remove(id, { mode: "delete", confirmHostname: await hostnameOf(id), reason: "   " }),
      ),
    ).toEqual({ status: 422, type: "urn:restow:problem:endpoint-removal-reason-required" });
    expect(
      (await remove(id, { mode: "expire", confirmHostname: await hostnameOf(id) })).state,
    ).toBe("scheduled");
  });

  it("cancels a scheduled deletion until the worker starts, audited", async () => {
    const id = await machine({ hostname: "nas-old" });
    await remove(id, { mode: "delete", confirmHostname: "nas-old" });
    await removal.cancelRemoval(shared.db, fixture.tenantId, id, actor());
    const [row] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, id));
    expect(row).toMatchObject({ removal: null, removalDueAt: null, removedAt: null });
    const [entry] = await fixture.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.target, id), eq(auditLog.action, "endpoint.removal.cancelled")));
    expect(entry?.details).toMatchObject({
      hostname: "nas-old",
      requestedBy: "admin@contoso.example",
      reason: "Machine sold",
    });
    // Nothing left to cancel.
    expect(
      await problemOf(removal.cancelRemoval(shared.db, fixture.tenantId, id, actor())),
    ).toEqual({ status: 409, type: "urn:restow:problem:endpoint-removal-not-cancellable" });

    // Once the worker started (startedAt, removed_at), it can no longer be cancelled.
    const started = await machine({ hostname: "nas-gone" });
    await remove(started, { mode: "delete", confirmHostname: "nas-gone" });
    const [before] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, started));
    await fixture.db
      .update(endpoints)
      .set({
        removedAt: NOW,
        removal: { ...(before?.removal as object), startedAt: NOW.toISOString() } as never,
      })
      .where(eq(endpoints.id, started));
    expect(
      await problemOf(removal.cancelRemoval(shared.db, fixture.tenantId, started, actor())),
    ).toEqual({ status: 409, type: "urn:restow:problem:endpoint-removal-not-cancellable" });

    // An expiry is no deletion to cancel.
    const expiring = await machine();
    await remove(expiring, { mode: "expire", confirmHostname: await hostnameOf(expiring) });
    expect(
      (await problemOf(removal.cancelRemoval(shared.db, fixture.tenantId, expiring, actor())))
        .status,
    ).toBe(409);
    // Another tenant's machine is not found.
    expect(
      (await problemOf(removal.cancelRemoval(shared.db, fixture.otherTenantId, id, actor())))
        .status,
    ).toBe(404);
  });

  it("removes at once when keeping until expiry: gone from every list, readable until done", async () => {
    const id = await machine({ hostname: "paperless-old", lastSuccessAt: null });
    const result = await remove(id, { mode: "expire", confirmHostname: "paperless-old" });
    expect(result).toMatchObject({ id, mode: "expire", dueAt: NOW.toISOString() });
    const after = (await service.listEndpoints(shared.db, fixture.tenantId, {}, NOW)).items;
    expect(after.map((item) => item.id)).not.toContain(id);
    const kept = await service.getEndpoint(
      shared.db,
      fixture.tenantId,
      id,
      "https://restow.test.example",
    );
    expect(kept.removed).toMatchObject({ mode: "expire", state: "scheduled" });
    expect(kept.backupDeletion).toBeNull();
    await expect(
      service.revokeEndpoint(shared.db, fixture.tenantId, id, actor()),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await problemOf(remove(id, { mode: "expire", confirmHostname: "paperless-old" }))).status,
    ).toBe(404);
    const [entry] = await fixture.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.target, id), eq(auditLog.action, "endpoint.removed")));
    expect(entry?.details).toMatchObject({ hostname: "paperless-old", mode: "expire" });
    expect(
      (await removal.listRemovals(shared.db, fixture.tenantId)).items.map((item) => item.id),
    ).toContain(id);

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
