/**
 * Postgres-backed tests of the calendar in the restore explorer: a calendar folder lists its
 * events by when they take place (newest first, or the coming ones first), not by subject, with
 * date, place and organiser; and the calendar view of a window lists solo appointments, all-day
 * events, the occurrences of a series (its stored exceptions in place) and the events of a
 * calendar other than the default one, reading the stored series from real encrypted content,
 * and audits the read.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_calendar_test` is recreated there and dropped after). Without it the suite is
 * skipped; docs/TESTING.md lists it under integration.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChunkIndex,
  type ChunkLocation,
  type ChunkRecord,
  ChunkWriter,
  InstallationDefaultResolver,
  Keyring,
  LocalStorageBackend,
  type PackRecord,
  type StorageTargets,
  type TenantKeyring,
} from "@restow/core";
import { auditLog, chunks, createDb, type Database, packs } from "@restow/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../../lib/tenant-context.js";
import type { Viewer } from "./access.js";
import { calendarQuerySchema, treeQuerySchema } from "./schemas.js";
import {
  createExplorerFixture,
  dropDatabase,
  type ExplorerFixture,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "./testing/explorer-fixture.js";
import { insertManifestRows } from "./testing/manifest-rows.js";

const DATABASE = "restow_api_calendar_test";
const CLIENT_IP = "198.51.100.11";

type Service = typeof import("./service.js");

/** A writable `ChunkIndex` for seeding real chunk content in these tests only. */
class TestChunkIndex implements ChunkIndex {
  constructor(
    private readonly db: Database,
    private readonly tenantId: string,
  ) {}

  async existing(storedIds: readonly string[]): Promise<Set<string>> {
    if (storedIds.length === 0) {
      return new Set();
    }
    const rows = await withTenantTx(this.db, this.tenantId, (tx) =>
      tx
        .select({ storedId: chunks.storedId })
        .from(chunks)
        .where(and(eq(chunks.tenantId, this.tenantId), inArray(chunks.storedId, [...storedIds]))),
    );
    return new Set(rows.map((row) => row.storedId));
  }

  async recordPack(pack: PackRecord, records: readonly ChunkRecord[]): Promise<void> {
    await withTenantTx(this.db, this.tenantId, async (tx) => {
      await tx.insert(packs).values({
        id: pack.id,
        tenantId: this.tenantId,
        path: pack.path,
        sha256: pack.sha256,
        size: pack.size,
      });
      if (records.length > 0) {
        await tx.insert(chunks).values(
          records.map((record) => ({
            tenantId: this.tenantId,
            storedId: record.storedId,
            length: record.length,
            packId: pack.id,
            offsetBytes: record.offset,
          })),
        );
      }
    });
  }

  async locate(): Promise<Map<string, ChunkLocation>> {
    throw new Error("TestChunkIndex is write-only; reads go through the real production path");
  }

  async addReferences(): Promise<void> {}
  async releaseReferences(): Promise<void> {}
}

/** Graph's UTC time as the backup records it in the metadata (no zone suffix). */
const graph = (iso: string) => `${iso.replace(/\.\d{3}Z$|Z$/, "")}.0000000`;

