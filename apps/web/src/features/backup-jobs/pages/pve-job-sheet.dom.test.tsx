// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { historyKeys, type PveRunning } from "@/features/history/api";
import type { PveJobSchedule } from "@/features/pve/api";
import {
  click,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  newQueryClient,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { endpointJob, iso, list } from "../fixtures.js";
import "../i18n.js";
import { type Opened, openJobs, TENANT } from "../testing.js";

/**
 * A Proxmox VE job's row and detail panel in Servers & clients while its round goes: the panel
 * shows the guests it backs up now with their progress bar, speed and the small line of that
 * speed (as a mail job's panel shows its running backup), from the live channel's Proxmox VE
 * runs; the row's percent moves with them. A server before 0.5.0 names no job id on its runs:
 * they are matched by the job's name. And every schedule reads in words, not "every 0 h".
 */

// The live channel is connected: the panel samples the guests' speed only from a current state.
vi.mock("@/features/history/live/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/history/live/provider")>();
  return {
    ...actual,
    useLiveState: () => ({ status: "open", lastActivityAt: Date.now() }),
    useLiveOpen: () => true,
  };
});

enableActEnvironment();

let opened: Opened | null = null;

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await opened?.mounted.unmount();
  opened = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const slot = (name: string, scope: ParentNode = document) =>
  scope.querySelector<HTMLElement>(`[data-slot="${name}"]`);

const guest = (over: Record<string, unknown>) => ({
  id: "g-1",
  clusterId: "c-1",
  vmid: 101,
  kind: "vm",
  name: "web01",
  node: "pve1",
  status: "running",
  template: false,
  privileged: false,
  present: true,
  diskBytes: 0,
  jobId: null,
  jobName: null,
  lastBackupAt: null,
  lastSuccessAt: null,
  lastRunStatus: null,
  lastRunError: null,
  activity: null,
  activityJobId: null,
  activityRunId: null,
  bitmapState: null,
  attention: [],
  ...over,
});

const pveJob = (over: Record<string, unknown> = {}) => ({
  id: "pj-1",
  name: "VMs & containers monthly",
  scopeAll: true,
  schedule: { kind: "cron", cron: "0 3 1 * *", timeZone: "Europe/Berlin" },
  settings: {},
  enabled: true,
  recommended: false,
  nextRunAt: iso(600),
  lastRunAt: iso(-10),
  guestCount: 19,
  round: { since: iso(-10), total: 19, done: 3, failed: 0, running: 2, queued: 14 },
  ...over,
});

function overview(jobs: ReturnType<typeof pveJob>[]) {
  return {
    clusters: [
      { id: "c-1", name: "lab", storageId: "restow", nodes: [{ id: "n-1", name: "pve1" }] },
    ],
    guests: [
      guest({ id: "g-1", vmid: 101, name: "web01", activity: "running", activityJobId: "pj-1" }),
      guest({ id: "g-2", vmid: 102, name: "files", kind: "ct", activity: "running" }),
      guest({ id: "g-3", vmid: 103, name: "mail01", activity: "running", activityJobId: null }),
    ],
    jobs,
    restorePool: "restow-restore",
  };
}

/** A guest's backup as the live channel carries it; `jobId` undefined is a server before 0.5.0. */
function liveRun(over: Partial<PveRunning> & Pick<PveRunning, "id" | "guest">): PveRunning {
  const now = new Date().toISOString();
  return {
    kind: "backup",
    jobId: "pj-1",
    jobName: "VMs & containers monthly",
    startedAt: now,
    cancelling: false,
    progress: {
      bytesDone: 512 * 1024 * 1024,
      bytesTotal: 1024 * 1024 * 1024,
      bytesUploaded: null,
      bytesPerSecond: 40 * 1024 * 1024,
      at: now,
    },
    ...over,
  };
}

