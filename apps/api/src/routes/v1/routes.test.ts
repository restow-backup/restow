import type { AuditLogEntry, Database, User } from "@restow/db";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProtectionResult } from "../../features/directory/service.js";
import type { JobDto } from "../../features/jobs/dto.js";
import type { AuditEvent } from "../../lib/audit.js";
import { errorHandler, notFoundHandler } from "../../problem.js";
import { buildV1 } from "../v1.js";
import { createdCursorSchema, decodeCursor } from "./cursor.js";
import { featuresOn } from "./testing/features.js";
import { TENANT_ID, bearer, fakeRequireKey } from "./testing/keys.js";
import { scriptedDb } from "./testing/scripted-db.js";

/**
 * Route tests of the v1 surface: the real router, a scripted database, the
 * fake key gate, and the feature services replaced at their module boundary.
 * The counting rule is taken from the @restow/core source, so the test does
 * not depend on the package's build output.
 */

const mocks = vi.hoisted(() => ({
  setUserProtection: vi.fn(),
  createRestore: vi.fn(),
  startBackup: vi.fn(),
  findJob: vi.fn(),
}));

vi.mock("@restow/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...(await vi.importActual<Record<string, unknown>>(
    "../../../../../packages/core/src/usage/mailboxes.js",
  )),
}));
vi.mock("../../features/directory/service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setUserProtection: mocks.setUserProtection,
}));
vi.mock("../../features/restore/service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createRestore: mocks.createRestore,
}));
vi.mock("../../features/jobs/service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startBackup: mocks.startBackup,
  findJob: mocks.findJob,
}));

const NOW = new Date("2026-09-23T10:00:00.000Z");
const CLIENT_IP = "203.0.113.7";
const USER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const USER_B = "bbbbbbbb-2222-4222-8222-222222222222";
const USER_C = "cccccccc-3333-4333-8333-333333333333";
const MAILBOX = "dddddddd-4444-4444-8444-444444444444";
const DRIVE = "eeeeeeee-5555-4555-8555-555555555555";
const SNAPSHOT = "ffffffff-6666-4666-8666-666666666666";

