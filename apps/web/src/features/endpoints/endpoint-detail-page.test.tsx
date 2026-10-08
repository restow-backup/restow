// @vitest-environment happy-dom
import type * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { ApiError } from "@/lib/api";

import type { Failure } from "@/features/failures";

import type { EndpointDetail, EndpointTask, RunDetail } from "./api.js";
import { type Mounted, mount } from "./dom-harness.js";
import { EndpointDetailPage } from "./endpoint-detail-page.js";
import "./i18n.js";

const toast = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("@/components/ui/sonner", () => ({ toast, Toaster: () => null }));
vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return {
    ...actual,
    Dialog: { ...actual.Dialog, Portal: InPlacePortal },
    AlertDialog: { ...actual.AlertDialog, Portal: InPlacePortal },
  };
});
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
      <a href={String(to)} {...props}>
        {children}
      </a>
    ),
  };
});

const fetchEndpoint = vi.fn();
const fetchRun = vi.fn();
const createTask = vi.fn();
const requestRestoreTest = vi.fn();
const fetchSnapshots = vi.fn();
vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    fetchEndpoint: (...args: unknown[]) => fetchEndpoint(...args),
    fetchRun: (...args: unknown[]) => fetchRun(...args),
    createTask: (...args: unknown[]) => createTask(...args),
    requestRestoreTest: (...args: unknown[]) => requestRestoreTest(...args),
    fetchSnapshots: (...args: unknown[]) => fetchSnapshots(...args),
  };
});

const ID = "11111111-1111-4111-8111-111111111111";

/** A cause the server explains: the command before the backup failed. */
const FAILED_CAUSE: Failure = {
  code: "endpoint.pre_hook_failed",
  category: "endpoint",
  transient: false,
  retryable: true,
  params: {},
  technical: { exitCode: 1 },
  occurredAt: "2026-09-30T09:03:00.000Z",
  step: null,
  retry: null,
  steps: [{ id: "check_endpoint_hooks", target: null }],
  docsUrl: "https://docs.example.test/troubleshooting",
};

const SILENT_CAUSE: Failure = {
  ...FAILED_CAUSE,
  code: "endpoint.silent",
  steps: [{ id: "check_endpoint_agent", target: null }],
};

function detail(over: Partial<EndpointDetail> = {}): EndpointDetail {
  return {
    id: ID,
    hostname: "web-01",
    displayName: "Web front",
    os: "linux",
    arch: "amd64",
    profile: "server",
    agentVersion: "0.1.0",
    osVersion: "Debian 12",
    status: "active",
    connection: "online",
    agentState: "idle",
    lastSeenAt: "2026-09-30T09:58:00.000Z",
    lastBackupAt: "2026-09-30T09:03:00.000Z",
    lastSuccessAt: "2026-09-29T22:03:00.000Z",
    nextRunAt: "2026-09-30T20:00:00.000Z",
    readiness: {
      state: "red",
      checkedAt: "2026-09-30T08:00:00.000Z",
      overdue: false,
      basis: "restore_test",
      latestSnapshotId: "abc",
    },
    latestRun: null,
    attention: ["last_backup_failed", "restore_test_failed"],
    problems: [
      { attention: "last_backup_failed", failure: FAILED_CAUSE },
      {
        attention: "restore_test_failed",
        failure: { ...FAILED_CAUSE, code: "endpoint.hash_mismatch", steps: [] },
      },
    ],
    createdAt: "2026-09-01T00:00:00.000Z",
    revokedAt: null,
    config: {
      profile: "server",
      schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
      paths: ["/etc"],
      excludes: [],
      hooks: {},
      bandwidthKbps: null,
      onlyOnAcPower: false,
      useVss: false,
    },
    configVersion: 4,
    agentConfigVersion: 3,
    settings: {
      retention: { keepDaily: 30, keepWeekly: 12, keepMonthly: 12 },
      staleAfterHours: 2,
      staleAfterDays: 7,
      quotaGib: null,
    },
    runs: [
      {
        id: "run-failed",
        kind: "backup",
        status: "failed",
        startedAt: "2026-09-30T09:00:00.000Z",
        finishedAt: "2026-09-30T09:03:00.000Z",
        snapshotId: null,
        errorCount: 2,
        interruptedOnly: false,
        checkIncomplete: false,
        failure: FAILED_CAUSE,
        filesNew: null,
        dataAdded: null,
        totalBytesProcessed: null,
        progress: null,
      },
      {
        id: "run-live",
        kind: "backup",
        status: "running",
        startedAt: "2026-09-30T10:00:00.000Z",
        finishedAt: null,
        snapshotId: null,
        errorCount: 0,
        interruptedOnly: false,
        checkIncomplete: false,
        failure: null,
        filesNew: null,
        dataAdded: null,
        totalBytesProcessed: null,
        progress: {
          filesDone: 50,
          bytesDone: 100,
          totalFiles: 200,
          totalBytes: 400,
          currentPath: "/etc/ssh/ssh_config",
          updatedAt: "2026-09-30T10:01:00.000Z",
        },
      },
    ],
    tasks: [],
    recentTasks: [],
    reports: [
      {
        id: "rep1",
        kind: "restore_test",
        origin: "server",
        snapshotId: "abcdef0123456789",
        readiness: "red",
        summary: {
          files: 20,
          matched: 18,
          mismatched: [
            { path: "/etc/passwd", expected: "aaa", actual: "bbb", reason: "hash differs" },
            { path: "/etc/shadow", expected: "ccc", actual: null },
          ],
        },
        checkedAt: "2026-09-30T08:00:00.000Z",
      },
    ],
    repository: { bytes: 5_000_000, snapshots: 42, at: "2026-09-30T03:00:00.000Z" },
    storage: {
      usedBytes: 5_000_000,
      measuredAt: "2026-09-30T03:00:00.000Z",
      budgetBytes: 2 * 1024 ** 4,
      ownBudget: false,
      defaultBudgetBytes: 2 * 1024 ** 4,
      tenantUsedBytes: 9_000_000,
      tenantBudgetBytes: 20 * 1024 ** 4,
      level: "ok" as const,
      refusedAt: null,
    },
    lastRetentionAt: "2026-09-30T03:00:00.000Z",
    lastCheckAt: null,
    lastRestoreTestAt: "2026-09-30T08:00:00.000Z",
    commands: null,
    hooks: {
      policy: "any",
      scripts: [],
      visible: true,
      pre: { set: false, fingerprint: null },
      post: { set: false, fingerprint: null },
    },
    autoUpdatePaused: false,
    autoUpdateOwnPause: false,
    ...over,
  };
}

