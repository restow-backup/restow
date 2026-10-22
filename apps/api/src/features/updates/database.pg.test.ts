/**
 * Postgres-backed tests of Installation > Database (database.ts) and the low disk space
 * warning (disk-watch.ts): what reaches the installation audit chain (a requested move,
 * a removal, every dump download before its first byte, every deletion), what does not
 * (a refused request), the move's outcome from the updater's journal in the audit log
 * and the bell, and the disk warning raised once per episode in the bell and in every
 * tenant's rule that lists it.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the
 * database `restow_api_database_test` is recreated there and dropped after). Without it
 * the suite is skipped.
 */
import { randomBytes } from "node:crypto";
import {
  auditLog,
  createDb,
  type Database,
  notifications,
  providers,
  reportDeliveries,
  reportRules,
  settings,
  tenants,
} from "@restow/db";
import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProblemError } from "../../problem.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import type {
  MoveCheck,
  MoveRequest,
  DatabaseView as UpdaterDatabaseView,
} from "../../updater/database-protocol.js";
import type { JournalEvent, StateView } from "../../updater/protocol.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { type UpdaterClient, UpdaterRejectedError } from "./updater-client.js";

const DATABASE = "restow_api_database_test";
const GIB = 1024 ** 3;
const DUMP = "restow-20260930-100000-0.3.6-to-0.4.0.dump";
const actor = { id: "owner-1", email: "owner@provider.test", ip: "192.0.2.10" };

type DatabaseModule = typeof import("./database.js");
type DiskWatchModule = typeof import("./disk-watch.js");
type ServiceModule = typeof import("./service.js");
type StateModule = typeof import("./state.js");

const USAGE = {
  dataBytes: 29 * GIB,
  filesystemTotalBytes: 38 * GIB,
  filesystemFreeBytes: 4 * GIB,
  filesystem: "ext2/ext3",
  measuredAt: "2026-10-01T09:00:00.000Z",
};

function databaseView(over: Partial<UpdaterDatabaseView> = {}): UpdaterDatabaseView {
  return {
    location: { kind: "volume", source: "restow_pgdata" },
    usage: USAGE,
    movable: true,
    move: null,
    oldCopies: [
      {
        id: "c-1",
        location: { kind: "volume", source: "restow_pgdata" },
        moveId: "m-1",
        movedAt: "2026-10-01T08:00:00.000Z",
      },
    ],
    removal: null,
    ...over,
  };
}

function stateView(over: Partial<StateView> = {}): StateView {
  return {
    updaterVersion: "0.4.0",
    phase: "idle",
    run: null,
    history: [],
    events: [],
    capabilities: {
      ready: true,
      blockers: [],
      runner: "helper",
      composeFile: "docker-compose.yml",
      imageRepository: "ghcr.io/restow-backup/restow",
      webImageRepository: "ghcr.io/restow-backup/restow-web",
      dumps: [],
      sourceAllowlist: [],
      signatureChecks: true,
      projectDir: "/opt/restow",
      mounterService: true,
      updateSpace: null,
      checkedAt: "2026-10-01T09:00:00.000Z",
    },
    selfUpdate: null,
    mounterEnable: null,
    restartableServices: [],
    restart: null,
    projectDir: "/opt/restow",
    database: databaseView(),
    serverTime: "2026-10-01T09:00:00.000Z",
    ...over,
  };
}

class ScriptedUpdater implements UpdaterClient {
  enabled = true;
  view: StateView | null = stateView();
  readonly moves: MoveRequest[] = [];
  readonly removals: string[] = [];
  readonly deletions: string[] = [];
  refuse: UpdaterRejectedError | null = null;
  dump: string | null = "PGDMP-the-whole-database";