const WEB = { id: "g-1", vmid: 101, name: "web01", kind: "vm" as const };
const FILES = { id: "g-2", vmid: 102, name: "files", kind: "ct" as const };
const MAIL = { id: "g-3", vmid: 103, name: "mail01", kind: "vm" as const };

async function openWith(
  runs: Record<string, PveRunning> | null,
  jobs = [pveJob()],
): Promise<HTMLTableRowElement | undefined> {
  const queryClient = newQueryClient();
  if (runs) {
    queryClient.setQueryData(historyKeys.livePve(TENANT.id), runs);
  }
  opened = await openJobs("/jobs?type=endpoint", {
    routes: {
      "GET /backup-jobs": () => json(list([endpointJob()])),
      "GET /pve": () => json(overview(jobs)),
    },
    queryClient,
  });
  await flush(6);
  return [...document.querySelectorAll("tr")].find((tr) =>
    tr.textContent?.includes("VMs & containers monthly"),
  );
}

async function openPanel(row: HTMLTableRowElement | undefined): Promise<HTMLElement | null> {
  await click(row?.querySelector('[data-job-name="pve:pj-1"]'));
  await flush(3);
  return slot("job-sheet");
}

describe("the detail panel of a running Proxmox VE job", () => {
  it("shows the guests its round backs up now with their progress, speed and its small line", async () => {
    const row = await openWith({
      // web01 started first: it leads.
      "run-web": liveRun({
        id: "run-web",
        guest: WEB,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      "run-files": liveRun({ id: "run-files", guest: FILES, progress: null }),
      // A backup asked for by hand is not the job's.
      "run-mail": liveRun({ id: "run-mail", guest: MAIL, jobId: null, jobName: null }),
    });
    // The row's percent: 3 of 19 done and half of web01 read: 3.5 of 19.
    expect(row?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("18");

    const sheet = await openPanel(row);
    expect(sheet?.textContent).toContain("3 of 19 guests done");
    const live = slot("pve-job-live", sheet ?? document);
    expect(live?.getAttribute("aria-label")).toBe(
      "Backups and boot tests of VMs and containers running now",
    );
    const guests = [...(live?.querySelectorAll('[data-slot="pve-job-live-guest"]') ?? [])];
    expect(guests.map((entry) => entry.querySelector("a")?.textContent)).toEqual([
      "web01",
      "files",
    ]);
    const [web, files] = guests;
    expect(web?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("50");
    expect(web?.textContent).toContain("50%");
    expect(web?.textContent).toContain("/s");
    // The small line of its speed, sampled as on the start page.
    expect(web?.querySelector('[data-slot="sparkline"]')).not.toBeNull();
    // A guest whose node reported nothing yet says so and draws no line.
    expect(files?.textContent).toContain("No progress reported yet");
    expect(files?.querySelector('[data-slot="sparkline"]')).toBeNull();
  });

  it("matches the runs of a server before 0.5.0, which names no job id, by the job's name", async () => {
    const legacy = (run: PveRunning): PveRunning => {
      const { jobId: _jobId, ...rest } = run;
      return rest;
    };
    const row = await openWith({
      "run-web": legacy(liveRun({ id: "run-web", guest: WEB })),
      "run-mail": legacy(liveRun({ id: "run-mail", guest: MAIL, jobName: "Nightly" })),
    });
    const sheet = await openPanel(row);
    const guests = [...document.querySelectorAll('[data-slot="pve-job-live-guest"]')];
    expect(guests.map((entry) => entry.querySelector("a")?.textContent)).toEqual(["web01"]);
    expect(sheet?.textContent).toContain("3 of 19 guests done · 2 running · 14 waiting");
  });

  it("shows a boot test the job started, marked as one, without a bar and outside the percent", async () => {
    const row = await openWith({
      "run-web": liveRun({
        id: "run-web",
        guest: WEB,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      "boot-files": liveRun({ id: "boot-files", guest: FILES, kind: "boot_test", progress: null }),
    });
    // Only web01's backup moves the round: 3.5 of 19, as without the boot test.
    expect(row?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("18");
    const sheet = await openPanel(row);
    const guests = [...(sheet?.querySelectorAll('[data-slot="pve-job-live-guest"]') ?? [])];
    expect(guests.map((entry) => entry.querySelector("a")?.textContent)).toEqual([
      "web01",
      "files",
    ]);
    const boot = guests[1];
    expect(boot?.textContent).toContain("Boot test");
    expect(boot?.textContent).not.toContain("No progress reported yet");
    expect(boot?.querySelector('[role="progressbar"]')).toBeNull();
    expect(guests[0]?.textContent).not.toContain("Boot test");
  });

  it("shows a job's boot test also after its round ended", async () => {
    const row = await openWith(
      { "boot-web": liveRun({ id: "boot-web", guest: WEB, kind: "boot_test", progress: null }) },
      [pveJob({ round: null })],
    );
    const sheet = await openPanel(row);
    const guests = [...(sheet?.querySelectorAll('[data-slot="pve-job-live-guest"]') ?? [])];
    expect(guests).toHaveLength(1);
    expect(guests[0]?.textContent).toContain("Boot test");
  });

  it("takes no backup of an older server by name while the job's round runs no guest", async () => {
    const { jobId: _jobId, ...legacy } = liveRun({ id: "run-web", guest: WEB });
    // "Back up now" of a guest in the job: such a server names the guest's job on it.
    const row = await openWith({ "run-web": legacy }, [pveJob({ round: null })]);
    const sheet = await openPanel(row);
    expect(slot("pve-job-live", sheet ?? document)).toBeNull();
  });

  it("shows the round's totals alone while the live channel has not described any run", async () => {
    const row = await openWith(null);
    // 3 of 19: the guests done, nothing of the running ones known.
    expect(row?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("15");
    const sheet = await openPanel(row);
    expect(sheet?.textContent).toContain("3 of 19 guests done");
    expect(slot("pve-job-live", sheet ?? document)).toBeNull();
  });
});

describe("the schedule of a Proxmox VE job", () => {
  const cases: [string, PveJobSchedule, string][] = [
    ["interval", { kind: "interval", intervalMinutes: 360, timeZone: "UTC" }, "Every 6 hours"],
    ["daily", { kind: "daily", timeOfDay: "22:00", timeZone: "UTC" }, "Daily at 10:00 PM"],
    [
      "workdays",
      { kind: "cron", cron: "30 1 * * 1-5", timeZone: "UTC" },
      "Monday to Friday at 01:30 AM",
    ],
    [
      "monthly",
      { kind: "cron", cron: "0 3 1 * *", timeZone: "UTC" },
      "Monthly on day 1 at 03:00 AM",
    ],
    ["custom", { kind: "cron", cron: "*/30 1-5 * * *", timeZone: "UTC" }, "Custom: */30 1-5 * * *"],
  ];

  it.each(cases)(
    "reads a %s schedule in words in the row and in the panel",
    async (_, schedule, words) => {
      const row = await openWith(null, [pveJob({ schedule })]);
      expect(row?.textContent).toContain(words);
      expect(row?.textContent).not.toContain("0 h");
      const sheet = await openPanel(row);
      const facts = slot("job-sheet-facts", sheet ?? document);
      expect(slot("pve-schedule", facts ?? document)?.textContent).toBe(words);
      // The zone matters for clock times only.
      expect(facts?.textContent?.includes("UTC")).toBe(schedule.kind !== "interval");
    },
  );

  it("reads chosen weekdays as the days", async () => {
    const schedule: PveJobSchedule = { kind: "cron", cron: "0 1 * * 1,4", timeZone: "UTC" };
    const row = await openWith(null, [pveJob({ schedule })]);
    expect(row?.textContent).toMatch(/Every .*Monday.*Thursday.* at 01:00 AM/);
  });
});
