// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { historyKeys } from "@/features/history/api";
import { run as liveRun } from "@/features/history/fixtures";
import {
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  newQueryClient,
  problem,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { candidate, defaults, endpointJob, iso, list, mailJob, restoreCheck } from "../fixtures.js";
import "../i18n.js";
import {
  describedText,
  lookerSession,
  type Opened,
  openJobs,
  openMenu,
  primaryButtons,
  TENANT,
} from "../testing.js";

/**
 * The jobs list as a person meets it: the jobs of one kind with what each covers, when it
 * runs and how its restore checks stand; "New job" as the one primary button; what no job
 * covers; and the same page, closed with a sentence, in the public demo and for a role
 * that may only look.
 */

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

const text = () => document.body.textContent ?? "";
const slot = (name: string) => document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);

const RUNNING = mailJob({
  id: "job-running",
  name: "Executive board, hourly",
  scopeMode: "selected",
  scope: { count: 4, byKind: { mailbox: 4 }, overrides: 0 },
  state: "running",
  lastRun: {
    at: iso(-12),
    failed: 0,
    partial: 0,
    running: 2,
    queued: 0,
    runId: "11111111-1111-4111-8111-111111111111",
  },
  restoreCheck: restoreCheck({ passed: 4, unverified: 0, total: 4 }),
});
const FAILED_CHECK = mailJob({
  id: "job-failed",
  name: "OneDrive, nightly",
  scopeMode: "selected",
  scope: { count: 6, byKind: { onedrive: 6 }, overrides: 0 },
  state: "attention",
  restoreCheck: restoreCheck({ passed: 5, failed: 1, unverified: 0, total: 6 }),
});
const ALL = mailJob();

function mailRoutes(over: Parameters<typeof openJobs>[1] = {}) {
  return {
    ...over,
    routes: {
      // The drawer of a run reads the run; this page has no interest in what it says.
      "GET /history/11111111-1111-4111-8111-111111111111": () =>
        problem("urn:restow:problem:not-found", 404),
      "GET /backup-jobs": () => json(list([ALL, RUNNING, FAILED_CHECK])),
      "GET /backup-jobs/defaults": () => json(defaults("mail")),
      "GET /backup-jobs/candidates": () => json({ items: [], total: 0 }),
      ...over.routes,
    },
  };
}