const tenantRow = {
  id: TENANT_ID,
  name: "Contoso",
  slug: "contoso",
  status: "active",
  mailboxCap: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

/** A verification report as features/verify/verification-state.ts loads it. */
function reportFact(snapshotId: string, checkedAt: string) {
  return {
    id: "99999999-7777-4777-8777-777777777777",
    objectId: MAILBOX,
    snapshotId,
    kind: "verify",
    readiness: "green",
    checkedAt: new Date(checkedAt),
    jobId: null,
    origin: null,
    reasons: [],
    counts: null,
  };
}

/**
 * The directory page of GET /users: tenant, count, users, their objects, and
 * the newest snapshot and backup job per object, followed by the four
 * verification queries (`verification`).
 */
function usersScript(verification: unknown[][]): unknown[][] {
  return [
    [tenantRow],
    [{ n: 3 }],
    [
      directoryUser(USER_A, "ada@contoso.example", "2026-03-01T00:00:00.000Z"),
      directoryUser(USER_B, "bob@contoso.example", "2026-03-02T00:00:00.000Z"),
      directoryUser(USER_C, "cy@contoso.example", "2026-03-03T00:00:00.000Z"),
    ],
    [
      {
        id: MAILBOX,
        userId: USER_A,
        kind: "mailbox",
        status: "active",
        externalId: "ada@contoso.example",
        displayName: "Ada",
        sourceKind: "m365",
      },
      {
        id: DRIVE,
        userId: USER_A,
        kind: "onedrive",
        status: "active",
        externalId: "b!ada",
        displayName: "Ada's OneDrive",
        sourceKind: "m365",
      },
    ],
    // Newest snapshot and backup job per object.
    [
      {
        objectId: MAILBOX,
        id: SNAPSHOT,
        sequence: 4,
        completedAt: new Date("2026-09-22T02:00:00.000Z"),
        itemCount: 120,
        byteSize: 4096,
      },
    ],
    [],
    ...verification,
  ];
}

function directoryUser(id: string, email: string, createdAt: string, tenantId = TENANT_ID): User {
  return {
    id,
    tenantId,
    entraObjectId: `oid-${email}`,
    email,
    upn: email,
    displayName: email.split("@")[0] ?? null,
    mailAddresses: [email],
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

function setup(results: unknown[][]) {
  const script = scriptedDb(results);
  const audits: AuditEvent[] = [];
  const api = buildV1({
    // One scripted database for both pools: the script answers in call order.
    db: script.db,
    providerDb: script.db,
    requireKey: fakeRequireKey,
    requireFeature: featuresOn,
    audit: async (_db: unknown, event: AuditEvent) => {
      audits.push(event);
      return {} as AuditLogEntry;
    },
    version: {
      current: () => ({
        running: "1.4.0",
        commit: null,
        latest: null,
        updateAvailable: null,
        releaseUrl: null,
        updateCheck: "disabled",
        checkedAt: null,
        channel: "stable",
        latestTag: null,
        publishedAt: null,
        checkError: null,
        maintenance: null,
      }),
    },
    now: () => NOW,
  });
  const app = new Hono();
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  app.route("/api/v1", api.app);
  const request = (path: string, init: RequestInit & { key?: string } = {}) => {
    const { key = "rsk_tenant_full", headers, ...rest } = init;
    return app.request(`/api/v1${path}`, {
      ...rest,
      headers: {
        ...bearer(key),
        "x-forwarded-for": CLIENT_IP,
        ...(rest.body ? { "content-type": "application/json" } : {}),
        ...(headers as Record<string, string> | undefined),
      },
    });
  };
  return { script, audits, request, db: script.db as Database };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /users", () => {
  it("lists the directory with protection, mailbox count and readiness, and audits the read", async () => {
    const { request, audits, script } = setup(
      usersScript([
        // Newest completed snapshot, its newest check, the newest storage
        // finding and the newest check of any snapshot, per object.
        [
          {
            objectId: MAILBOX,
            id: SNAPSHOT,
            sequence: 4,
            completedAt: new Date("2026-09-22T02:00:00.000Z"),
          },
        ],
        [reportFact(SNAPSHOT, "2026-09-22T03:00:00.000Z")],
        [],
        [reportFact(SNAPSHOT, "2026-09-22T03:00:00.000Z")],
      ]),
    );

    const res = await request("/users?limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Record<string, unknown>[];
      next: string | null;
      total: number;
    };
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      id: USER_A,
      source: "m365",
      protectionStatus: "active",
      // The OneDrive next to the protected mailbox does not count twice.
      protectedMailboxes: 1,
      hasProtectedMailbox: true,
      lastBackupAt: "2026-09-22T02:00:00.000Z",
      // The OneDrive was never backed up, so the user is not "fine".
      recoveryReadiness: "red",
    });
    expect(body.items[0]?.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: MAILBOX,
          readiness: expect.objectContaining({
            state: "green",
            rating: "green",
            checkedAt: "2026-09-22T03:00:00.000Z",
          }),
        }),
      ]),
    );
    expect(body.items[1]).toMatchObject({
      id: USER_B,
      protectionStatus: "none",
      hasProtectedMailbox: false,
      recoveryReadiness: null,
      objects: [],
    });
    expect(decodeCursor(createdCursorSchema, body.next ?? undefined)).toEqual({
      at: "2026-03-02T00:00:00.000Z",
      id: USER_B,
    });
    expect(script.pending()).toBe(0);

    expect(audits).toEqual([
      {
        tenantId: TENANT_ID,
        actor: "api-key:key-tenant",
        actorUserId: null,
        action: "api.users.read",
        target: TENANT_ID,
        targetType: "tenant",
        ip: CLIENT_IP,
        details: { keyId: "key-tenant", count: 2 },
      },
    ]);
  });

  it("reads a backup taken after the last check as unverified, whatever the older backup scored", async () => {
    const OLDER_SNAPSHOT = "12121212-8888-4888-8888-888888888888";
    const { request, script } = setup(
      usersScript([
        [
          {
            objectId: MAILBOX,
            id: SNAPSHOT,
            sequence: 4,
            completedAt: new Date("2026-09-22T02:00:00.000Z"),
          },
        ],
        // No check has read snapshot 4 yet; the newest check rated the one before.
        [],
        [],
        [reportFact(OLDER_SNAPSHOT, "2026-09-21T03:00:00.000Z")],
      ]),
    );

    const res = await request("/users?limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { objects: Record<string, unknown>[] }[] };
    expect(body.items[0]?.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: MAILBOX,
          readiness: expect.objectContaining({
            state: "unverified",
            rating: null,
            checkedAt: null,
          }),
        }),
      ]),
    );
    expect(script.pending()).toBe(0);
  });

  it("refuses a key without the users scope before reading anything", async () => {
    const { request, script, audits } = setup([]);
    const res = await request("/users", { key: "rsk_tenant_status" });
    expect(res.status).toBe(403);
    expect(script.executed).toBe(0);
    expect(audits).toEqual([]);
  });
});

describe("GET /objects", () => {
  it("validates the filters", async () => {
    const { request, audits } = setup([[tenantRow]]);
    const res = await request("/objects?kind=calendar");
    expect(res.status).toBe(422);
    expect(audits).toEqual([]);
  });
});