  async state() {
    return this.view;
  }
  async schedule(): Promise<never> {
    throw new Error("not scripted");
  }
  async cancel(): Promise<never> {
    throw new Error("not scripted");
  }
  async acknowledge(): Promise<never> {
    throw new Error("not scripted");
  }
  async enableMounter(): Promise<never> {
    throw new Error("not scripted");
  }
  async restart(): Promise<never> {
    throw new Error("not scripted");
  }
  async checkDatabaseLocation(request: MoveRequest): Promise<MoveCheck> {
    return {
      ok: true,
      problems: [],
      targetDir: request.targetDir,
      filesystem: "xfs",
      freeBytes: 95 * GIB,
      totalBytes: 100 * GIB,
      dataBytes: 29 * GIB,
      requiredBytes: 32 * GIB,
      checkedAt: "2026-10-01T09:00:00.000Z",
    };
  }
  async moveDatabase(request: MoveRequest) {
    if (this.refuse) {
      throw this.refuse;
    }
    this.moves.push(request);
    return this.view as StateView;
  }
  async removeOldDatabaseCopy(id: string) {
    if (this.refuse) {
      throw this.refuse;
    }
    this.removals.push(id);
    return this.view as StateView;
  }
  async downloadDump(): Promise<Response | null> {
    if (this.dump === null) {
      return null;
    }
    return new Response(this.dump, {
      headers: { "content-length": String(this.dump.length), "x-updater-internal": "1" },
    });
  }
  async deleteDump(file: string) {
    if (this.refuse) {
      throw this.refuse;
    }
    this.deletions.push(file);
    return this.view as StateView;
  }
}

