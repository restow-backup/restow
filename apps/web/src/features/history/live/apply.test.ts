import { type InfiniteData, QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type BackupJob, type BackupJobList, backupJobKeys } from "@/features/backup-jobs/api";
import {
  type EndpointDetail,
  type RunSummary as EndpointRunSummary,
  type EndpointSummary,
  endpointKeys,
} from "@/features/endpoints/api";
import { type BackupTarget, type Job, jobKeys } from "@/features/jobs/api";

import {
  type BackupJobLive,
  type HistoryPage,
  type LiveSnapshot,
  type MachineLive,
  type Run,
  type RunDetail,
  historyKeys,
} from "../api";
import {
  LIVE_KEEP_MS,
  type LiveContext,
  type LiveRuns,
  REFETCH_DELAY_MS,
  applyEvent,
  applyRun,
  createRefetcher,
  endpointStatusOf,
  mergeLiveRuns,
  newKnown,
  placeRun,
} from "./apply";

const TENANT = "tenant-1";

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    source: "mail",
    kind: "backup",
    type: "backup",
    state: "running",
    checkIncomplete: false,
    attempt: null,
    subject: null,
    job: null,
    trigger: "scheduled",
    full: false,
    createdAt: "2026-10-02T10:00:00.000Z",
    startedAt: "2026-10-02T10:00:01.000Z",
    finishedAt: null,
    updatedAt: "2026-10-02T10:00:02.000Z",
    progress: null,
    throughput: null,
    samples: null,
    phase: null,
    throttle: null,
    errorMessage: null,
    failure: null,
    cancellable: true,
    ...overrides,
  };
}

function pages(...items: Run[][]): InfiniteData<HistoryPage, string | null> {
  return {
    pageParams: items.map((_, index) => (index === 0 ? null : `cursor-${index}`)),
    pages: items.map((page, index) => ({
      items: page,
      next: index < items.length - 1 ? `cursor-${index + 1}` : null,
    })),
  };
}