const failedRun: RunDetail = {
  ...(detail().runs[0] as RunDetail),
  taskId: null,
  stats: null,
  errors: [{ path: "/etc/secret", message: "permission denied" }, { message: "lock timeout" }],
  logTail: "fatal: unable to open repository",
};

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("EndpointDetailPage", () => {
  let page: Mounted;
  const onTabChange = vi.fn();

  beforeEach(() => {
    for (const fn of [
      fetchEndpoint,
      fetchRun,
      createTask,
      requestRestoreTest,
      fetchSnapshots,
      onTabChange,
    ]) {
      fn.mockReset();
    }
    for (const fn of Object.values(toast)) fn.mockReset();
    fetchEndpoint.mockResolvedValue(detail());
    fetchRun.mockResolvedValue(failedRun);
    fetchSnapshots.mockResolvedValue([]);
  });
  afterEach(() => page?.unmount());

  async function open(tab: "overview" | "snapshots" | "settings" = "overview") {
    page = mount();
    await page.render(<EndpointDetailPage endpointId={ID} tab={tab} onTabChange={onTabChange} />);
    await page.settle();
  }

  it("shows the name, the badges and every problem with the shared failure explanation", async () => {
    await open();
    expect(document.querySelector("h1")?.textContent).toBe("Web front");
    expect(page.text()).toContain("web-01");
    const badges = document.querySelector('[data-slot="endpoint-badges"]')?.textContent ?? "";
    expect(badges).toContain("Server");
    expect(badges).toContain("Online");
    expect(badges).toContain("Not restorable");
    const entries = [
      ...document.querySelectorAll('[data-slot="attention-alerts"] > [data-attention]'),
    ];
    expect(entries.map((entry) => entry.getAttribute("data-attention"))).toEqual([
      "restore_test_failed",
      "last_backup_failed",
    ]);
    // The heaviest is open: what happened is left out (the page says it), why and what to do are there.
    expect(entries[0]?.textContent).toContain(
      "A restored file does not match its recorded checksum",
    );
    expect(entries[0]?.textContent).toContain("Why");
    expect(entries[0]?.textContent).toContain("Technical details");
    // The other one is closed to one line with its cause.
    expect(entries[1]?.textContent).toContain("Last backup failed");
    expect(entries[1]?.textContent).toContain("The command before the backup failed");
    expect(entries[1]?.textContent).not.toContain("Technical details");
    await page.click(entries[1]?.querySelector("button") as HTMLElement);
    expect(entries[1]?.textContent).toContain("Run the before and after commands");
    // The way back leads to the inventory, where every machine is listed.
    expect(document.querySelector('a[href="/inventory"]')?.textContent).toContain(
      "Back to inventory",
    );
  });

  it("names the actual age in the explanation of a silent server", async () => {
    fetchEndpoint.mockResolvedValue(
      detail({
        attention: ["silent"],
        problems: [{ attention: "silent", failure: { ...SILENT_CAUSE, params: { ageHours: 6 } } }],
      }),
    );
    await open();
    const entry = document.querySelector(
      '[data-slot="attention-alerts"] [data-attention="silent"]',
    );
    expect(entry?.textContent).toContain("The server has not reported");
    expect(entry?.textContent).toContain("no contact for 6 hours");
  });

  it("falls back to a plain sentence for a reason the server does not explain", async () => {
    fetchEndpoint.mockResolvedValue(detail({ attention: ["never_seen"], problems: [] }));
    await open();
    const entry = document.querySelector(
      '[data-slot="attention-alerts"] [data-attention="never_seen"]',
    );
    expect(entry?.textContent).toContain("Never connected");
    expect(entry?.textContent).toContain("Check that the install command ran");
    expect(entry?.textContent).not.toContain("{appName}");
  });

  it("shows facts, the pending configuration and the repository honestly", async () => {
    await open();
    const facts = document.querySelector('[data-slot="endpoint-facts"]')?.textContent ?? "";
    expect(facts).toContain("Debian 12");
    expect(facts).toContain("0.1.0");
    expect(facts).toContain("Version 4 is saved; the machine still runs version 3");
    expect(facts).toContain("Last successful backup");
    const repository =
      document.querySelector('[data-slot="endpoint-repository"]')?.textContent ?? "";
    expect(repository).toContain("42");
    expect(repository).toContain("30 daily, 12 weekly and 12 monthly");
    expect(repository).toContain("the agent can add backups but never delete them");
  });

  it("shows the storage use against the machine's and the tenant's budget", async () => {
    await open();
    const repository =
      document.querySelector('[data-slot="endpoint-repository"]')?.textContent ?? "";
    expect(repository).toContain("Storage budget");
    expect(repository).toContain("the installation's default");
    expect(repository).toContain("All servers and clients");
    expect(document.querySelector('[data-slot="storage-quota"]')).toBeNull();
  });

  it("warns when the budget is nearly used up and says so plainly when it is", async () => {
    const storage = detail().storage;
    fetchEndpoint.mockResolvedValue(
      detail({
        storage: { ...storage, usedBytes: 1900 * 1024 ** 3, level: "near", ownBudget: true },
      }),
    );
    await open();
    let alert = document.querySelector('[data-slot="storage-quota"]');
    expect(alert?.textContent).toContain("more than 90 percent");
    expect(document.querySelector('[data-slot="endpoint-repository"]')?.textContent).toContain(
      "set for this machine",
    );
    expect(document.querySelector('[data-slot="endpoint-repository"]')?.textContent).toContain(
      "(92 %)",
    );
    page.unmount();
    fetchEndpoint.mockResolvedValue(
      detail({
        storage: { ...storage, level: "exceeded", refusedAt: "2026-09-30T09:00:00.000Z" },
      }),
    );
    await open();
    alert = document.querySelector('[data-slot="storage-quota"]');
    expect(alert?.getAttribute("data-variant")).toBe("destructive");
    expect(alert?.textContent).toContain("Restores keep working");
    expect(document.querySelector('[data-slot="endpoint-repository"]')?.textContent).toContain(
      "Last refused upload",
    );
  });

  it("says the repository was not measured when no retention run has happened", async () => {
    fetchEndpoint.mockResolvedValue(
      detail({
        repository: null,
        lastRetentionAt: null,
        storage: { ...detail().storage, usedBytes: null, measuredAt: null },
      }),
    );
    await open();
    expect(document.querySelector('[data-slot="endpoint-repository"]')?.textContent).toContain(
      "Not measured yet",
    );
  });

  it("lists the runs with a failed one and a running one with live progress", async () => {
    await open();
    const rows = [...document.querySelectorAll('[data-slot="runs-card"] tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("data-run-status")).toBe("failed");
    expect(rows[0]?.textContent).toContain("Failed");
    expect(rows[1]?.getAttribute("data-run-status")).toBe("running");
    expect(rows[1]?.textContent).toContain("25%");
  });

  it("lists a run the agent lost to a restart neutrally, not as a failed one", async () => {
    const [base] = detail().runs;
    fetchEndpoint.mockResolvedValue(
      detail({
        attention: [],
        problems: [],
        runs: [
          {
            ...(base as RunDetail),
            errorCount: 1,
            interruptedOnly: true,
            failure: { ...FAILED_CAUSE, code: "endpoint.interrupted", steps: [] },
          },
        ],
      }),
    );
    await open();
    const row = document.querySelector('[data-slot="runs-card"] tbody tr') as HTMLElement;
    expect(row.textContent).toContain("Interrupted");
    expect(row.textContent).not.toContain("Failed");
  });

  it("lists a restore test that could not complete neutrally, never as failed", async () => {
    const [base] = detail().runs;
    const test = {
      ...(base as RunDetail),
      id: "run-test",
      kind: "verify_sample" as const,
      errorCount: 1,
      checkIncomplete: true,
      failure: { ...FAILED_CAUSE, code: "endpoint.agent_stopped", steps: [] },
    };
    fetchEndpoint.mockResolvedValue(detail({ runs: [test] }));
    await open();
    const row = document.querySelector('[data-slot="runs-card"] tbody tr') as HTMLElement;
    expect(row.textContent).toContain("Not completed, will be retried");
    expect(row.querySelector('[data-run-mark="incomplete"]')?.getAttribute("data-tone")).toBe(
      "info",
    );
    expect(row.textContent).not.toContain("Failed");

    // A revoked machine runs no more tests, so nothing is promised.
    page.unmount();
    fetchEndpoint.mockResolvedValue(
      detail({ runs: [test], status: "revoked", revokedAt: "2026-09-30T11:00:00.000Z" }),
    );
    await open();
    const revoked = document.querySelector('[data-slot="runs-card"] tbody tr') as HTMLElement;
    expect(revoked.textContent).toContain("Not completed");
    expect(revoked.textContent).not.toContain("will be retried");
  });

  it("says when a restore test offered again will be picked up", async () => {
    const notBefore = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    fetchEndpoint.mockResolvedValue(
      detail({
        tasks: [
          {
            id: "t-retry",
            kind: "verify_sample",
            status: "pending",
            params: { snapshotId: "abcdef0123456789", files: [], retry: 2, notBefore },
            createdAt: "2026-09-30T08:00:00.000Z",
            deliveredAt: null,
            finishedAt: null,
            errorMessage: null,
            checkIncomplete: false,
          },
        ],
      }),
    );
    await open();
    const card = document.querySelector('[data-slot="pending-tasks"]');
    expect(card?.querySelector("[data-task-retry]")?.textContent).toContain(
      "Repeats a test that could not complete; picked up from",
    );
  });

  it("lists the recent finished requests with how each ended", async () => {
    const task = (over: Partial<EndpointTask>): EndpointTask => ({
      id: "t1",
      kind: "backup_now",
      status: "done",
      params: {},
      createdAt: "2026-09-30T08:00:00.000Z",
      deliveredAt: "2026-09-30T08:01:00.000Z",
      finishedAt: "2026-09-30T08:05:00.000Z",
      errorMessage: null,
      checkIncomplete: false,
      ...over,
    });
    fetchEndpoint.mockResolvedValue(
      detail({
        recentTasks: [
          task({ id: "t1" }),
          task({
            id: "t2",
            kind: "restore",
            params: { paths: ["/etc", "/home"] },
            status: "failed",
            errorMessage: "expired",
          }),
          task({
            id: "t3",
            kind: "verify_sample",
            status: "failed",
            errorMessage: "hash tool missing",
          }),
          task({ id: "t4", kind: "uninstall", status: "failed", errorMessage: null }),
          task({
            id: "t5",
            kind: "verify_sample",
            status: "failed",
            errorMessage: "agent stopped reporting",
            checkIncomplete: true,
          }),
        ],
      }),
    );
    await open();
    const card = document.querySelector('[data-slot="recent-tasks"]');
    expect(card).not.toBeNull();
    const rows = [...(card?.querySelectorAll("li") ?? [])];
    expect(rows.map((row) => row.getAttribute("data-task-status"))).toEqual([
      "done",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    expect(rows[0]?.textContent).toContain("Back up now");
    expect(rows[0]?.textContent).toContain("Done");
    expect(rows[1]?.textContent).toContain("Restore 2 items into a new folder");
    expect(rows[1]?.textContent).toContain("The machine did not pick it up in time.");
    // A reason the server does not word is shown as the agent reported it.
    expect(rows[2]?.textContent).toContain("hash tool missing");
    expect(rows[3]?.textContent).toContain("Failed");
    // A restore test whose report proved the backup broken stays red.
    expect(rows[2]?.querySelector('[data-tone="destructive"]')?.textContent).toContain("Failed");
    // One that could not complete is neutral, with its reason.
    expect(rows[4]?.textContent).toContain("Not completed, will be retried");
    expect(rows[4]?.textContent).toContain(
      "The agent stopped reporting while it ran this request.",
    );
    expect(rows[4]?.textContent).not.toContain("Failed");
    expect(rows[4]?.querySelector('[data-task-mark="incomplete"]')?.getAttribute("data-tone")).toBe(
      "info",
    );
  });

  it("shows no recent requests card when nothing finished yet", async () => {
    await open();
    expect(document.querySelector('[data-slot="recent-tasks"]')).toBeNull();
  });

  it("opens a run with its errors and log", async () => {
    await open();
    const row = document.querySelector('tr[data-run-status="failed"]') as HTMLElement;
    await page.click(row.querySelector("button") as HTMLElement);
    await page.settle();
    expect(fetchRun).toHaveBeenCalledWith(ID, "run-failed");
    const errors = document.querySelector('[data-slot="run-errors"]');
    // The explanation of the failure comes first, above the raw errors and the log.
    const sheet = document.querySelector('[data-slot="sheet-content"]');
    expect(sheet?.textContent).toContain("Backup for Web front failed");
    expect(sheet?.textContent).toContain("The command before the backup failed");
    expect(sheet?.textContent).toContain("Run the before and after commands");
    expect(sheet?.textContent?.indexOf("Run the before and after commands")).toBeLessThan(
      sheet?.textContent?.indexOf("permission denied") ?? 0,
    );
    expect(errors?.textContent).toContain("/etc/secret");
    expect(errors?.textContent).toContain("permission denied");
    expect(errors?.textContent).toContain("lock timeout");
    expect(document.querySelector('[data-slot="run-log"]')?.textContent).toContain(
      "fatal: unable to open repository",
    );
  });

  it("shows the reports with every difference of a restore test", async () => {
    await open();
    const card = document.querySelector('[data-slot="reports-card"]');
    expect(card?.textContent).toContain("18 of 20 sampled files matched their checksum");
    await page.click(page.byText("button", "Show 2 differences"));
    const mismatches = document.querySelector('[data-slot="report-mismatches"]')?.textContent ?? "";
    expect(mismatches).toContain("/etc/passwd");
    expect(mismatches).toContain("hash differs");
    expect(mismatches).toContain("/etc/shadow");
    expect(mismatches).toContain("File could not be read back");
  });

  it("shows a machine in no job as without backup and offers no backup now", async () => {
    const base = detail();
    fetchEndpoint.mockResolvedValue(
      detail({
        job: null,
        attention: ["no_job"],
        problems: [],
        config: { ...base.config, schedule: { kind: "none", timeZone: "Europe/Berlin" } },
      }),
    );
    await open();
    expect(document.querySelector('[data-slot="endpoint-badges"]')?.textContent).toContain(
      "Without backup",
    );
    const notice = document.querySelector('[data-slot="without-backup-notice"]');
    expect(notice?.textContent).toContain("This machine is not backed up");
    // An old backup's rating is not green next to "Without backup": it turns neutral, says why.
    if (base.readiness.state !== "no_backup") {
      expect(document.querySelector('[data-slot="readiness-frozen"]')).not.toBeNull();
      expect(document.querySelector('[data-slot="endpoint-badges"]')?.textContent).toContain(
        "no new backups are added",
      );
    }
    expect(notice?.textContent).toContain("A newly enrolled machine backs up only once");
    // Whoever may not manage jobs is told whom to ask.
    expect(notice?.textContent).toContain("Ask an administrator");
    // The notice is the explanation; the attention area does not repeat it.
    expect(
      document.querySelector('[data-slot="attention-alerts"] [data-attention="no_job"]'),
    ).toBeNull();
    const backup = page.byText<HTMLButtonElement>("button", "Back up now");
    expect(backup.disabled).toBe(true);
    expect(backup.closest('[data-slot="disabled-reason"]')).not.toBeNull();
    expect(backup.title).toBe("");
  });

  it("requests a backup now, and says so when one is already waiting", async () => {
    createTask.mockResolvedValue({ alreadyQueued: false, task: {} });
    await open();
    await page.click(page.byText("button", "Back up now"));
    await page.settle();
    expect(createTask).toHaveBeenCalledWith(ID, { kind: "backup_now" });
    expect(toast.success).toHaveBeenCalledWith("Backup requested", expect.anything());

    createTask.mockResolvedValue({ alreadyQueued: true, task: {} });
    await page.click(page.byText("button", "Back up now"));
    await page.settle();
    expect(toast.info).toHaveBeenCalledWith("A backup is already waiting for this machine.");
  });

  it("explains a busy repository when the restore test cannot be queued", async () => {
    requestRestoreTest.mockRejectedValue(
      new ApiError(
        503,
        {
          type: "urn:restow:problem:endpoint-repository-locked",
          title: "Repository busy",
          status: 503,
        },
        "x",
      ),
    );
    await open();
    await page.click(page.byText("button", "Start restore check"));
    await page.settle();
    expect(requestRestoreTest).toHaveBeenCalledWith(ID);
    expect(toast.error).toHaveBeenCalledWith(
      "The restore check could not be started",
      expect.objectContaining({
        description: expect.stringContaining("busy with a backup or maintenance"),
      }),
    );
  });

  it("reports a restore test that was queued", async () => {
    requestRestoreTest.mockResolvedValue({ queued: true });
    await open();
    await page.click(page.byText("button", "Start restore check"));
    await page.settle();
    expect(toast.success).toHaveBeenCalledWith("Restore check scheduled", expect.anything());
  });

  it("cannot test a machine that has no good backup yet", async () => {
    fetchEndpoint.mockResolvedValue(
      detail({
        readiness: {
          state: "no_backup",
          checkedAt: null,
          overdue: false,
          basis: null,
          latestSnapshotId: null,
        },
        attention: [],
      }),
    );
    await open();
    const button = page.byText("button", "Start restore check") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // The reason sits on a focusable wrapper: a disabled button shows no tooltip of its own.
    expect(button.closest('[data-slot="disabled-reason"]')?.getAttribute("tabindex")).toBe("0");
  });

  it("shows a revoked machine as revoked: a banner, no attention, no actions", async () => {
    fetchEndpoint.mockResolvedValue(
      detail({ status: "revoked", revokedAt: "2026-09-29T00:00:00.000Z", attention: ["silent"] }),
    );
    await open();
    expect(document.querySelector('[data-slot="revoked-banner"]')?.textContent).toContain(
      "This machine is revoked",
    );
    expect(document.querySelector('[data-slot="attention-alerts"]')).toBeNull();
    // A revoked machine never fetches a newer configuration, so none is said to be waiting.
    expect(document.querySelector('[data-slot="endpoint-facts"]')?.textContent).not.toContain(
      "fetches the change",
    );
    expect((page.byText("button", "Back up now") as HTMLButtonElement).disabled).toBe(true);
    expect((page.byText("button", "Start restore check") as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-slot="endpoint-badges"]')?.textContent).toContain(
      "Revoked",
    );
  });

  it("keeps the selected tab in the URL through the callback", async () => {
    await open();
    const trigger = page.byText('[role="tab"]', "Snapshots");
    await page.settle();
    await (async () => {
      const { act } = await import("react");
      await act(async () => {
        trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      });
    })();
    expect(onTabChange).toHaveBeenCalledWith("snapshots");
  });

  it("opens on the tab named by the URL", async () => {
    await open("settings");
    expect(page.text()).toContain("Folders to back up");
    expect(page.text()).toContain("Restore without Restow");
    expect(page.text()).toContain("Remove this machine");
  });

  it("says when the machine does not exist, without a retry", async () => {
    fetchEndpoint.mockRejectedValue(
      new ApiError(404, { type: "about:blank", title: "Endpoint not found", status: 404 }, "x"),
    );
    await open();
    expect(page.text()).toContain("Machine not found");
    expect(page.maybeByText("button", "Retry")).toBeNull();
  });

  it("says why the machine could not be loaded, with a retry", async () => {
    fetchEndpoint.mockRejectedValue(new ApiError(500, null, "boom"));
    await open();
    expect(page.text()).toContain("The machine could not be loaded");
    expect(page.maybeByText("button", "Retry")).not.toBeNull();
  });
});
