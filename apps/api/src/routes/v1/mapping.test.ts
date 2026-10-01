import type { ProtectedObject } from "@restow/db";
import { describe, expect, it } from "vitest";
import type { JobDetailDto, JobDto } from "../../features/jobs/dto.js";
import { JobChangeTracker } from "../../features/jobs/events.js";
import type { ReadinessOverviewDto } from "../../features/verify/service.js";
import type { DeliveryDto, WebhookWithSecretDto } from "../../features/webhooks/service.js";
import type { ProblemError } from "../../problem.js";
import { MAX_REPORT_DAYS, reportRange } from "./archive.js";
import { decodeCursor, idCursorSchema } from "./cursor.js";
import { NO_FACTS, countsForReadiness, readinessOf } from "./facts.js";
import { jobDetailSchema, jobSchema, jobStreamStep, toV1Job, toV1JobDetail } from "./jobs.js";
import { protectedObjectSchema, toProtectedObjectDto } from "./objects.js";
import { WHOLE_SNAPSHOT, restoreRequestSchema, toRestoreAccepted } from "./restore.js";
import { countByStatus, lastSuccessOf } from "./status.js";
import { pageOverview, verifyLatestSchema } from "./verify.js";
import {
  deliverySchema,
  toV1Delivery,
  toV1WebhookWithSecret,
  webhookWithSecretSchema,
} from "./webhooks.js";

const NOW = new Date("2026-09-23T10:00:00.000Z");
const OBJECT_ID = "3c1f0a52-7d0e-4c1b-9f3a-2b6c8d9e0f11";
const JOB_ID = "8a4e2f10-5b6c-4d7e-8f90-a1b2c3d4e5f6";

function job(overrides: Partial<JobDto> = {}): JobDto {
  return {
    id: JOB_ID,
    queue: "backup",
    status: "active",
    protectedObjectId: OBJECT_ID,
    object: {
      id: OBJECT_ID,
      sourceId: "5a1f0a52-7d0e-4c1b-9f3a-2b6c8d9e0f22",
      kind: "mailbox",
      displayName: "Ada Lovelace",
      externalId: "ada@contoso.example",
      status: "active",
    },
    scheduleId: null,
    trigger: "manual",
    full: false,
    createdAt: "2026-09-23T09:00:00.000Z",
    updatedAt: "2026-09-23T09:05:00.000Z",
    startedAt: "2026-09-23T09:00:10.000Z",
    completedAt: null,
    errorMessage: null,
    failure: null,
    itemCauses: [],
    progress: {
      total: 100,
      done: 40,
      failed: 1,
      bytes: 4096,
      etaSeconds: 90,
      updatedAt: "2026-09-23T09:05:00.000Z",
    },
    phase: { name: "mail", since: "2026-09-23T09:01:00.000Z" },
    throttle: {
      status: 429,
      waitMs: 5000,
      retryAfterMs: 5000,
      until: "2026-09-23T09:05:05.000Z",
      waits: 2,
      totalWaitMs: 8000,
    },
    cancellable: true,
    retryable: false,
    checkIncomplete: false,
    ...overrides,
  };
}

describe("jobs", () => {
  it("maps the feature's job onto the v1 shape, keeping throttling visible", () => {
    const mapped = toV1Job(job({ scheduleId: "schedule-1" }));
    expect(jobSchema.parse(mapped)).toEqual(mapped);
    expect(mapped).toMatchObject({
      type: "backup",
      scheduled: true,
      phase: "mail",
      durationMs: null,
      throttle: { status: 429, waits: 2 },
    });
    expect(mapped).not.toHaveProperty("cancellable");
  });

  it("reports the run time of a finished job", () => {
    const finished = toV1Job(
      job({
        status: "completed",
        completedAt: "2026-09-23T09:10:10.000Z",
        phase: null,
        throttle: null,
      }),
    );
    expect(finished.durationMs).toBe(10 * 60 * 1000);
  });

  it("carries failures, snapshot and result in the detail", () => {
    const detail: JobDetailDto = {
      ...job({ status: "completed", completedAt: "2026-09-23T09:10:10.000Z" }),
      failures: [
        {
          id: "f1",
          itemRef: "mail/Inbox/1.eml",
          reason: "too large",
          failure: null,
          attempts: 3,
          lastAttemptAt: null,
        },
      ],
      failureCount: 1,
      failureGroups: [],
      docsUrl: "https://docs.example.test/troubleshooting/",
      snapshot: {
        id: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
        sequence: 7,
        state: "completed",
        itemCount: 99,
        byteSize: 1234,
        startedAt: null,
        completedAt: "2026-09-23T09:10:00.000Z",
        jobId: JOB_ID,
      },
      result: null,
    };
    const mapped = toV1JobDetail(detail);
    expect(jobDetailSchema.parse(mapped)).toEqual(mapped);
    expect(mapped.failures).toEqual([
      {
        itemRef: "mail/Inbox/1.eml",
        reason: "too large",
        failure: null,
        attempts: 3,
        lastAttemptAt: null,
      },
    ]);
    expect(mapped.snapshot).not.toHaveProperty("jobId");
  });

  it("streams changes of one job and ends once it finished or vanished", () => {
    const tracker = new JobChangeTracker();
    const first = jobStreamStep(tracker, JOB_ID, job());
    expect(first.done).toBe(false);
    expect(first.messages.map((message) => message.event)).toEqual(["job"]);
    expect(jobStreamStep(tracker, JOB_ID, job()).messages).toEqual([]);

    const done = jobStreamStep(tracker, JOB_ID, job({ status: "failed", errorMessage: "boom" }));
    expect(done.done).toBe(true);
    expect(done.messages.map((message) => message.event)).toEqual(["job", "end"]);
    expect(JSON.parse(done.messages[0]?.data ?? "{}")).toMatchObject({
      type: "backup",
      status: "failed",
    });

    const gone = jobStreamStep(new JobChangeTracker(), JOB_ID, null);
    expect(gone).toMatchObject({ done: true, messages: [{ event: "end" }] });
  });
});