describe("POST /users/:id/protection", () => {
  it("offboards a user through the directory service with the key as actor", async () => {
    const result: UserProtectionResult = {
      userId: USER_A,
      action: "exclude",
      objects: [
        {
          id: MAILBOX,
          sourceId: "11111111-2222-4333-8444-555555555555",
          sourceName: "Contoso M365",
          sourceKind: "m365",
          kind: "mailbox",
          origin: "directory_sync",
          status: "excluded",
          externalId: "ada@contoso.example",
          displayName: "Ada",
          userId: USER_A,
          email: "ada@contoso.example",
          upn: "ada@contoso.example",
          sharedOrBlocked: false,
          override: "exclude",
          notSelected: false,
          lastBackupAt: null,
          snapshotCount: 0,
          legalHold: false,
          latestBackupJob: null,
          readiness: null,
          warning: null,
          credential: null,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      ],
      sync: null,
    };
    mocks.setUserProtection.mockResolvedValue(result);
    const { request, db } = setup([[tenantRow]]);

    const res = await request(`/users/${USER_A}/protection`, {
      method: "POST",
      body: JSON.stringify({ action: "exclude", reason: "Offboarding ticket 4711" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: USER_A,
      action: "exclude",
      objects: [
        {
          id: MAILBOX,
          kind: "mailbox",
          externalId: "ada@contoso.example",
          displayName: "Ada",
          status: "excluded",
        },
      ],
      directorySync: { status: "not_needed", jobId: null, reason: null },
    });
    expect(mocks.setUserProtection).toHaveBeenCalledWith(
      db,
      TENANT_ID,
      USER_A,
      { action: "exclude", reason: "Offboarding ticket 4711" },
      { userId: null, label: "api-key:key-tenant", ip: CLIENT_IP, keyId: "key-tenant" },
    );
  });
});

describe("POST /restore", () => {
  it("insists on a reason, because a key always restores on the owner's behalf", async () => {
    const { request } = setup([[tenantRow]]);
    const res = await request("/restore", {
      method: "POST",
      body: JSON.stringify({ snapshotId: SNAPSHOT, target: { type: "original" } }),
    });
    expect(res.status).toBe(422);
    expect(mocks.createRestore).not.toHaveBeenCalled();
  });

  it("orders the whole snapshot when no selection is given", async () => {
    mocks.createRestore.mockResolvedValue({
      id: MAILBOX,
      jobId: DRIVE,
      status: "queued",
      impersonated: true,
      selection: { all: true, folders: 0, items: 0 },
    });
    const { request, db } = setup([[tenantRow]]);
    const res = await request("/restore", {
      method: "POST",
      body: JSON.stringify({
        snapshotId: SNAPSHOT,
        target: { type: "other", accountId: "restore-check@contoso.example" },
        reason: "Ticket 4711: mailbox restore check",
      }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ id: MAILBOX, jobId: DRIVE, impersonated: true });
    expect(mocks.createRestore).toHaveBeenCalledWith(
      db,
      TENANT_ID,
      { role: "tenant_admin", userId: null, email: "api-key:key-tenant", ip: CLIENT_IP },
      {
        snapshotId: SNAPSHOT,
        selection: [{ path: "" }],
        target: { type: "other", accountId: "restore-check@contoso.example" },
        mode: "rename",
        reason: "Ticket 4711: mailbox restore check",
        options: undefined,
      },
    );
  });
});

describe("jobs", () => {
  const queuedJob: JobDto = {
    id: DRIVE,
    queue: "backup",
    status: "queued",
    protectedObjectId: MAILBOX,
    object: null,
    scheduleId: null,
    backupJobId: null,
    trigger: "manual",
    full: false,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    failure: null,
    itemCauses: [],
    progress: null,
    phase: null,
    throttle: null,
    cancellable: true,
    retryable: false,
    checkIncomplete: false,
  };

  it("starts a backup of everything and reports what was skipped", async () => {
    mocks.startBackup.mockResolvedValue({
      queued: [queuedJob],
      skipped: [{ protectedObjectId: DRIVE, displayName: "Bob", reason: "source_pending" }],
    });
    const { request } = setup([[tenantRow]]);
    const res = await request("/jobs/backup", { method: "POST" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { queued: { type: string }[]; skipped: unknown[] };
    expect(body.queued).toEqual([
      expect.objectContaining({ id: DRIVE, type: "backup", status: "queued" }),
    ]);
    expect(body.skipped).toEqual([
      { protectedObjectId: DRIVE, displayName: "Bob", reason: "source_pending" },
    ]);
    expect(mocks.startBackup.mock.calls[0]?.[2]).toEqual({ full: false });
  });

  it("answers an event stream for an unknown job with a 404 problem", async () => {
    mocks.findJob.mockResolvedValue(null);
    const { request, audits } = setup([[tenantRow]]);
    const res = await request(`/jobs/${DRIVE}/events`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(audits).toEqual([]);
  });
});