describe.skipIf(!testDatabaseAdminUrl)("Installation > Database against Postgres", () => {
  let owner: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let databaseModule: DatabaseModule;
  let diskWatchModule: DiskWatchModule;
  let serviceModule: ServiceModule;
  let stateModule: StateModule;
  let contoso: string;
  let updater: ScriptedUpdater;
  let repository: { path: string; freeBytes: number; totalBytes: number } | null;
  let since: Date;

  const auditRows = (action: string) =>
    owner
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, action), isNull(auditLog.tenantId), gte(auditLog.createdAt, since)),
      )
      .orderBy(asc(auditLog.createdAt));

  function build() {
    return new databaseModule.DatabaseService({
      db: providerDb,
      updater,
      repositoryDisk: async () => repository,
    });
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    providerDb = createDb(roles.providerUrl);
    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await owner
      .insert(tenants)
      .values({ providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" })
      .returning();
    contoso = tenant?.id ?? "";
    databaseModule = await import("./database.js");
    diskWatchModule = await import("./disk-watch.js");
    serviceModule = await import("./service.js");
    stateModule = await import("./state.js");
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await Promise.all([owner?.$client.end(), providerDb?.$client.end()]);
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  beforeEach(async () => {
    const [latest] = await owner
      .select({ createdAt: auditLog.createdAt })
      .from(auditLog)
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    since = new Date(Math.max(Date.now(), latest ? latest.createdAt.getTime() + 1 : 0));
    await owner.delete(reportDeliveries);
    await owner.delete(reportRules);
    await owner.delete(notifications);
    await owner.delete(settings);
    await owner.insert(settings).values({ singleton: true, operatingMode: "public" });
    updater = new ScriptedUpdater();
    repository = { path: "/data/chunks", freeBytes: 500 * GIB, totalBytes: 1000 * GIB };
  });

  describe("the view", () => {
    it("shows the location, the disks and whether they are low", async () => {
      const view = await build().view();
      expect(view).toMatchObject({
        updater: "ready",
        updateActive: false,
        location: { kind: "volume", source: "restow_pgdata" },
        movable: true,
        oldCopies: [{ id: "c-1" }],
        projectDir: "/opt/restow",
        disks: {
          // 4 of 38 GiB: below 5 GiB.
          database: {
            kind: "database",
            freeBytes: 4 * GIB,
            totalBytes: 38 * GIB,
            thresholdBytes: 5 * GIB,
            low: true,
          },
          repository: { kind: "repository", location: "/data/chunks", low: false },
        },
      });
    });

    it("says when the updater predates the database location, or is missing", async () => {
      updater.view = stateView({ database: null });
      expect((await build().view()).updater).toBe("unsupported");
      updater.view = null;
      const view = await build().view();
      expect(view.updater).toBe("unavailable");
      expect(view.disks.database).toBeNull();
      expect(view.disks.repository).not.toBeNull();
    });
  });

  describe("moving", () => {
    it("asks the updater and audits the request with the directory", async () => {
      await build().move("/mnt/volume-1/restow-db/", actor);
      expect(updater.moves).toEqual([
        {
          targetDir: "/mnt/volume-1/restow-db",
          requestedBy: { userId: "owner-1", label: "owner@provider.test", ip: "192.0.2.10" },
        },
      ]);
      const rows = await auditRows("database.move.requested");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor: "owner@provider.test",
        actorUserId: "owner-1",
        target: "/mnt/volume-1/restow-db",
        targetType: "database",
        ip: "192.0.2.10",
      });
    });

    it("refuses an unusable directory itself, without asking the updater", async () => {
      const error = await build()
        .move("/etc/restow", actor)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProblemError);
      expect((error as ProblemError).status).toBe(422);
      expect(updater.moves).toEqual([]);
    });

    it("passes the updater's problems on and audits nothing", async () => {
      updater.refuse = new UpdaterRejectedError(409, "blocked", {
        code: "blocked",
        message: "The database cannot be moved to this directory.",
        problems: [{ code: "same_filesystem", detail: "same" }],
      });
      const error = (await build()
        .move("/mnt/volume-1/restow-db", actor)
        .catch((caught: unknown) => caught)) as ProblemError;
      expect(error.status).toBe(409);
      expect(error.type).toBe("urn:restow:problem:database-move-refused");
      expect(error.extensions?.problems).toEqual([{ code: "same_filesystem", detail: "same" }]);
      expect(await auditRows("database.move.requested")).toEqual([]);
    });

    it("refuses when the updater cannot move databases", async () => {
      updater.view = stateView({ database: null });
      const error = (await build()
        .move("/mnt/volume-1/restow-db", actor)
        .catch((caught: unknown) => caught)) as ProblemError;
      expect(error.type).toBe("urn:restow:problem:database-move-unsupported");
    });

    it("audits the removal of an old copy with where it was", async () => {
      await build().removeOldCopy("c-1", actor);
      expect(updater.removals).toEqual(["c-1"]);
      const rows = await auditRows("database.old_copy.removal_requested");
      expect(rows[0]).toMatchObject({ target: "restow_pgdata", targetType: "database" });
    });
  });

  describe("the dumps", () => {
    function withDump() {
      updater.view = stateView({
        capabilities: {
          ...stateView().capabilities,
          dumps: [{ file: DUMP, bytes: 24, createdAt: "2026-09-30T10:00:00.000Z" }],
        },
      });
    }

    function ticketOf(url: string): string {
      return new URL(url, "https://restow.example.com").searchParams.get("ticket") ?? "";
    }

    it("audit a download before handing the stream through, with download headers only", async () => {
      withDump();
      const service = build();
      const link = await service.issueDumpTicket(DUMP, actor);
      expect(link.url.startsWith(`/api/v1/updates/dumps/${DUMP}?ticket=`)).toBe(true);
      // Issuing the link is not the download: nothing is audited yet.
      expect(await auditRows("update.dump.downloaded")).toEqual([]);
      const response = await service.downloadDump(DUMP, ticketOf(link.url), actor);
      const rows = await auditRows("update.dump.downloaded");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        target: DUMP,
        targetType: "dump",
        details: { file: DUMP, bytes: 24 },
      });
      expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${DUMP}"`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-updater-internal")).toBeNull();
      expect(await response.text()).toBe("PGDMP-the-whole-database");
    });

    it("take a ticket once, for its file and its person, within a minute", async () => {
      withDump();
      let now = Date.parse("2026-10-01T09:00:00.000Z");
      const service = new databaseModule.DatabaseService({
        db: providerDb,
        updater,
        repositoryDisk: async () => repository,
        now: () => now,
      });
      const refused = async (ticket: string | undefined, who = actor) => {
        const error = (await service
          .downloadDump(DUMP, ticket, who)
          .catch((caught: unknown) => caught)) as ProblemError;
        expect(error.type).toBe("urn:restow:problem:dump-ticket-invalid");
      };
      await refused(undefined);
      await refused("made-up");
      const first = ticketOf((await service.issueDumpTicket(DUMP, actor)).url);
      await refused(first, { ...actor, id: "someone-else" });
      // Used up by the attempt above.
      await refused(first);
      const late = ticketOf((await service.issueDumpTicket(DUMP, actor)).url);
      now += 61_000;
      await refused(late);
      const good = ticketOf((await service.issueDumpTicket(DUMP, actor)).url);
      await (await service.downloadDump(DUMP, good, actor)).text();
      await refused(good);
      expect(await auditRows("update.dump.downloaded")).toHaveLength(1);
    });

    it("answer 404 for a missing dump or a name that is not one, and audit nothing", async () => {
      for (const name of [DUMP, "../status.json", "secret"]) {
        const error = (await build()
          .issueDumpTicket(name, actor)
          .catch((caught: unknown) => caught)) as ProblemError;
        expect(error.status).toBe(404);
      }
      withDump();
      updater.dump = null;
      const service = build();
      const link = await service.issueDumpTicket(DUMP, actor);
      const error = (await service
        .downloadDump(DUMP, ticketOf(link.url), actor)
        .catch((caught: unknown) => caught)) as ProblemError;
      expect(error.status).toBe(404);
      expect(await auditRows("update.dump.downloaded")).toEqual([]);
    });

    it("audit a deletion; a protected dump is refused", async () => {
      await build().deleteDump(DUMP, actor);
      expect(updater.deletions).toEqual([DUMP]);
      expect(await auditRows("update.dump.deleted")).toHaveLength(1);
      updater.refuse = new UpdaterRejectedError(409, "blocked", {
        code: "blocked",
        message: "needed",
      });
      const error = (await build()
        .deleteDump(DUMP, actor)
        .catch((caught: unknown) => caught)) as ProblemError;
      expect(error.type).toBe("urn:restow:problem:dump-protected");
      expect(await auditRows("update.dump.deleted")).toHaveLength(1);
    });
  });

  describe("the updater's journal", () => {
    it("writes a move's outcome to the audit log and the bell", async () => {
      const event: JournalEvent = {
        id: "001790000000000-000001",
        at: "2026-10-01T09:30:00.000Z",
        action: "database.move.succeeded",
        runId: "m-1",
        actor: { userId: "owner-1", label: "owner@provider.test", ip: "192.0.2.10" },
        target: "/mnt/volume-1/restow-db/restow-postgres-20261001-090000",
        details: { status: "succeeded" },
      };
      updater.view = stateView({ events: [event] });
      const service = new serviceModule.UpdateService({
        db: providerDb,
        state: new stateModule.UpdateStateCache("0.4.0", undefined),
        updater,
      });
      await service.syncUpdater();
      await service.syncUpdater();
      const rows = await auditRows("database.move.succeeded");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ targetType: "database", target: event.target });
      const bell = await owner
        .select()
        .from(notifications)
        .where(eq(notifications.event, "database.move.succeeded"));
      expect(bell).toHaveLength(1);
      expect(bell[0]).toMatchObject({ tenantId: null, level: "info" });
    });
  });

  describe("the low disk space warning", () => {
    async function rule() {
      await owner.insert(reportRules).values({
        tenantId: contoso,
        name: "Disks",
        trigger: "event",
        events: ["installation.disk_low"],
        emailRecipients: ["ops@example.com"],
      });
    }

    function watch(now = new Date("2026-10-01T10:00:00.000Z")) {
      return new diskWatchModule.DiskWatch({ db: providerDb, service: build(), now: () => now });
    }

    const bell = () =>
      owner.select().from(notifications).where(eq(notifications.event, "installation.disk_low"));

    it("is raised once per episode, in the bell and in the rules that list it", async () => {
      await rule();
      // The database's disk is low (4 of 38 GiB); the repository is fine.
      expect(await watch().checkOnce()).toEqual({
        database: "raised",
        repository: "ok",
        system: "unknown",
      });
      expect(await bell()).toHaveLength(1);
      expect((await bell())[0]).toMatchObject({ tenantId: null, level: "warning" });
      const deliveries = await owner.select().from(reportDeliveries);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        event: "installation.disk_low",
        subjectKey: "disk:database",
        payload: { details: { disk: "database", freeBytes: 4 * GIB, totalBytes: 38 * GIB } },
      });

      // Still low: nothing new.
      expect((await watch().checkOnce()).database).toBe("low");
      expect(await bell()).toHaveLength(1);

      // Just above the line is still the same episode.
      updater.view = stateView({
        database: databaseView({
          usage: { ...USAGE, filesystemFreeBytes: 5.5 * GIB },
        }),
      });
      expect((await watch().checkOnce()).database).toBe("low");

      // Clearly recovered, then low again: a second warning.
      updater.view = stateView({
        database: databaseView({
          usage: { ...USAGE, filesystemFreeBytes: 20 * GIB },
        }),
      });
      expect((await watch().checkOnce()).database).toBe("recovered");
      updater.view = stateView();
      expect((await watch().checkOnce()).database).toBe("raised");
      expect(await bell()).toHaveLength(2);
      const [row] = await owner.select({ alerts: settings.diskAlerts }).from(settings);
      expect(row?.alerts.database).toMatchObject({ low: true, freeBytes: 4 * GIB });
    });

    it("watches the repository's disk without an updater", async () => {
      updater.view = null;
      repository = { path: "/data/chunks", freeBytes: 2 * GIB, totalBytes: 100 * GIB };
      expect(await watch().checkOnce()).toEqual({
        database: "unknown",
        repository: "raised",
        system: "unknown",
      });
      expect((await bell())[0]?.details).toMatchObject({
        disk: "repository",
        objectName: "/data/chunks",
      });
    });

    it("watches the system disk and keeps its free space once an hour (0.4.5)", async () => {
      updater.view = null;
      repository = null;
      let free = 30 * GIB;
      const at = (minutes: number) =>
        new Date(Date.parse("2026-10-02T10:00:00.000Z") + minutes * 60_000);
      const systemWatch = (now: Date) =>
        new diskWatchModule.DiskWatch({
          db: providerDb,
          service: build(),
          systemDisk: async () => ({ freeBytes: free, totalBytes: 100 * GIB }),
          now: () => now,
        });
      expect((await systemWatch(at(0)).checkOnce()).system).toBe("ok");
      free = 29 * GIB;
      await systemWatch(at(15)).checkOnce();
      free = 28 * GIB;
      await systemWatch(at(60)).checkOnce();
      const [row] = await owner.select({ alerts: settings.diskAlerts }).from(settings);
      expect(row?.alerts.system?.samples).toEqual([
        { at: at(0).toISOString(), freeBytes: 30 * GIB },
        { at: at(60).toISOString(), freeBytes: 28 * GIB },
      ]);
      expect(row?.alerts.system).toMatchObject({ freeBytes: 28 * GIB, totalBytes: 100 * GIB });
      // Low like any watched disk: the warning names the system disk.
      free = 2 * GIB;
      expect((await systemWatch(at(120)).checkOnce()).system).toBe("raised");
      const raised = (await bell()).find(
        (entry) => (entry.details as { disk?: string }).disk === "system",
      );
      expect(raised?.message).toContain("on the system disk of the server");
    });
  });
});
