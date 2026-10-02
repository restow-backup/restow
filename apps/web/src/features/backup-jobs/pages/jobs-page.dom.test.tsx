// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { historyKeys } from "@/features/history/api";
import { run as liveRun } from "@/features/history/fixtures";
import {
  type Mounted,
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  problem,
} from "@/features/updates/testing";
import { newQueryClient } from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { candidate, defaults, endpointJob, iso, list, mailJob, restoreCheck } from "../fixtures.js";
import "../i18n.js";
import {
  type Opened,
  TENANT,
  describedText,
  lookerSession,
  openJobs,
  openMenu,
  primaryButtons,
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
    // An "all" job says so, and says it has overrides.
    expect(text()).toContain("Everything in no other job, new ones included");
    expect(text()).toContain("Restore check: ");
    expect(text()).toContain("Daily at");
    // Running is its own badge, and the count of what runs now.
    expect(document.querySelector('[data-state="running"]')?.textContent).toContain("Running");
    expect(text()).toContain("2 running");
  });

  it("colours the restore check by what it proves: green only when every object passed", async () => {
    opened = await openJobs("/jobs?type=mail", mailRoutes());
    await flush(5);
    const passed = [...document.querySelectorAll('[data-restore-check="passed"]')];
    const failed = [...document.querySelectorAll('[data-restore-check="failed"]')];
    const attention = [...document.querySelectorAll('[data-restore-check="attention"]')];
    expect(passed.map((node) => node.textContent)).toEqual(["4 of 4 passed"]);
    expect(failed.map((node) => node.textContent)).toEqual(["5 of 6 passed"]);
    expect(attention.map((node) => node.textContent)).toEqual(["210 of 220 passed"]);
    expect(failed[0]?.getAttribute("data-tone")).toBe("destructive");
    expect(attention[0]?.getAttribute("data-tone")).toBe("warning");
    expect(passed[0]?.getAttribute("data-tone")).toBe("success");
    // The facts behind an amber or red badge are in words next to it.
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

  it("shows the progress of a running backup in its row: the bar, the speed with its line, and the percent beside the name", async () => {
    const queryClient = newQueryClient();
    queryClient.setQueryData(historyKeys.live(TENANT.id), {
      "live-run": liveRun({
        id: "live-run",
        job: { id: "job-running", name: "Executive board, hourly" },
      }),
    });
    opened = await openJobs("/jobs?type=mail", { ...mailRoutes(), queryClient });
    await flush(5);
    const row = [...document.querySelectorAll("tr")].find((tr) =>
      tr.textContent?.includes("Executive board, hourly"),
    );
    // The last-run column has the live progress; the other jobs have none.
    expect(row?.querySelector('[data-slot="run-progress"]')).not.toBeNull();
    expect(row?.querySelector('[data-slot="sparkline"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-slot="run-progress"]')).toHaveLength(1);
    // On a phone that column is off screen, so the percent stays with the job's name.
    const pinned = row?.querySelector('td[data-pinned="left"]');
    expect(pinned?.textContent).toContain("40 %");
  });

  it("pins the first column: the job stays while the others scroll", async () => {
    opened = await openJobs("/jobs?type=mail", mailRoutes());
    await flush(5);
    const pinned = document.querySelectorAll('td[data-pinned="left"]');
    expect(pinned.length).toBe(3);
    expect(pinned[0]?.textContent).toContain("All mailboxes, daily");
  });

  it("opens a job by its name and the drawer of its current or last run by a click on the row", async () => {
    opened = await openJobs("/jobs?type=mail", mailRoutes());
    await flush(5);
    const link = [...document.querySelectorAll("a")].find((anchor) =>
      anchor.textContent?.includes("OneDrive, nightly"),
    );
    expect(link?.getAttribute("href")).toContain("/jobs/definitions/job-failed");
    const row = [...document.querySelectorAll("tr")].find((tr) =>
      tr.textContent?.includes("Executive board, hourly"),
    );
    await click(row?.querySelector("td:nth-child(2)"));
    await flush(3);
    // The page stays where it is; the address names the run that opened.
    expect(opened.where().pathname).toBe("/jobs");
    expect(opened.where().search).toMatchObject({
      type: "mail",
      run: "11111111-1111-4111-8111-111111111111",
    });
    expect(document.querySelector('[data-slot="run-drawer"]')).not.toBeNull();
  });

  it("opens the job itself when it has no run to show yet", async () => {
    const NEVER = mailJob({
      id: "job-never",
      name: "Fresh job",
      lastRun: { at: null, failed: 0, partial: 0, running: 0, runId: null },
    });
    opened = await openJobs("/jobs?type=mail", {
      routes: {
        "GET /backup-jobs": () => json(list([NEVER])),
        "GET /backup-jobs/defaults": () => json(defaults("mail")),
        "GET /backup-jobs/candidates": () => json({ items: [], total: 0 }),
      },
    });
    await flush(5);
    const row = [...document.querySelectorAll("tr")].find((tr) =>
      tr.textContent?.includes("Fresh job"),
    );
    await click(row?.querySelector("td:nth-child(2)"));
    await flush(3);
    expect(opened.where().pathname).toBe("/jobs/definitions/job-never");
  });

  it("links the time of the last run to its drawer, so the keyboard and a copied link get there too", async () => {
    opened = await openJobs("/jobs?type=mail", mailRoutes());
    await flush(5);
    const links = [...document.querySelectorAll("a")].filter((anchor) =>
      anchor.getAttribute("href")?.includes("run=11111111-1111-4111-8111-111111111111"),
    );
    expect(links.length).toBeGreaterThan(0);
  });

  it("offers Pause on a mail job and Edit, Run now and Delete beside it", async () => {
    opened = await openJobs("/jobs?type=mail", mailRoutes());
    await flush(5);
    const items = await openMenu(byLabel("Actions for OneDrive, nightly"));
    expect(items.map((item) => item.textContent)).toEqual(["Edit", "Run now", "Pause", "Delete"]);
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
    expect(text()).toContain("1 with overrides");
    expect(text()).toContain("Daily at");
    const items = await openMenu(byLabel("Actions for Linux servers, daily"));
    expect(items.map((item) => item.textContent)).toEqual(["Edit", "Run now", "Delete"]);
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
      "3 servers leave the job and keep the configuration they have now",
    );
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
    // The row menu is still a menu, with every change disabled and the sentence named.
    const trigger = byLabel("Actions for All mailboxes, daily") as HTMLElement;
    expect(describedText(trigger)).toContain("This is the public demo");
    const items = await openMenu(trigger);
    expect(items.length).toBe(4);
    for (const item of items) {
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