describe("protected objects", () => {
  const object: ProtectedObject = {
    id: OBJECT_ID,
    tenantId: "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f",
    sourceId: "11111111-2222-4333-8444-555555555555",
    userId: null,
    kind: "onedrive",
    origin: "directory_sync",
    status: "active",
    externalId: "b!drive",
    displayName: "Ada's OneDrive",
    activeSince: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    secretRef: null,
    credentialStatus: null,
    credentialCheckedAt: null,
    credentialError: null,
    credentialFailure: null,
  };
  const row = {
    object,
    source: { id: object.sourceId, name: "Contoso M365", kind: "m365" as const },
    email: null,
    upn: null,
  };

  it("rates an object without any backup as no_backup and without size", () => {
    const dto = toProtectedObjectDto(row, NO_FACTS, NOW);
    expect(protectedObjectSchema.parse(dto)).toEqual(dto);
    expect(dto).toMatchObject({
      byteSize: 0,
      lastSnapshot: null,
      readiness: { state: "no_backup" },
    });
  });

  it("never calls a backup fine that no test restore proved", () => {
    const dto = toProtectedObjectDto(
      row,
      {
        snapshot: { id: "s", sequence: 3, completedAt: NOW, itemCount: 10, byteSize: 2048 },
        job: {
          id: "j",
          status: "completed",
          createdAt: NOW,
          completedAt: NOW,
          errorMessage: null,
          failure: null,
        },
        verify: null,
      },
      NOW,
    );
    expect(dto).toMatchObject({ byteSize: 2048, readiness: { state: "unverified", rating: null } });
  });

  it("marks a rating older than the verify interval as overdue", () => {
    const readiness = readinessOf(
      {
        ...NO_FACTS,
        snapshot: { id: "s", sequence: 1, completedAt: NOW, itemCount: 1, byteSize: 1 },
        verify: {
          rating: "green",
          kind: "verify",
          checkedAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      },
      NOW,
    );
    expect(readiness).toMatchObject({ state: "green", overdue: true });
  });

  it("rates excluded objects not at all and orphaned ones while backups exist", () => {
    expect(countsForReadiness("excluded", true)).toBe(false);
    expect(countsForReadiness("orphaned", false)).toBe(false);
    expect(countsForReadiness("orphaned", true)).toBe(true);
    expect(countsForReadiness("active", false)).toBe(true);
  });
});

describe("verification report", () => {
  const objectEntry = (id: string): ReadinessOverviewDto["objects"][number] => ({
    object: {
      id,
      kind: "mailbox",
      displayName: id,
      externalId: `${id}@contoso.example`,
      status: "active",
      email: null,
      upn: null,
    },
    state: "green",
    readiness: "green",
    checkedAt: NOW.toISOString(),
    overdue: false,
    latestSnapshotAt: NOW.toISOString(),
    report: {
      id: `${id}0000-0000-4000-8000-000000000000`.slice(0, 36),
      kind: "verify",
      origin: "verify",
      reasons: [],
      counts: null,
    },
    running: null,
  });
  const ids = [
    "cccccccc-0000-4000-8000-000000000003",
    "aaaaaaaa-0000-4000-8000-000000000001",
    "bbbbbbbb-0000-4000-8000-000000000002",
  ];
  const overview: ReadinessOverviewDto = {
    summary: {
      total: 3,
      green: 3,
      yellow: 0,
      red: 0,
      unverified: 0,
      noBackup: 0,
      overdue: 0,
      overall: "green",
      lastCheckedAt: NOW.toISOString(),
      running: 0,
    },
    objects: ids.map(objectEntry),
    endpoints: [],
    storage: { state: "ok", latest: null, lastFullAt: null, running: null, lastFailure: null },
    schedules: { backup: null, verify: null, scrub: null },
  };

  it("pages the objects by id while the summary covers the whole tenant", () => {
    const first = pageOverview(overview, 2, null);
    expect(verifyLatestSchema.parse(first)).toEqual(first);
    expect(first.items.map((item) => item.protectedObjectId)).toEqual([ids[1], ids[2]]);
    expect(first.summary.total).toBe(3);

    const cursor = decodeCursor(idCursorSchema, first.next ?? undefined);
    const second = pageOverview(overview, 2, cursor?.id ?? null);
    expect(second.items.map((item) => item.protectedObjectId)).toEqual([ids[0]]);
    expect(second.next).toBeNull();
  });
});

describe("archive report period", () => {
  it("defaults to the last 30 days", () => {
    const range = reportRange({}, NOW);
    expect(range.to).toEqual(NOW);
    expect(NOW.getTime() - range.from.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("refuses an empty, reversed or overlong period", () => {
    const problem = (from: string, to: string) => {
      try {
        reportRange({ from, to }, NOW);
      } catch (error) {
        return error as ProblemError;
      }
      throw new Error("expected a problem");
    };
    expect(problem("2026-09-02T00:00:00Z", "2026-09-01T00:00:00Z").status).toBe(422);
    expect(problem("2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z").status).toBe(422);
    expect(problem("2024-01-01T00:00:00Z", "2026-01-01T00:00:00Z").extensions).toEqual({
      maxDays: MAX_REPORT_DAYS,
    });
  });
});

describe("status summary", () => {
  it("counts every status, including those nothing has", () => {
    expect(
      countByStatus([
        { status: "active", n: 4 },
        { status: "orphaned", n: 1 },
      ]),
    ).toEqual({
      total: 5,
      active: 4,
      excluded: 0,
      orphaned: 1,
    });
  });

  it("names the newest success per type, from dates or raw timestamps", () => {
    expect(
      lastSuccessOf(
        [
          { kind: "mailbox", at: new Date("2026-09-22T01:00:00.000Z") },
          { kind: "imap", at: "2026-09-21 03:00:00+00" },
        ],
        null,
      ),
    ).toEqual({
      mail: "2026-09-22T01:00:00.000Z",
      onedrive: null,
      imap: "2026-09-21T03:00:00.000Z",
      archive: null,
    });
  });
});

describe("restore", () => {
  it("requires a reason from integrations and restores the whole snapshot by default", () => {
    const base = { snapshotId: OBJECT_ID, target: { type: "original" } };
    expect(restoreRequestSchema.safeParse(base).success).toBe(false);
    const parsed = restoreRequestSchema.parse({ ...base, reason: "Ticket 4711" });
    expect(parsed.mode).toBe("rename");
    expect(parsed.selection).toBeUndefined();
    expect(WHOLE_SNAPSHOT).toEqual([{ path: "" }]);
  });

  it("answers with the request and the job to follow", () => {
    expect(
      toRestoreAccepted({
        id: OBJECT_ID,
        jobId: JOB_ID,
        status: "queued",
        impersonated: true,
        selection: { all: true, folders: 0, items: 0 },
      }),
    ).toEqual({
      id: OBJECT_ID,
      jobId: JOB_ID,
      status: "queued",
      impersonated: true,
      selection: { all: true, folders: 0, items: 0 },
    });
  });
});

describe("webhooks", () => {
  it("shows the secret with the signature scheme it is used for", () => {
    const created: WebhookWithSecretDto = {
      id: OBJECT_ID,
      name: "PSA",
      url: "https://psa.example/hooks/restow",
      events: ["job.failed"],
      active: true,
      secretConfigured: true,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      stats: { pending: 0, failedLast24h: 0, deliveredLast24h: 0, lastDelivery: null },
      secret: "whsec_example",
    };
    const mapped = toV1WebhookWithSecret(created);
    expect(webhookWithSecretSchema.parse(mapped)).toEqual(mapped);
    expect(mapped.signature).toEqual({ header: "X-Restow-Signature", format: "sha256=<hex>" });
  });

  it("maps a delivery with its parsed error", () => {
    const delivery: DeliveryDto = {
      id: JOB_ID,
      webhookId: OBJECT_ID,
      event: "job.failed",
      eventId: "evt-1",
      status: "pending",
      attempts: 2,
      maxAttempts: 8,
      lastError: { code: "http_error", httpStatus: 503, detail: "upstream unavailable" },
      nextAttemptAt: NOW.toISOString(),
      deliveredAt: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    const mapped = toV1Delivery(delivery);
    expect(deliverySchema.parse(mapped)).toEqual(mapped);
    expect(mapped.lastError).toEqual({
      code: "http_error",
      httpStatus: 503,
      detail: "upstream unavailable",
    });
  });
});