describe("the list of mail jobs", () => {
  it("shows what each job covers, when it runs, the last and next run and the restore check", async () => {
    opened = await openJobs("/jobs?type=mail", mailRoutes());
    await flush(5);
    const page = slot("jobs-page");
    expect(page?.getAttribute("data-kind")).toBe("mail");
    expect(text()).toContain("All mailboxes, daily");
    expect(text()).toContain("214 mailboxes, 6 OneDrives");
    expect(text()).toContain("Daily at");
    // Running is its own badge (one state per row); what runs is in the panel.
    expect(document.querySelector('[data-state="running"]')?.textContent).toContain("Running");
  });

  it("colours the restore check by what it proves: green only when every object passed", async () => {
    opened = await openJobs("/jobs?type=mail", mailRoutes());
    await flush(5);
    const passed = [...document.querySelectorAll('[data-restore-check="passed"]')];
    const failed = [...document.querySelectorAll('[data-restore-check="failed"]')];
    const attention = [...document.querySelectorAll('[data-restore-check="attention"]')];
    expect(passed.map((node) => node.textContent)).toEqual(["4 of 4 passed"]);
    expect(failed.map((node) => node.textContent?.split(":")[0])).toEqual(["5 of 6 passed"]);
    expect(attention.map((node) => node.textContent?.split(":")[0])).toEqual(["210 of 220 passed"]);
    expect(failed[0]?.getAttribute("data-tone")).toBe("destructive");
    expect(attention[0]?.getAttribute("data-tone")).toBe("warning");
    expect(passed[0]?.getAttribute("data-tone")).toBe("success");
    // The facts behind an amber or red badge are in words for screen readers (the panel shows them).
    expect(text()).toContain("1 failed");
    expect(text()).toContain("10 not checked yet");
  });

  it("has one primary button, New job, and an uppercase label nowhere", async () => {
    opened = await openJobs("/jobs?type=mail", mailRoutes());
    await flush(5);
    const primary = primaryButtons(slot("jobs-page") ?? document.body);
    expect(primary.map((button) => button.textContent?.trim())).toEqual(["New job"]);
    for (const heading of document.querySelectorAll("th")) {
      expect(heading.className).not.toMatch(/uppercase/);
    }
  });

  it("shows the progress of a running backup beside its state, and the run's progress in the panel", async () => {
    const queryClient = newQueryClient();
    queryClient.setQueryData(historyKeys.live(TENANT.id), {
      "live-run": liveRun({
        id: "live-run",
        job: { id: "job-running", name: "Executive board, hourly" },
      }),
    });
    opened = await openJobs("/jobs?type=mail", {
      ...mailRoutes({
        routes: { "GET /history": () => json({ items: [], next: null }) },
      }),
      queryClient,
    });
    await flush(5);
    const row = [...document.querySelectorAll("tr")].find((tr) =>
      tr.textContent?.includes("Executive board, hourly"),
    );
    // One bar beside the state of the running job, none elsewhere.
    expect(row?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("40");
    expect(document.querySelectorAll('tbody [role="progressbar"]')).toHaveLength(1);
    expect(row?.querySelector('[data-action="stop"]')).not.toBeNull();
    await click(row?.querySelector('[data-job-name="job-running"]'));
    await flush(3);
    const sheet = slot("job-sheet");
    expect(sheet?.querySelector('[data-slot="run-progress"]')).not.toBeNull();
    expect(sheet?.textContent).toContain("2 running");
  });

  it("pins the first column: the job stays while the others scroll", async () => {
    opened = await openJobs("/jobs?type=mail", mailRoutes());
    await flush(5);
    const pinned = document.querySelectorAll('td[data-pinned="left"]');
    expect(pinned.length).toBe(3);
    expect(pinned[0]?.textContent).toContain("All mailboxes, daily");
  });

  it("opens a job's detail panel by a click on its row, its name or its state, named in the address", async () => {
    opened = await openJobs(
      "/jobs?type=mail",
      mailRoutes({ routes: { "GET /history": () => json({ items: [], next: null }) } }),
    );
    await flush(5);
    const row = [...document.querySelectorAll("tr")].find((tr) =>
      tr.textContent?.includes("OneDrive, nightly"),
    );
    await click(row?.querySelector("td:nth-child(4)"));
    await flush(3);
    // The page stays where it is; the address names the open row.
    expect(opened.where().pathname).toBe("/jobs");
    expect(opened.where().search).toMatchObject({ type: "mail", job: "job-failed" });
    const sheet = slot("job-sheet");
    expect(sheet?.textContent).toContain("OneDrive, nightly");
    expect(sheet?.querySelector('[data-slot="job-sheet-open"]')?.getAttribute("href")).toContain(
      "/jobs/definitions/job-failed",
    );
    // The restore checks in full: the badge and the facts behind it.
    expect(sheet?.querySelector('[data-slot="job-sheet-verify"]')?.textContent).toContain(
      "1 failed",
    );
  });

  it("shows the whole error of the last failed run in the panel, copyable", async () => {
    const ERROR =
      "Graph request failed: 503 Service Unavailable (request-id 7f3a…) while reading folder Inbox/2026";
    opened = await openJobs(
      "/jobs?type=mail&job=job-failed",
      mailRoutes({
        routes: {
          "GET /history": () =>
            json({
              items: [
                liveRun({
                  id: "failed-run",
                  state: "failed",
                  errorMessage: ERROR,
                  job: { id: "job-failed", name: "OneDrive, nightly" },
                }),
              ],
              next: null,
            }),
        },
      }),
    );
    await flush(6);
    const block = document.querySelector('[data-slot="job-error"]');
    expect(block?.querySelector("pre")?.textContent).toBe(ERROR);
    expect(block?.querySelector('button[aria-label="Copy error"]')).not.toBeNull();
    // Nothing of it in the table.
    expect(document.querySelector("table")?.textContent).not.toContain("Service Unavailable");
  });

  it("starts a job now from its row and stops it after a question", async () => {
    const run = vi.fn(() => json({ queued: 6, skipped: [] }, 202));
    const cancel = vi.fn(() => json({ withdrawn: 1, stopping: 2 }, 202));
    opened = await openJobs(
      "/jobs?type=mail",
      mailRoutes({
        routes: {
          "POST /backup-jobs/job-failed/run": run,
          "POST /backup-jobs/job-running/cancel": cancel,
        },
      }),
    );
    await flush(5);
    await click(byLabel("Start now: OneDrive, nightly"));
    await flush(3);
    expect(run).toHaveBeenCalledTimes(1);
    await click(byLabel("Stop: Executive board, hourly"));
    await flush(3);
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Stop the backups of Executive board, hourly?");
    expect(cancel).not.toHaveBeenCalled();
    await click(buttonByText(dialog as HTMLElement, "Stop backups"));
    await flush(3);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("offers Pause on a mail job and Details, Open, Edit, Start now, its history and Delete beside it", async () => {
    opened = await openJobs("/jobs?type=mail", mailRoutes());
    await flush(5);
    const items = await openMenu(byLabel("Actions for OneDrive, nightly"));
    expect(items.map((item) => item.textContent)).toEqual([
      "Show details",
      "Open",
      "Edit",
      "Start now",
      "Open history",
      "Pause",
      "Delete",
    ]);
    // A job whose backups run also offers Stop.
    const running = await openMenu(byLabel("Actions for Executive board, hourly"));
    expect(running.map((item) => item.textContent)).toContain("Stop");
  });

  it("asks before deleting and says what stops being backed up", async () => {
    opened = await openJobs("/jobs?type=mail", mailRoutes());
    await flush(5);
    const items = await openMenu(byLabel("Actions for OneDrive, nightly"));
    await click(items.find((item) => item.textContent === "Delete"));
    await flush(3);
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Delete OneDrive, nightly?");
    expect(dialog?.textContent).toContain("6 OneDrives will no longer be backed up on a schedule");
    // What becomes of the restore points that exist: they stay.
    expect(dialog?.textContent).toContain("Existing restore points are not deleted");
  });

  it("names objects in paused or manual jobs apart from those in no job, with a way to them", async () => {
    opened = await openJobs(
      "/jobs?type=mail",
      mailRoutes({
        routes: {
          "GET /backup-jobs": () =>
            json(list([ALL], { mail: 2, endpoint: 0 }, { mail: 4, endpoint: 0 })),
        },
      }),
    );
    await flush(5);
    expect(slot("uncovered-notice")?.textContent).toContain("2 protected objects are in no job");
    const unscheduled = slot("unscheduled-notice");
    expect(unscheduled?.textContent).toContain("4 protected objects are in paused jobs");
    expect(unscheduled?.querySelector("a")?.getAttribute("href")).toContain("job=unscheduled");
    expect(slot("uncovered-notice")?.querySelector("a")?.getAttribute("href")).toContain(
      "job=none",
    );
  });

  it("warns about what no job covers and opens the editor with nothing preselected", async () => {
    opened = await openJobs(
      "/jobs?type=mail",
      mailRoutes({
        routes: {
          "GET /backup-jobs": () => json(list([ALL], { mail: 7, endpoint: 0 })),
        },
      }),
    );
    await flush(5);
    const notice = slot("uncovered-notice");
    expect(notice?.textContent).toContain("7 protected objects are in no job");
    await click(buttonByText(notice as HTMLElement, "Create a job"));
    await flush(5);
    expect(opened.where().search).toMatchObject({ type: "mail", new: 1 });
    expect(slot("job-editor")).not.toBeNull();
    expect(opened.where().search.select).toBeUndefined();
  });

  it("creates the recommended mail job after showing what it does (#52)", async () => {
    const plan = {
      items: [
        {
          kind: "mail",
          key: "mail",
          action: "create",
          jobId: null,
          name: "Mail backup",
          os: null,
          profile: null,
          schedule: { kind: "interval", intervalMinutes: 480, timeZone: "Europe/Berlin" },
          verifySchedule: { kind: "cron", cron: "0 3 * * 0", timeZone: "Europe/Berlin" },
          retention: null,
          retentionPolicy: "Ten years",
          repository: {
            id: null,
            name: null,
            kind: "installation_default",
            role: null,
            status: null,
            objectLock: null,
          },
          mode: null,
          paths: [],
          members: [],
          memberCount: 7,
        },
      ],
      skipped: [],
    };
    opened = await openJobs(
      "/jobs?type=mail",
      mailRoutes({
        routes: {
          "GET /backup-jobs": () => json(list([RUNNING], { mail: 7, endpoint: 0 })),
          "GET /backup-jobs/recommended": () => json(plan),
          "POST /backup-jobs/recommended": () =>
            json({
              items: [
                {
                  kind: "mail",
                  key: "mail",
                  jobId: "j-new",
                  name: "Mail backup",
                  created: true,
                  added: 0,
                },
              ],
              skipped: [],
            }),
        },
      }),
    );
    await flush(5);
    const notice = slot("uncovered-notice");
    await click(buttonByText(notice as HTMLElement, "Create recommended job"));
    await flush(5);
    const dialog = slot("recommended-dialog");
    expect(dialog?.textContent).toContain("New job: Mail backup");
    expect(dialog?.textContent).toContain(
      "All protected objects, new ones included (7 without a job now)",
    );
    expect(dialog?.textContent).toContain("Backup: Every 8 hours");
    expect(dialog?.textContent).toContain("Retention: Ten years");
    expect(opened.requests.some((request) => request.method === "POST")).toBe(false);
    await click(dialog?.querySelector('[data-action="confirm-recommended"]'));
    await flush(5);
    const posted = opened.requests.filter(
      (request) => request.method === "POST" && request.path === "/backup-jobs/recommended",
    );
    expect(posted.map((request) => request.body)).toEqual([
      { mail: true, endpointIds: [], guestIds: [], everything: false, kinds: [] },
    ]);
    // Done: the dialog closes (the toast names the job).
    expect(slot("recommended-dialog")).toBeNull();
  });

  it("says nothing about uncovered objects of the other kind", async () => {
    opened = await openJobs(
      "/jobs?type=mail",
      mailRoutes({
        routes: { "GET /backup-jobs": () => json(list([ALL], { mail: 0, endpoint: 5 })) },
      }),
    );
    await flush(5);
    expect(slot("uncovered-notice")).toBeNull();
  });

  it("shows an empty state with the action, and a skeleton while it loads", async () => {
    opened = await openJobs(
      "/jobs?type=mail",
      mailRoutes({ routes: { "GET /backup-jobs": () => json(list([])) } }),
    );
    await flush(5);
    expect(slot("empty-state")?.textContent).toContain("No mail jobs yet");
    expect(buttonByText(slot("empty-state") as HTMLElement, "New job")).not.toBeNull();
    await opened.mounted.unmount();
    opened = null;
    document.body.innerHTML = "";

    opened = await openJobs(
      "/jobs?type=mail",
      mailRoutes({ routes: { "GET /backup-jobs": () => new Promise<Response>(() => undefined) } }),
    );
    await flush(3);
    expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  it("shows the cause and a retry when loading failed", async () => {
    opened = await openJobs(
      "/jobs?type=mail",
      mailRoutes({
        routes: { "GET /backup-jobs": () => problem("urn:restow:problem:internal", 500) },
      }),
    );
    await flush(5);
    expect(text()).toContain("The jobs could not be loaded");
    expect(buttonByText(document.body, "Retry")).not.toBeNull();
  });
});

describe("keeping the list current", () => {
  it("reads the jobs again when the page gets the focus back after a while", async () => {
    opened = await openJobs("/jobs?type=mail", mailRoutes());
    await flush(5);
    const reads = () =>
      opened?.requests.filter((request) => request.path === "/backup-jobs").length ?? 0;
    expect(reads()).toBe(1);
    // A moment later nothing happens; a minute later the jobs are read again.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 60_000);
      window.dispatchEvent(new Event("visibilitychange"));
      await flush(5);
    } finally {
      vi.useRealTimers();
    }
    expect(reads()).toBe(2);
  });
});

describe("the list of machine jobs", () => {
  it("lists servers and clients and offers no Pause: the agent decides when to back up", async () => {
    opened = await openJobs("/jobs?type=endpoint", {
      routes: {
        "GET /backup-jobs": () => json(list([endpointJob()])),
        "GET /backup-jobs/defaults": () => json(defaults("endpoint")),
      },
    });
    await flush(5);
    expect(slot("jobs-page")?.getAttribute("data-kind")).toBe("endpoint");
    expect(text()).toContain("3 servers");
    expect(text()).toContain("Daily at");
    const items = await openMenu(byLabel("Actions for Linux servers, daily"));
    expect(items.map((item) => item.textContent)).toEqual([
      "Show details",
      "Open",
      "Edit",
      "Start now",
      "Open history",
      "Delete",
    ]);
  });

  it("says what a deleted machine job does to its machines: they keep their configuration", async () => {
    opened = await openJobs("/jobs?type=endpoint", {
      routes: { "GET /backup-jobs": () => json(list([endpointJob()])) },
    });
    await flush(5);
    const items = await openMenu(byLabel("Actions for Linux servers, daily"));
    await click(items.find((item) => item.textContent === "Delete"));
    await flush(3);
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "3 servers leave the job and are no longer backed up until another job takes them",
    );
  });
});

describe("Proxmox VE in the list of machine jobs (#53)", () => {
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
  const overview = {
    clusters: [
      { id: "c-1", name: "lab", storageId: "restow", nodes: [{ id: "n-1", name: "pve1" }] },
    ],
    guests: [
      guest({
        id: "g-1",
        vmid: 101,
        name: "web01",
        jobId: "pj-1",
        activity: "running",
        activityJobId: "pj-1",
      }),
      guest({
        id: "g-2",
        vmid: 102,
        name: "mail01",
        activity: "running",
        activityJobId: null,
        activityRunId: "run-2",
        progress: {
          bytesDone: 50,
          bytesTotal: 100,
          bytesUploaded: 10,
          bytesPerSecond: null,
          at: iso(0),
        },
      }),
    ],
    jobs: [
      {
        id: "pj-1",
        name: "Nightly VMs",
        scopeAll: false,
        schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
        settings: {},
        enabled: true,
        recommended: true,
        nextRunAt: iso(600),
        lastRunAt: iso(-10),
        guestCount: 5,
        round: { since: iso(-10), total: 5, done: 2, failed: 0, running: 1, queued: 2 },
      },
    ],
    restorePool: "restow-restore",
  };

  it("shows Proxmox VE jobs with their round and a manual backup as rows, with the type", async () => {
    opened = await openJobs("/jobs?type=endpoint", {
      routes: {
        "GET /backup-jobs": () => json(list([endpointJob()])),
        "GET /pve": () => json(overview),
      },
    });
    await flush(6);
    expect(text()).toContain("Type");
    expect(text()).toContain("Nightly VMs");
    expect(text()).toContain("Proxmox VE");
    expect(text()).toContain("5 VMs and containers");
    // The round's progress beside the job's state: 2 of 5 guests done.
    const row = [...document.querySelectorAll("tr")].find((tr) =>
      tr.textContent?.includes("Nightly VMs"),
    );
    expect(row?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("40");
    // A backup asked for by hand is a row of its own until it ends; web01's belongs to the round.
    expect(text()).toContain("Manual backup · mail01");
    expect(text()).not.toContain("Manual backup · web01");
    const items = await openMenu(byLabel("Actions for Manual backup · mail01"));
    expect(items.map((item) => item.textContent)).toEqual([
      "Show details",
      "Open VM or container",
      "Stop",
    ]);
    // The job's panel says how its round stands.
    await click(row?.querySelector("td:nth-child(4)"));
    await flush(3);
    expect(slot("job-sheet")?.textContent).toContain("2 of 5 guests done");
  });

  it("offers one New job entry per type", async () => {
    opened = await openJobs("/jobs?type=endpoint", {
      routes: {
        "GET /backup-jobs": () => json(list([endpointJob()])),
        "GET /pve": () => json(overview),
      },
    });
    await flush(6);
    const items = await openMenu(slot("new-job-menu"));
    expect(items.map((item) => item.textContent)).toEqual([
      "Servers and clients (Restow agent)",
      "Proxmox VE (VMs & containers)",
    ]);
    await click(items[1]);
    await flush(3);
    // The Proxmox VE job form lists the guests to put into the new job.
    expect(slot("pve-job-guests")?.textContent).toContain("mail01 · VM 102 · pve1");
    // Wide and in two columns, so a job's settings fit on a desktop screen without scrolling.
    expect(slot("pve-job-form")?.closest('[data-slot="dialog-content"]')?.className).toContain(
      "max-w-5xl",
    );
    expect(slot("pve-job-column-schedule")?.contains(slot("pve-job-cadence"))).toBe(true);
    expect(slot("pve-job-column-settings")?.contains(slot("pve-job-boot-test"))).toBe(true);
    expect(slot("pve-job-column-settings")?.contains(slot("pve-job-guests"))).toBe(true);
  });
});

describe("the editor opened from the address", () => {
  it("opens on a new job with the machines of `select` preselected, named once the list is in", async () => {
    opened = await openJobs("/jobs?type=endpoint&new=1&select=m1,m2", {
      routes: {
        "GET /backup-jobs": () => json(list([endpointJob()])),
        "GET /backup-jobs/defaults": () => json(defaults("endpoint")),
        "GET /backup-jobs/candidates": () =>
          json({
            items: [
              candidate({ targetId: "m1", name: "FS-BERGISCH" }),
              candidate({ targetId: "m2", name: "APP-SRV2" }),
              candidate({ targetId: "m3", name: "DC01" }),
            ],
            total: 3,
          }),
      },
    });
    await flush(8);
    const editor = slot("job-editor");
    expect(editor).not.toBeNull();
    expect(editor?.textContent).toContain("New server or client job");
    const checked = [...(editor?.querySelectorAll('[role="checkbox"]') ?? [])].filter(
      (box) => box.getAttribute("aria-checked") === "true",
    );
    expect(checked.map((box) => box.getAttribute("aria-label"))).toEqual([
      "Select FS-BERGISCH",
      "Select APP-SRV2",
    ]);
    // The third machine is in the list and not chosen.
    expect(editor?.querySelector('[aria-label="Select DC01"]')?.getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("closes the editor by leaving the address clean when nothing was entered", async () => {
    opened = await openJobs("/jobs?type=mail&new=1", mailRoutes());
    await flush(8);
    expect(slot("job-editor")).not.toBeNull();
    await click(buttonByText(slot("job-editor") as HTMLElement, "Cancel"));
    await flush(5);
    expect(slot("job-editor")).toBeNull();
    expect(opened.where().search).toEqual({ type: "mail" });
  });
});

describe("the page closed for the public demo and for a role that may only look", () => {
  it("disables New job and the row actions in the demo, with the sentence at the button", async () => {
    opened = await openJobs("/jobs?type=mail", mailRoutes({ demo: true }));
    await flush(5);
    const button = buttonByText(slot("jobs-page") as HTMLElement, "New job") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // The reason is visible on the page, named by the button, and also its tooltip.
    expect(describedText(button)).toContain("This is the public demo");
    expect(button.getAttribute("title")).toContain("This is the public demo");
    const note = slot("access-note");
    expect(note?.getAttribute("data-reason")).toBe("demo");
    // The row menu is still a menu, with every change disabled and the sentence named; opening
    // the job and its history only look.
    const trigger = byLabel("Actions for All mailboxes, daily") as HTMLElement;
    expect(describedText(trigger)).toContain("This is the public demo");
    const items = await openMenu(trigger);
    expect(items.length).toBe(7);
    const changes = items.filter(
      (item) => !["Show details", "Open", "Open history"].includes(item.textContent ?? ""),
    );
    expect(changes.length).toBe(4);
    // So is the row's Start now.
    expect((byLabel("Start now: All mailboxes, daily") as HTMLButtonElement | null)?.disabled).toBe(
      true,
    );
    for (const item of changes) {
      expect(
        item.getAttribute("aria-disabled") ?? item.getAttribute("data-disabled"),
      ).not.toBeNull();
    }
    // Looking is not blocked: the jobs are listed and their names are links.
    expect(text()).toContain("All mailboxes, daily");
  });

  it("shows a provider role that may only look the same page with one sentence, never an error", async () => {
    opened = await openJobs("/jobs?type=mail", mailRoutes({ session: lookerSession() }));
    await flush(5);
    const note = slot("access-note");
    expect(note?.getAttribute("data-reason")).toBe("role");
    expect(note?.textContent).toContain("Administrator role");
    expect(
      (buttonByText(slot("jobs-page") as HTMLElement, "New job") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toContain("OneDrive, nightly");
  });

  it("leaves the controls open for a tenant administrator", async () => {
    opened = await openJobs("/jobs?type=mail", mailRoutes());
    await flush(5);
    expect(slot("access-note")).toBeNull();
    expect(
      (buttonByText(slot("jobs-page") as HTMLElement, "New job") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("shows the editor of the address closed, with the sentence at Save, in the demo", async () => {
    opened = await openJobs("/jobs?type=mail&new=1", mailRoutes({ demo: true }));
    await flush(8);
    const editor = slot("job-editor") as HTMLElement;
    expect(editor).not.toBeNull();
    const save = buttonByText(editor, "Create job") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(describedText(save)).toContain("This is the public demo");
    expect(editor.querySelector("fieldset[disabled]")).not.toBeNull();
  });
});