describe.skipIf(!testDatabaseAdminUrl)("the calendar in the explorer, against Postgres", () => {
  let db: Database;
  let f: ExplorerFixture;
  let service: Service;
  let keys: TenantKeyring;
  let storageDir: string;
  let seriesId: string;
  const reader = (viewer: Viewer) => ({ ...viewer, ip: CLIENT_IP });
  const tree = (query: Record<string, string>) => treeQuerySchema.parse(query);
  const window = (query: Record<string, string>) => calendarQuerySchema.parse(query);

  async function storeContent(bytes: Buffer): Promise<{ chunkRefs: string[]; size: number }> {
    const storage: StorageTargets = { primary: new LocalStorageBackend(storageDir), copies: [] };
    const writer = new ChunkWriter({
      tenantId: f.tenantId,
      storage,
      keys,
      index: new TestChunkIndex(db, f.tenantId),
    });
    const written = await writer.write(bytes);
    await writer.close();
    return { chunkRefs: written.chunks, size: written.size };
  }

  /** One event of Bob's mailbox, as the calendar phase stores it. */
  async function insertEvent(input: {
    calendar: string;
    subject: string;
    start: string;
    end: string;
    type?: string;
    isAllDay?: boolean;
    location?: string;
    organizer?: string;
    recurrenceEnd?: string;
    deleted?: boolean;
    payload?: unknown;
  }): Promise<string> {
    const id = randomUUID();
    const stored = input.payload
      ? await storeContent(Buffer.from(JSON.stringify(input.payload), "utf8"))
      : null;
    const name = `${input.subject}.${id.replace(/-/g, "").slice(0, 16)}.json`;
    await insertManifestRows(db, [
      {
        id,
        tenantId: f.tenantId,
        snapshotId: f.bobSnapshot,
        protectedObjectId: f.bobMailbox,
        kind: "event",
        path: `calendar/${input.calendar}/${name}`,
        name,
        parentPath: `calendar/${input.calendar}`,
        size: stored?.size ?? 100,
        chunkRefs: stored?.chunkRefs ?? [`chunk-${id}`],
        itemId: `evt-${id}`,
        deleted: input.deleted ?? false,
        metadata: {
          subject: input.subject,
          eventType: input.type ?? "singleInstance",
          start: graph(input.start),
          end: graph(input.end),
          isAllDay: String(input.isAllDay === true),
          isCancelled: "false",
          organizer: input.organizer ?? "bob@contoso.test",
          location: input.location ?? "",
          calendarName: input.calendar,
          isDefaultCalendar: String(input.calendar === "Calendar"),
          recurrenceEnd: input.recurrenceEnd ?? "",
          exceptionCount: "0",
          format: "json",
        },
      },
    ]);
    return id;
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    process.env.DATABASE_URL = url;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.STORAGE_TARGET = "local";
    storageDir = await mkdtemp(join(tmpdir(), "restow-calendar-test-"));
    process.env.STORAGE_LOCAL_PATH = storageDir;

    db = createDb(url);
    f = await createExplorerFixture(db);
    const secrets = await import("../../lib/secrets.js");
    (await import("../../lib/installation-default.js")).setInstallationDefaultResolver(
      new InstallationDefaultResolver({ ttlMs: 0 }),
    );
    await withTenantTx(db, f.tenantId, (tx) => secrets.createTenantKey(tx, f.tenantId));
    const dek = await withTenantTx(db, f.tenantId, (tx) => secrets.loadTenantDek(tx, f.tenantId));
    keys = new Keyring(f.tenantId, [dek]);
    service = await import("./service.js");

    // A solo appointment, an all-day event, an old one, a deleted one and a weekly series with
    // one moved occurrence in the default calendar; a lunch in a calendar of its own.
    await insertEvent({
      calendar: "Calendar",
      subject: "Dentist",
      start: "2026-09-10T08:00:00Z",
      end: "2026-09-10T09:00:00Z",
      location: "Praxis Dr. Weber",
    });
    await insertEvent({
      calendar: "Calendar",
      subject: "Holiday",
      start: "2026-09-15T00:00:00Z",
      end: "2026-09-16T00:00:00Z",
      isAllDay: true,
    });
    await insertEvent({
      calendar: "Calendar",
      subject: "Aardvark",
      start: "2025-01-01T08:00:00Z",
      end: "2025-01-01T09:00:00Z",
    });
    await insertEvent({
      calendar: "Calendar",
      subject: "Cancelled long ago",
      start: "2026-09-11T08:00:00Z",
      end: "2026-09-11T09:00:00Z",
      deleted: true,
    });
    const master = {
      id: "evt-master",
      type: "seriesMaster",
      subject: "Weekly sync",
      isAllDay: false,
      start: { dateTime: "2026-01-05T10:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-01-05T10:30:00.0000000", timeZone: "UTC" },
      originalStartTimeZone: "UTC",
      location: { displayName: "Room 1" },
      recurrence: {
        pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday"] },
        range: { type: "endDate", startDate: "2026-01-05", endDate: "2026-12-28" },
      },
    };
    seriesId = await insertEvent({
      calendar: "Calendar",
      subject: "Weekly sync",
      type: "seriesMaster",
      start: "2026-01-05T10:00:00Z",
      end: "2026-01-05T10:30:00Z",
      recurrenceEnd: "2026-12-28",
      payload: {
        event: master,
        exceptions: [
          {
            id: "evt-exc-1",
            type: "exception",
            subject: "Weekly sync (moved)",
            originalStart: "2026-09-14T10:00:00Z",
            start: { dateTime: "2026-09-14T14:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-09-14T14:30:00.0000000", timeZone: "UTC" },
          },
        ],
      },
    });
    // A series that ended before the window is never opened (its content is not even stored).
    await insertEvent({
      calendar: "Calendar",
      subject: "Old series",
      type: "seriesMaster",
      start: "2025-01-06T10:00:00Z",
      end: "2025-01-06T10:30:00Z",
      recurrenceEnd: "2025-03-31",
    });
    await insertEvent({
      calendar: "Team",
      subject: "Team lunch",
      start: "2026-09-20T11:00:00Z",
      end: "2026-09-20T12:00:00Z",
      organizer: "carol@contoso.test",
    });
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await shared.db.$client.end();
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await rm(storageDir, { recursive: true, force: true });
  });

  describe("the list of a calendar", () => {
    it("lists events by when they start, newest first, with place and organiser", async () => {
      const listed = await service.listTree(
        db,
        f.tenantId,
        reader(f.admin),
        f.bobSnapshot,
        tree({ path: "calendar/Calendar" }),
      );
      expect(listed.entries.map((entry) => entry.event?.subject)).toEqual([
        "Holiday",
        // Deleted at the source by the time of the restore point: listed, marked deleted.
        "Cancelled long ago",
        "Dentist",
        "Weekly sync",
        "Old series",
        "Aardvark",
      ]);
      const dentist = listed.entries.find((entry) => entry.event?.subject === "Dentist");
      expect(dentist?.event).toMatchObject({
        start: "2026-09-10T08:00:00.000Z",
        end: "2026-09-10T09:00:00.000Z",
        location: "Praxis Dr. Weber",
        organizer: "bob@contoso.test",
        calendarName: "Calendar",
        recurring: false,
      });
      expect(
        listed.entries.find((entry) => entry.event?.subject === "Holiday")?.event?.isAllDay,
      ).toBe(true);
      expect(
        listed.entries.find((entry) => entry.event?.subject === "Weekly sync")?.event,
      ).toMatchObject({ recurring: true, recurrenceEnd: "2026-12-28" });
    });

    it("lists the coming events first, soonest first, then the past ones newest first", async () => {
      const day = 86_400_000;
      const soon = new Date(Date.now() + 2 * day).toISOString();
      const later = new Date(Date.now() + 10 * day).toISOString();
      const past = new Date(Date.now() - 5 * day).toISOString();
      for (const [subject, start] of [
        ["Later", later],
        ["Past", past],
        ["Soon", soon],
      ] as const) {
        await insertEvent({
          calendar: "Upcoming",
          subject,
          start,
          end: new Date(Date.parse(start) + 3_600_000).toISOString(),
        });
      }
      const subjects = async (sort: string) =>
        (
          await service.listTree(
            db,
            f.tenantId,
            reader(f.admin),
            f.bobSnapshot,
            tree({ path: "calendar/Upcoming", sort }),
          )
        ).entries.map((entry) => entry.event?.subject);
      expect(await subjects("upcoming")).toEqual(["Soon", "Later", "Past"]);
      expect(await subjects("date")).toEqual(["Later", "Soon", "Past"]);
      expect(await subjects("name")).toEqual(["Later", "Past", "Soon"]);
    });

    it("shows every calendar of the mailbox, not only the default one", async () => {
      const calendars = await service.listTree(
        db,
        f.tenantId,
        reader(f.admin),
        f.bobSnapshot,
        tree({ path: "calendar" }),
      );
      expect(calendars.entries.map((entry) => entry.name)).toEqual([
        "Calendar",
        "Team",
        "Upcoming",
      ]);
    });
  });

  describe("the calendar view", () => {
    it("lists solo, all-day and series events of every calendar in the window, the moved occurrence where it went", async () => {
      const view = await service.calendarView(
        db,
        f.tenantId,
        reader(f.admin),
        f.bobSnapshot,
        window({ path: "calendar", from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" }),
      );
      expect(view.occurrences.map((o) => [o.start, o.subject, o.kind, o.calendarName])).toEqual([
        ["2026-09-07T10:00:00.000Z", "Weekly sync", "occurrence", "Calendar"],
        ["2026-09-10T08:00:00.000Z", "Dentist", "single", "Calendar"],
        ["2026-09-14T14:00:00.000Z", "Weekly sync (moved)", "exception", "Calendar"],
        ["2026-09-15T00:00:00.000Z", "Holiday", "single", "Calendar"],
        ["2026-09-20T11:00:00.000Z", "Team lunch", "single", "Team"],
        ["2026-09-21T10:00:00.000Z", "Weekly sync", "occurrence", "Calendar"],
        ["2026-09-28T10:00:00.000Z", "Weekly sync", "occurrence", "Calendar"],
      ]);
      const sync = view.occurrences[0];
      expect(sync).toMatchObject({ entryId: seriesId, location: "Room 1", isAllDay: false });
      expect(view.occurrences[3]?.isAllDay).toBe(true);
      expect(view).toMatchObject({ truncated: false, unexpandedSeries: 0 });

      const audit = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, f.tenantId),
            eq(auditLog.action, service.SNAPSHOT_AUDIT_ACTIONS.calendarRead),
          ),
        )
        .orderBy(desc(auditLog.createdAt));
      expect(audit[0]).toMatchObject({
        target: f.bobSnapshot,
        targetType: "snapshot",
        onBehalfOf: "bob@contoso.test",
        ip: CLIENT_IP,
      });
      expect(audit[0]?.details).toMatchObject({
        path: "calendar",
        occurrences: 7,
        openedSeries: 1,
      });
    });

    it("keeps to one calendar, and to one series", async () => {
      const team = await service.calendarView(
        db,
        f.tenantId,
        reader(f.admin),
        f.bobSnapshot,
        window({ path: "calendar/Team", from: "2026-01-01T00:00:00Z", to: "2027-01-01T00:00:00Z" }),
      );
      expect(team.occurrences.map((o) => o.subject)).toEqual(["Team lunch"]);

      const series = await service.calendarView(
        db,
        f.tenantId,
        reader(f.admin),
        f.bobSnapshot,
        window({
          path: "calendar/Calendar",
          entryId: seriesId,
          from: "2026-01-01T00:00:00Z",
          to: "2027-01-01T00:00:00Z",
        }),
      );
      // Every Monday from 5 January to 28 December 2026: 52 occurrences, one of them moved.
      expect(series.occurrences).toHaveLength(52);
      expect(series.occurrences.filter((o) => o.kind === "exception")).toHaveLength(1);
      expect(series.occurrences.at(-1)?.start).toBe("2026-12-28T10:00:00.000Z");
    });

    it("refuses a window that is backwards or too long", () => {
      expect(() => window({ from: "2026-10-01T00:00:00Z", to: "2026-09-01T00:00:00Z" })).toThrow();
      expect(() => window({ from: "2000-01-01T00:00:00Z", to: "2026-09-01T00:00:00Z" })).toThrow();
    });

    it("shows a person only their own calendar", async () => {
      await expect(
        service.calendarView(
          db,
          f.tenantId,
          reader(f.anna),
          f.bobSnapshot,
          window({ from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" }),
        ),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