function job(overrides: Partial<BackupJob> = {}): BackupJob {
  return {
    id: "job-1",
    kind: "mail",
    name: "Mail backup",
    enabled: true,
    origin: "user",
    scopeMode: "selected",
    schedule: { kind: "interval", intervalMinutes: 480, timeZone: "Europe/Berlin" },
    verifySchedule: null,
    repository: { id: null, name: null, kind: "installation_default", role: null, status: null },
    retention: { policyId: null, policyName: null, keep: null },
    scope: { count: 2, byKind: { mailbox: 2 }, overrides: 0 },
    lastRun: { at: null, failed: 0, partial: 0, running: 0, queued: 0, runId: null },
    nextRunAt: "2026-10-02T12:00:00.000Z",
    restoreCheck: {
      passed: 0,
      warning: 0,
      failed: 0,
      unverified: 0,
      noBackup: 2,
      total: 2,
      checkedAt: null,
    },
    state: "ok",
    settings: {},
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

function live(overrides: Partial<BackupJobLive> = {}): BackupJobLive {
  const base = job();
  return {
    id: base.id,
    kind: base.kind,
    enabled: base.enabled,
    state: base.state,
    scope: base.scope,
    lastRun: base.lastRun,
    nextRunAt: base.nextRunAt,
    restoreCheck: base.restoreCheck,
    updatedAt: base.updatedAt,
    ...overrides,
  };
}

function machine(overrides: Partial<EndpointSummary> = {}): EndpointSummary {
  return {
    id: "m1",
    hostname: "fs-bergisch",
    displayName: null,
    os: "linux",
    arch: "amd64",
    profile: "server",
    agentVersion: "0.1.0",
    osVersion: null,
    status: "active",
    connection: "online",
    agentState: "idle",
    lastSeenAt: "2026-10-02T09:59:00.000Z",
    lastBackupAt: null,
    lastSuccessAt: null,
    nextRunAt: null,
    readiness: {
      state: "unverified",
      checkedAt: null,
      overdue: false,
      basis: null,
      latestSnapshotId: null,
    },
    latestRun: null,
    attention: [],
    job: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function endpointRun(overrides: Partial<EndpointRunSummary> = {}): EndpointRunSummary {
  return {
    id: "run-e1",
    kind: "backup",
    status: "running",
    startedAt: "2026-10-02T10:00:00.000Z",
    finishedAt: null,
    snapshotId: null,
    errorCount: 0,
    interruptedOnly: false,
    checkIncomplete: false,
    failure: null,
    filesNew: null,
    dataAdded: null,
    totalBytesProcessed: null,
    progress: { filesDone: 1, bytesDone: 10, updatedAt: "2026-10-02T10:00:01.000Z" },
    ...overrides,
  };
}

let client: QueryClient;
let refetched: string[];
let context: LiveContext;

beforeEach(() => {
  client = new QueryClient();
  refetched = [];
  context = {
    client,
    tenantId: TENANT,
    refetch: (key) => refetched.push(JSON.stringify(key)),
    known: newKnown(),
    now: () => Date.parse("2026-10-02T10:05:00.000Z"),
  };
});

const refetchedKey = (key: readonly unknown[]) => refetched.includes(JSON.stringify(key));

describe("the live map of runs", () => {
  it("holds the runs the channel follows, the newest state of each", () => {
    applyRun(context, run({ id: "a", state: "running" }));
    applyRun(context, run({ id: "b" }));
    applyRun(context, run({ id: "a", state: "succeeded", finishedAt: "2026-10-02T10:04:00.000Z" }));
    const map = client.getQueryData<LiveRuns>(historyKeys.live(TENANT));
    expect(Object.keys(map ?? {}).sort()).toEqual(["a", "b"]);
    expect(map?.a?.state).toBe("succeeded");
  });

  it("drops a run that ended long ago, keeps one that ended lately and any that still runs", () => {
    const now = Date.parse("2026-10-02T12:00:00.000Z");
    const ended = (id: string, minutesAgo: number) =>
      run({
        id,
        state: "succeeded",
        finishedAt: new Date(now - minutesAgo * 60_000).toISOString(),
      });
    const map = mergeLiveRuns(
      { old: ended("old", 30), recent: ended("recent", 1), going: run({ id: "going" }) },
      [],
      now,
    );
    expect(Object.keys(map).sort()).toEqual(["going", "recent"]);
    expect(LIVE_KEEP_MS).toBeGreaterThan(60_000);
  });

  it("starts over with a snapshot: what is no longer in the window is gone", () => {
    applyRun(context, run({ id: "stale" }));
    const snapshot: LiveSnapshot = {
      runs: [run({ id: "fresh" })],
      definitions: [],
      machines: [],
      serverTime: "2026-10-02T10:05:00.000Z",
    };
    applyEvent(context, { event: "snapshot", data: JSON.stringify(snapshot), id: null });
    expect(Object.keys(client.getQueryData<LiveRuns>(historyKeys.live(TENANT)) ?? {})).toEqual([
      "fresh",
    ]);
  });
});

describe("History lists", () => {
  const listKey = (type: string | null = null, jobId: string | null = null) =>
    historyKeys.list(TENANT, { type: type as never, job: jobId });

  it("replaces the row of a run that moved, and keeps the others", () => {
    client.setQueryData(listKey(), pages([run({ id: "a" }), run({ id: "b" })]));
    applyRun(context, run({ id: "a", state: "succeeded", finishedAt: "2026-10-02T10:04:00.000Z" }));
    const data = client.getQueryData<InfiniteData<HistoryPage>>(listKey());
    expect(data?.pages[0]?.items.map((item) => [item.id, item.state])).toEqual([
      ["a", "succeeded"],
      ["b", "running"],
    ]);
    expect(refetched).not.toContain(JSON.stringify(listKey()));
  });

  it("replaces a row on a later page as well", () => {
    client.setQueryData(
      listKey(),
      pages([run({ id: "a" })], [run({ id: "z", createdAt: "2026-10-01T00:00:00.000Z" })]),
    );
    applyRun(context, run({ id: "z", state: "failed", createdAt: "2026-10-01T00:00:00.000Z" }));
    const data = client.getQueryData<InfiniteData<HistoryPage>>(listKey());
    expect(data?.pages[1]?.items[0]?.state).toBe("failed");
  });

  it("puts a new run at the head of the list it belongs to, without asking the server", () => {
    client.setQueryData(
      listKey(),
      pages([run({ id: "a", createdAt: "2026-10-02T09:00:00.000Z" })]),
    );
    applyRun(context, run({ id: "new", createdAt: "2026-10-02T10:00:00.000Z" }));
    const data = client.getQueryData<InfiniteData<HistoryPage>>(listKey());
    expect(data?.pages[0]?.items.map((item) => item.id)).toEqual(["new", "a"]);
    expect(refetched).toEqual([]);
  });

  it("leaves a list of another tab alone", () => {
    client.setQueryData(
      listKey("restore"),
      pages([run({ id: "a", kind: "restore", type: "restore" })]),
    );
    applyRun(context, run({ id: "new", kind: "backup" }));
    const data = client.getQueryData<InfiniteData<HistoryPage>>(listKey("restore"));
    expect(data?.pages[0]?.items.map((item) => item.id)).toEqual(["a"]);
    expect(refetched).toEqual([]);
  });

  it("asks the server when a run belongs somewhere in the list but not at its head", () => {
    client.setQueryData(
      listKey(),
      pages([run({ id: "a", createdAt: "2026-10-02T10:30:00.000Z" })]),
    );
    applyRun(context, run({ id: "older", createdAt: "2026-10-02T08:00:00.000Z" }));
    expect(refetched).toContain(JSON.stringify(listKey()));
  });

  it("asks the server about a list filtered by a job when the run does not say which job it is for", () => {
    const key = listKey(null, "job-1");
    client.setQueryData(key, pages([run({ id: "a" })]));
    applyRun(context, run({ id: "check", kind: "restore_check", type: "verify", job: null }));
    expect(refetched).toContain(JSON.stringify(key));
    refetched.length = 0;
    applyRun(context, run({ id: "mine", job: { id: "job-1", name: "Mail backup" } }));
    expect(refetched).not.toContain(JSON.stringify(key));
    expect(client.getQueryData<InfiniteData<HistoryPage>>(key)?.pages[0]?.items[0]?.id).toBe(
      "mine",
    );
  });

  it("does nothing to a list that was never loaded", () => {
    applyRun(context, run({ id: "a" }));
    expect(client.getQueryData(listKey())).toBeUndefined();
    expect(refetched).toEqual([]);
  });

  it("places a run by pure function: found, inserted at the head, or neither", () => {
    const data = pages([run({ id: "a", createdAt: "2026-10-02T10:00:00.000Z" })]);
    expect(placeRun(data, run({ id: "a", state: "failed" })).found).toBe(true);
    expect(placeRun(data, run({ id: "n", createdAt: "2026-10-02T11:00:00.000Z" })).inserted).toBe(
      true,
    );
    const neither = placeRun(data, run({ id: "o", createdAt: "2026-10-02T08:00:00.000Z" }));
    expect(neither).toMatchObject({ found: false, inserted: false });
    expect(neither.data).toBe(data);
    expect(placeRun(undefined, run())).toEqual({ data: undefined, found: false, inserted: false });
  });
});

describe("the detail of a run", () => {
  it("takes the live fields and keeps the rest until the run ends", () => {
    const detail = {
      ...run({ id: "a" }),
      objects: [{ x: 1 }],
      events: [],
      summary: null,
    } as unknown as RunDetail;
    client.setQueryData(historyKeys.detail(TENANT, "a"), detail);
    applyRun(context, run({ id: "a", updatedAt: "2026-10-02T10:00:09.000Z" }));
    const after = client.getQueryData<RunDetail>(historyKeys.detail(TENANT, "a"));
    expect(after?.updatedAt).toBe("2026-10-02T10:00:09.000Z");
    expect(after?.objects).toEqual([{ x: 1 }]);
    expect(refetchedKey(historyKeys.detail(TENANT, "a"))).toBe(false);
  });

  it("is read again when the run ends, with the overview and the readiness", () => {
    applyRun(context, run({ id: "a", state: "running" }));
    expect(refetched).toEqual([]);
    applyRun(context, run({ id: "a", state: "succeeded", finishedAt: "2026-10-02T10:04:00.000Z" }));
    expect(refetchedKey(historyKeys.detail(TENANT, "a"))).toBe(true);
    expect(refetched.some((key) => key.includes('"dashboard"'))).toBe(true);
    expect(refetched.some((key) => key.includes('"verify"'))).toBe(true);
    // Only the first time it is seen to end.
    refetched.length = 0;
    applyRun(context, run({ id: "a", state: "succeeded", finishedAt: "2026-10-02T10:04:00.000Z" }));
    expect(refetched).toEqual([]);
  });

  it("treats a run first seen already finished as news of its end", () => {
    applyRun(
      context,
      run({ id: "quick", state: "failed", finishedAt: "2026-10-02T10:04:00.000Z" }),
    );
    expect(refetchedKey(historyKeys.detail(TENANT, "quick"))).toBe(true);
  });
});

describe("the machine an agent run belongs to", () => {
  const agent = (overrides: Partial<Run> = {}) =>
    run({
      id: "run-e1",
      source: "endpoint",
      type: "backup",
      subject: { kind: "server", id: "m1", name: "fs-bergisch", detail: "linux" },
      progress: {
        percent: 40,
        itemsDone: 400,
        itemsTotal: 1000,
        itemsFailed: 0,
        bytesProcessed: 4000,
        bytesTransferred: 100,
        bytesNew: null,
        bytesTotal: 10_000,
        etaSeconds: 30,
        currentPath: "/srv/x",
        updatedAt: "2026-10-02T10:00:05.000Z",
      },
      ...overrides,
    });

  it("moves the progress of the machine's latest run in its list and detail, without a request", () => {
    client.setQueryData(endpointKeys.list(TENANT, undefined), [
      machine({ latestRun: endpointRun() }),
    ]);
    client.setQueryData(endpointKeys.detail(TENANT, "m1"), {
      ...machine({ latestRun: endpointRun() }),
      runs: [endpointRun()],
    } as unknown as EndpointDetail);
    applyRun(context, agent());
    const list = client.getQueryData<EndpointSummary[]>(endpointKeys.list(TENANT, undefined));
    expect(list?.[0]?.latestRun?.progress).toMatchObject({
      filesDone: 400,
      bytesDone: 4000,
      totalFiles: 1000,
      totalBytes: 10_000,
      currentPath: "/srv/x",
    });
    const detail = client.getQueryData<EndpointDetail>(endpointKeys.detail(TENANT, "m1"));
    expect(detail?.runs[0]?.progress?.bytesDone).toBe(4000);
    expect(detail?.latestRun?.progress?.bytesDone).toBe(4000);
    expect(refetched).toEqual([]);
  });

  it("shows the end of the run: the state, the finish, no progress", () => {
    client.setQueryData(endpointKeys.list(TENANT, undefined), [
      machine({ latestRun: endpointRun() }),
    ]);
    applyRun(context, agent({ state: "partial", finishedAt: "2026-10-02T10:04:00.000Z" }));
    const list = client.getQueryData<EndpointSummary[]>(endpointKeys.list(TENANT, undefined));
    expect(list?.[0]?.latestRun).toMatchObject({
      status: "partial",
      finishedAt: "2026-10-02T10:04:00.000Z",
      progress: null,
    });
  });

  it("refetches the machine's pages when a new run starts, since only the server derives their numbers", () => {
    client.setQueryData(endpointKeys.list(TENANT, undefined), [
      machine({
        latestRun: endpointRun({
          id: "old",
          startedAt: "2026-10-01T10:00:00.000Z",
          status: "succeeded",
        }),
      }),
    ]);
    applyRun(context, agent());
    expect(refetchedKey(endpointKeys.all(TENANT))).toBe(true);
  });

  it("maps the live states onto the statuses of the machine pages", () => {
    expect(endpointStatusOf("running")).toBe("running");
    expect(endpointStatusOf("queued")).toBe("running");
    expect(endpointStatusOf("succeeded")).toBe("succeeded");
    expect(endpointStatusOf("partial")).toBe("partial");
    expect(endpointStatusOf("failed")).toBe("failed");
    expect(endpointStatusOf("cancelled")).toBe("failed");
  });

  it("ignores a mail run", () => {
    client.setQueryData(endpointKeys.list(TENANT, undefined), [machine()]);
    applyRun(context, run({ subject: { kind: "mailbox", id: "m1", name: "x", detail: null } }));
    expect(refetchedKey(endpointKeys.all(TENANT))).toBe(false);
  });
});

describe("backup jobs", () => {
  it("moves the state, last and next run of a job in its list and detail", () => {
    context.known.definitions.add("job-1");
    const list: BackupJobList = {
      items: [job(), job({ id: "job-2", name: "Other" })],
      uncovered: { mail: 0, endpoint: 0 },
    };
    client.setQueryData(backupJobKeys.list(TENANT, "mail"), list);
    client.setQueryData(backupJobKeys.detail(TENANT, "job-1"), job());
    applyEvent(context, {
      event: "definition",
      data: JSON.stringify(
        live({
          state: "running",
          lastRun: { at: null, failed: 0, partial: 0, running: 2, queued: 0, runId: "run-1" },
          nextRunAt: "2026-10-02T20:00:00.000Z",
        }),
      ),
      id: null,
    });
    const after = client.getQueryData<BackupJobList>(backupJobKeys.list(TENANT, "mail"));
    expect(after?.items[0]).toMatchObject({
      state: "running",
      nextRunAt: "2026-10-02T20:00:00.000Z",
    });
    expect(after?.items[0]?.lastRun.running).toBe(2);
    // The other job and everything that is edited, not live, stays as it was.
    expect(after?.items[1]).toEqual(list.items[1]);
    expect(after?.items[0]?.schedule).toEqual(list.items[0]?.schedule);
    expect(client.getQueryData<BackupJob>(backupJobKeys.detail(TENANT, "job-1"))?.state).toBe(
      "running",
    );
    // Its runs moved, so its members' last backups and its runs tab are read again, and nothing else.
    const detail = backupJobKeys.detail(TENANT, "job-1");
    expect([...refetched].sort()).toEqual(
      [JSON.stringify([...detail, "members"]), JSON.stringify([...detail, "runs"])].sort(),
    );
  });

  it("leaves the members alone when only the next run moved", () => {
    context.known.definitions.add("job-1");
    client.setQueryData(backupJobKeys.list(TENANT, "mail"), {
      items: [job()],
      uncovered: { mail: 0, endpoint: 0 },
    });
    applyEvent(context, {
      event: "definition",
      data: JSON.stringify(live({ nextRunAt: "2026-10-02T20:00:00.000Z" })),
      id: null,
    });
    expect(
      client.getQueryData<BackupJobList>(backupJobKeys.list(TENANT, "mail"))?.items[0]?.nextRunAt,
    ).toBe("2026-10-02T20:00:00.000Z");
    expect(refetched).toEqual([]);
  });

  it("reads the job again when somebody changed the definition itself", () => {
    context.known.definitions.add("job-1");
    client.setQueryData(backupJobKeys.list(TENANT, "mail"), {
      items: [job()],
      uncovered: { mail: 0, endpoint: 0 },
    });
    applyEvent(context, {
      event: "definition",
      data: JSON.stringify(live({ updatedAt: "2026-10-02T09:00:00.000Z", state: "paused" })),
      id: null,
    });
    expect(refetchedKey(backupJobKeys.all(TENANT))).toBe(true);
    // Not merged: its text is stale, REST has the new one.
    expect(
      client.getQueryData<BackupJobList>(backupJobKeys.list(TENANT, "mail"))?.items[0]?.state,
    ).toBe("ok");
  });

  it("reads the lists again for a job that is new", () => {
    applyEvent(context, {
      event: "definition",
      data: JSON.stringify(live({ id: "brand-new" })),
      id: null,
    });
    expect(refetchedKey(backupJobKeys.all(TENANT))).toBe(true);
    refetched.length = 0;
    applyEvent(context, {
      event: "definition",
      data: JSON.stringify(live({ id: "brand-new" })),
      id: null,
    });
    expect(refetched).toEqual([]);
  });

  it("takes a deleted job out of the lists and refreshes what no job covers", () => {
    context.known.definitions.add("job-1");
    client.setQueryData(backupJobKeys.list(TENANT, "mail"), {
      items: [job(), job({ id: "job-2" })],
      uncovered: { mail: 0, endpoint: 0 },
    });
    applyEvent(context, {
      event: "gone",
      data: JSON.stringify({ kind: "definition", id: "job-1" }),
      id: null,
    });
    expect(
      client
        .getQueryData<BackupJobList>(backupJobKeys.list(TENANT, "mail"))
        ?.items.map((item) => item.id),
    ).toEqual(["job-2"]);
    expect(refetchedKey(backupJobKeys.lists(TENANT))).toBe(true);
  });
});

describe("machines", () => {
  const liveMachine = (overrides: Partial<MachineLive> = {}): MachineLive => ({
    id: "m1",
    status: "active",
    connection: "offline",
    agentState: null,
    lastSeenAt: "2026-10-02T09:00:00.000Z",
    lastBackupAt: "2026-10-02T08:00:00.000Z",
    lastSuccessAt: "2026-10-02T08:00:00.000Z",
    nextRunAt: "2026-10-03T02:00:00.000Z",
    ...overrides,
  });

  it("moves the connection state of a machine in its list and detail", () => {
    context.known.machines.add("m1");
    client.setQueryData(endpointKeys.list(TENANT, "server"), [machine(), machine({ id: "m2" })]);
    client.setQueryData(endpointKeys.detail(TENANT, "m1"), {
      ...machine(),
      runs: [],
    } as unknown as EndpointDetail);
    applyEvent(context, { event: "machine", data: JSON.stringify(liveMachine()), id: null });
    const list = client.getQueryData<EndpointSummary[]>(endpointKeys.list(TENANT, "server"));
    expect(list?.[0]).toMatchObject({
      connection: "offline",
      agentState: null,
      nextRunAt: "2026-10-03T02:00:00.000Z",
    });
    expect(list?.[1]?.connection).toBe("online");
    expect(client.getQueryData<EndpointDetail>(endpointKeys.detail(TENANT, "m1"))?.connection).toBe(
      "offline",
    );
    expect(refetched).toEqual([]);
  });

  it("reads the lists again for a machine that enrolled since, once", () => {
    applyEvent(context, {
      event: "machine",
      data: JSON.stringify(liveMachine({ id: "new" })),
      id: null,
    });
    expect(refetchedKey(endpointKeys.lists(TENANT))).toBe(true);
    refetched.length = 0;
    applyEvent(context, {
      event: "machine",
      data: JSON.stringify(liveMachine({ id: "new" })),
      id: null,
    });
    expect(refetched).toEqual([]);
  });

  it("takes a machine that is gone out of the lists", () => {
    client.setQueryData(endpointKeys.list(TENANT, undefined), [machine(), machine({ id: "m2" })]);
    applyEvent(context, {
      event: "gone",
      data: JSON.stringify({ kind: "machine", id: "m1" }),
      id: null,
    });
    expect(
      client
        .getQueryData<EndpointSummary[]>(endpointKeys.list(TENANT, undefined))
        ?.map((m) => m.id),
    ).toEqual(["m2"]);
  });
});

describe("the snapshot", () => {
  it("brings everything current without asking the server for anything", () => {
    client.setQueryData(
      historyKeys.list(TENANT, { type: null, job: null }),
      pages([run({ id: "a" })]),
    );
    client.setQueryData(backupJobKeys.list(TENANT, "mail"), {
      items: [job()],
      uncovered: { mail: 0, endpoint: 0 },
    });
    client.setQueryData(endpointKeys.list(TENANT, undefined), [machine()]);
    const snapshot: LiveSnapshot = {
      runs: [run({ id: "a", state: "succeeded", finishedAt: "2026-10-02T10:04:00.000Z" })],
      definitions: [live({ state: "attention" })],
      machines: [
        {
          id: "m1",
          status: "active",
          connection: "offline",
          agentState: null,
          lastSeenAt: null,
          lastBackupAt: null,
          lastSuccessAt: null,
          nextRunAt: null,
        },
      ],
      serverTime: "2026-10-02T10:05:00.000Z",
    };
    applyEvent(context, { event: "snapshot", data: JSON.stringify(snapshot), id: null });
    expect(
      client.getQueryData<InfiniteData<HistoryPage>>(
        historyKeys.list(TENANT, { type: null, job: null }),
      )?.pages[0]?.items[0]?.state,
    ).toBe("succeeded");
    expect(
      client.getQueryData<BackupJobList>(backupJobKeys.list(TENANT, "mail"))?.items[0]?.state,
    ).toBe("attention");
    expect(
      client.getQueryData<EndpointSummary[]>(endpointKeys.list(TENANT, undefined))?.[0]?.connection,
    ).toBe("offline");
    // Every job and machine is new to a new connection; none of that is news.
    expect(refetched).toEqual([]);
    expect([...context.known.definitions]).toEqual(["job-1"]);
    expect([...context.known.machines]).toEqual(["m1"]);
  });
});

describe("the older job event", () => {
  it("keeps the protected objects' last job current", () => {
    const target = {
      id: "object-1",
      kind: "mailbox",
      displayName: "Anna",
      externalId: "anna@x",
      status: "active",
      source: { id: "s", name: "S", kind: "m365", status: "active" },
      blocked: null,
      lastSnapshot: null,
      lastJob: null,
      latestVerify: null,
    } as BackupTarget;
    client.setQueryData(jobKeys.objects(TENANT), [target]);
    const legacy = {
      id: "job-9",
      queue: "backup",
      status: "completed",
      protectedObjectId: "object-1",
      createdAt: "2026-10-02T10:00:00.000Z",
    } as Job;
    applyEvent(context, { event: "job", data: JSON.stringify(legacy), id: null });
    expect(client.getQueryData<BackupTarget[]>(jobKeys.objects(TENANT))?.[0]?.lastJob?.id).toBe(
      "job-9",
    );
    // A finished backup changes the last snapshot too.
    expect(refetchedKey(jobKeys.objects(TENANT))).toBe(true);
  });
});

describe("what the channel sends that it does not understand", () => {
  it("ignores malformed data and unknown events", () => {
    client.setQueryData(historyKeys.live(TENANT), { a: run({ id: "a" }) });
    for (const event of ["run", "definition", "machine", "gone", "job", "snapshot", "jobs"]) {
      applyEvent(context, { event, data: "{not json", id: null });
    }
    applyEvent(context, { event: "run", data: "{}", id: null });
    applyEvent(context, { event: "future-kind", data: "{}", id: null });
    applyEvent(context, {
      event: "gone",
      data: JSON.stringify({ kind: "weird", id: "x" }),
      id: null,
    });
    expect(Object.keys(client.getQueryData<LiveRuns>(historyKeys.live(TENANT)) ?? {})).toEqual([
      "a",
    ]);
    expect(refetched).toEqual([]);
  });
});

describe("the refetcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks once for a burst of changes to the same query, and for each query that changed", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { refetch, cancel } = createRefetcher(client);
    refetch(["a"]);
    refetch(["a"]);
    refetch(["b"]);
    vi.advanceTimersByTime(REFETCH_DELAY_MS - 1);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(spy).toHaveBeenCalledTimes(2);
    refetch(["c"]);
    cancel();
    vi.advanceTimersByTime(5000);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
