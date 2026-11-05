/**
 * Bare metal recovery in the worker against Postgres (docs/BAREMETAL.md 9.7, 9.8, 9.9), M3:
 *
 *   - retention waits while a session reads the repository (`active` or `finishing`, not
 *     expired): asked before the exclusive lock and again once it is held, so a session that
 *     became active in between stops it as well; a session that waits for its release does not;
 *   - the removal of a removed machine's backups waits the same way, deletes nothing and records
 *     no failure;
 *   - the monitor expires codes nobody redeemed, fails sessions nobody released in 30 minutes or
 *     before their code expired, and sessions silent 30 minutes past their expiry, one audit entry each and the alert for a
 *     failed one, and nothing on a second pass; logs older than 90 days go.
 *
 * Needs RESTOW_TEST_DATABASE_URL (a superuser; the database `restow_worker_recovery_test` is
 * recreated). No restic: the repository is never opened.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  endpointPrefix,
  LocalStorageBackend,
  noopLogger,
  type StorageTargets,
  type TenantKeyring,
} from "@restow/core";
import {
  auditLog,
  createDb,
  type Database,
  deriveAuthLogin,
  EndpointRecoveryActiveError,
  type EndpointRecoveryStatus,
  endpointRecoveries,
  endpointRecoveryLog,
  endpoints,
  notifications,
  type RoleLogin,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TenantCache } from "../handlers/framework.js";
import { dropTestDatabase } from "../testing/database.js";
import type { EndpointJobDeps } from "./common.js";

const hooks = vi.hoisted(() => ({ beforeLock: null as null | (() => Promise<void>) }));

// The repository is never opened here: retention is stopped before it reads anything. The lock is
// the real one; a test may run something between the first look and taking it.
vi.mock("./common.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./common.js")>();
  return {
    ...original,
    openEndpointRepository: async (
      deps: EndpointJobDeps,
      tenantId: string,
      endpointId: string,
    ) => ({
      endpoint: await original.loadEndpoint(deps, tenantId, endpointId),
      access: {} as never,
    }),
    withMaintenanceLock: async <T>(
      deps: EndpointJobDeps,
      endpointId: string,
      mode: "exclusive" | "shared",
      work: () => Promise<T>,
    ) => {
      await hooks.beforeLock?.();
      return original.withMaintenanceLock(deps, endpointId, mode, work);
    },
  };
});

const { waitForRecovery } = await import("./common.js");
const { endpointRetention } = await import("./retention.js");
const { endpointRemoval } = await import("./removal.js");
const { expireRecoveries } = await import("./monitor.js");

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_recovery_test";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe.skipIf(!adminUrl)("bare metal recovery in the worker", () => {
  let owner: Database;
  let appDb: Database;
  let providerDb: Database;
  let deps: EndpointJobDeps;
  let tenantId = "";
  let work = "";
  let storage: LocalStorageBackend;
  const clock = new Date();
  const roleNames: string[] = [];

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.$client.end();
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    const suffix = randomBytes(4).toString("hex");
    const tenantLogin: RoleLogin = {
      name: `restow_rc_app_${suffix}`,
      password: randomBytes(12).toString("hex"),
    };
    const installationLogin: RoleLogin = {
      name: `restow_rc_inst_${suffix}`,
      password: randomBytes(12).toString("hex"),
    };
    roleNames.push(
      tenantLogin.name,
      installationLogin.name,
      deriveAuthLogin(tenantLogin, installationLogin).name,
    );
    await runMigrations(url.toString(), {
      roles: { tenant: tenantLogin, installation: installationLogin },
    });
    owner = createDb(url.toString());
    const asRole = (login: RoleLogin) => {
      const copy = new URL(url);
      copy.username = login.name;
      copy.password = login.password;
      return createDb(copy.toString());
    };
    appDb = asRole(tenantLogin);
    providerDb = asRole(installationLogin);
    work = await mkdtemp(join(tmpdir(), "restow-worker-recovery-"));
    storage = new LocalStorageBackend(work);
    const [provider] = (
      await owner.$client.query<{ id: string }>(
        "INSERT INTO providers (name) VALUES ('p') RETURNING id",
      )
    ).rows;
    const [tenant] = (
      await owner.$client.query<{ id: string }>(
        "INSERT INTO tenants (provider_id, name, slug) VALUES ($1, 'Contoso', 'contoso') RETURNING id",
        [provider?.id],
      )
    ).rows;
    tenantId = tenant?.id ?? "";
    await owner.$client.query(
      `INSERT INTO report_rules (tenant_id, name, trigger, events, email_recipients)
       VALUES ($1, 'Recovery', 'event', ARRAY['endpoint.recovery.failed'], ARRAY['it@contoso.example'])`,
      [tenantId],
    );
    const targets: StorageTargets = { primary: storage, copies: [] } as unknown as StorageTargets;
    deps = {
      db: appDb,
      providerDb,
      runtime: {
        keyrings: new TenantCache<TenantKeyring>(async () => {
          throw new Error("no keys needed");
        }),
        storage: { get: async () => targets } as never,
        logger: noopLogger,
        now: () => clock,
        shutdownSignal: new AbortController().signal,
      },
      maintenanceLockWaitMs: 2000,
    };
  }, 90_000);

  afterAll(async () => {
    await Promise.all([appDb?.$client.end(), providerDb?.$client.end(), owner?.$client.end()]);
    await dropTestDatabase(adminUrl as string, TEST_DB);
    const admin = createDb(adminUrl as string);
    for (const role of roleNames) {
      await admin.$client.query(`DROP ROLE IF EXISTS ${role}`);
    }
    await admin.$client.end();
    if (work) await rm(work, { recursive: true, force: true });
  });

  async function machine(removed = false): Promise<string> {
    const id = randomUUID();
    await owner.insert(endpoints).values({
      id,
      tenantId,
      hostname: `host-${id.slice(0, 6)}`,
      os: "linux",
      arch: "amd64",
      profile: "server",
      status: removed ? "revoked" : "active",
      secretHash: "h",
      config: {} as never,
      ...(removed
        ? {
            removedAt: clock,
            removal: {
              mode: "delete" as const,
              state: "scheduled" as const,
              requestedBy: "admin@contoso.example",
              requestedAt: clock.toISOString(),
            },
            removalDueAt: new Date(clock.getTime() - HOUR),
          }
        : {}),
    });
    return id;
  }

  async function recovery(
    endpointId: string,
    status: EndpointRecoveryStatus,
    times: { issuedAgo?: number; expiresIn: number; usedAgo?: number },
  ): Promise<string> {
    const [row] = await owner
      .insert(endpointRecoveries)
      .values({
        tenantId,
        endpointId,
        kind: "code",
        status,
        codeHash: randomBytes(32).toString("hex"),
        issuedAt: new Date(clock.getTime() - (times.issuedAgo ?? HOUR)),
        expiresAt: new Date(clock.getTime() + times.expiresIn),
        usedAt: times.usedAgo === undefined ? null : new Date(clock.getTime() - times.usedAgo),
      })
      .returning();
    return row?.id as string;
  }

  const statusOf = async (id: string) =>
    (await owner.select().from(endpointRecoveries).where(eq(endpointRecoveries.id, id)))[0]?.status;

  const expiredAudits = (id: string) =>
    owner
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "endpoint.recovery.expired"),
          sql`${auditLog.details}->>'recoveryId' = ${id}`,
        ),
      );

  it("keeps retention away from a running session, in both orders, but not from one that waits", async () => {
    const id = await machine();
    const running = await recovery(id, "active", { expiresIn: HOUR, usedAgo: MINUTE });
    await expect(endpointRetention(deps, { tenantId, endpointId: id })).rejects.toBeInstanceOf(
      EndpointRecoveryActiveError,
    );
    await owner
      .update(endpointRecoveries)
      .set({ status: "succeeded" })
      .where(eq(endpointRecoveries.id, running));
    // The session is released after the first look and before the lock: the second look stops it.
    const other = await machine();
    hooks.beforeLock = async () => {
      await recovery(other, "finishing", { expiresIn: HOUR, usedAgo: MINUTE });
    };
    try {
      await expect(endpointRetention(deps, { tenantId, endpointId: other })).rejects.toBeInstanceOf(
        EndpointRecoveryActiveError,
      );
    } finally {
      hooks.beforeLock = null;
    }
    // Waiting for a release, or past its expiry, holds nothing.
    const waiting = await machine();
    await recovery(waiting, "pending_approval", { expiresIn: HOUR, usedAgo: MINUTE });
    await recovery(waiting, "active", { expiresIn: -MINUTE, usedAgo: HOUR });
    await expect(waitForRecovery(deps, waiting)).resolves.toBeUndefined();
  });

  it("defers removing a machine's backups while a session reads them, and records no failure", async () => {
    const id = await machine(true);
    await storage.put(`${endpointPrefix(id)}config`, Buffer.from("config"));
    await recovery(id, "active", { expiresIn: HOUR, usedAgo: MINUTE });
    await expect(endpointRemoval(deps, { tenantId, endpointId: id })).rejects.toBeInstanceOf(
      EndpointRecoveryActiveError,
    );
    expect(await storage.list(endpointPrefix(id))).toHaveLength(1);
    const audits = await owner.select().from(auditLog).where(eq(auditLog.target, id));
    expect(audits).toHaveLength(0);
    const [row] = await owner.select().from(endpoints).where(eq(endpoints.id, id));
    expect(row?.removal?.lastError ?? null).toBeNull();
  });

  it("ends codes and sessions that ran out of time, once each, and purges old logs", async () => {
    const id = await machine();
    const unused = await recovery(id, "issued", { expiresIn: -MINUTE });
    const fresh = await recovery(id, "issued", { expiresIn: HOUR });
    const unreleased = await recovery(id, "pending_approval", {
      expiresIn: HOUR,
      usedAgo: 31 * MINUTE,
    });
    const waiting = await recovery(id, "pending_approval", {
      expiresIn: HOUR,
      usedAgo: 10 * MINUTE,
    });
    const silent = await recovery(id, "active", {
      issuedAgo: 5 * HOUR,
      expiresIn: -31 * MINUTE,
      usedAgo: 4 * HOUR,
    });
    const late = await recovery(id, "finishing", {
      issuedAgo: 5 * HOUR,
      expiresIn: -10 * MINUTE,
      usedAgo: 4 * HOUR,
    });
    await owner.insert(endpointRecoveryLog).values([
      { tenantId, recoveryId: late, lines: "old", createdAt: new Date(clock.getTime() - 91 * DAY) },
      { tenantId, recoveryId: late, lines: "new", createdAt: new Date(clock.getTime() - DAY) },
    ]);

    const first = await expireRecoveries(deps, clock);
    expect(first).toEqual({ expired: 1, failed: 2, purgedLogs: 1 });
    expect(await statusOf(unused)).toBe("expired");
    expect(await statusOf(fresh)).toBe("issued");
    expect(await statusOf(unreleased)).toBe("failed");
    expect(await statusOf(waiting)).toBe("pending_approval");
    expect(await statusOf(silent)).toBe("failed");
    expect(await statusOf(late)).toBe("finishing");
    for (const [recoveryId, reason] of [
      [unused, "expired"],
      [unreleased, "not_approved"],
      [silent, "silent"],
    ] as const) {
      const entries = await expiredAudits(recoveryId);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.details).toMatchObject({ reason });
    }
    expect(await expiredAudits(fresh)).toHaveLength(0);
    const failed = await owner
      .select()
      .from(notifications)
      .where(eq(notifications.event, "endpoint.recovery.failed"));
    expect(failed.map((row) => (row.details as { reason: string }).reason).sort()).toEqual([
      "not_approved",
      "silent",
    ]);
    const queued = await owner.$client.query(
      "SELECT 1 FROM report_deliveries WHERE event = 'endpoint.recovery.failed'",
    );
    expect(queued.rowCount).toBe(2);
    const logs = await owner.select().from(endpointRecoveryLog);
    expect(logs.map((row) => row.lines)).toEqual(["new"]);

    // A second pass finds nothing to do.
    expect(await expireRecoveries(deps, clock)).toEqual({ expired: 0, failed: 0, purgedLogs: 0 });
    expect(await expiredAudits(unused)).toHaveLength(1);
  });

  it("fails a waiting session whose code expired before the 30 minutes, as expired", async () => {
    const id = await machine();
    const ranOut = await recovery(id, "pending_approval", {
      issuedAgo: 4 * HOUR,
      expiresIn: -5 * MINUTE,
      usedAgo: 15 * MINUTE,
    });
    expect(await expireRecoveries(deps, clock)).toMatchObject({ expired: 0, failed: 1 });
    expect(await statusOf(ranOut)).toBe("failed");
    const entries = await expiredAudits(ranOut);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.details).toMatchObject({ from: "pending_approval", reason: "expired" });
    const [alert] = await owner
      .select()
      .from(notifications)
      .where(sql`${notifications.details}->>'recoveryId' = ${ranOut}`);
    expect(alert?.message).toContain("expired before the session was released");
  });
});
