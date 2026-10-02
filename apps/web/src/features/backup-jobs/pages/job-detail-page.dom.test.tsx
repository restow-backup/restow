// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type Mounted,
  type RecordedRequest,
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  problem,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { defaults, endpointJob, iso, mailJob, member } from "../fixtures.js";
import "../i18n.js";
import {
  type Opened,
  describedText,
  focusOn,
  openJobs,
  openMenu,
  primaryButtons,
} from "../testing.js";

/**
 * One job as a person meets it: the overview, the objects or machines with what each does
 * differently, everything the job says, and its runs; Run now, Edit and Pause or Resume at the
 * top, closed with the reason at the button in the demo; the address that keeps the right menu
 * entry active; and a job that does not exist in this tenant.
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

const slot = (name: string) => document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
const text = () => document.body.textContent ?? "";
const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const tab = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (node) => node.textContent === name,
  );

const JOB = endpointJob();
const MEMBERS = [
  member({
    targetId: "m1",
    name: "FS-BERGISCH",
    overrides: { paths: ["/srv"], bandwidthKbps: null },
    effective: {
      schedule: JOB.schedule,
      verifySchedule: null,
      settings: { ...JOB.settings, paths: ["/srv"], bandwidthKbps: null },
    },
    restoreCheck: { state: "green", checkedAt: iso(-60) },
  }),
  member({
    targetId: "m2",
    name: "APP-SRV2",
    detail: "Linux arm64",
    lastBackup: { at: iso(-50), outcome: "failed" },
    restoreCheck: { state: "red", checkedAt: iso(-60) },
  }),
  member({
    targetId: "m3",
    name: "DC01",
    covered: true,
    lastBackup: { at: null, outcome: null },
    restoreCheck: { state: "no_backup", checkedAt: null },
  }),
];

type Handler = (request: RecordedRequest) => Response | Promise<Response>;

function machineRoutes(over: Record<string, Handler> = {}) {
  return {
    "GET /backup-jobs/job-srv": () => json(JOB),
    "GET /backup-jobs/job-srv/members": () => json({ mode: "selected", items: MEMBERS }),
    "GET /backup-jobs/job-srv/runs": () =>
      json({
        items: [
          {
            id: "r1",
            source: "endpoint",
            type: "backup",
            status: "succeeded",
            targetId: "m1",
            targetName: "FS-BERGISCH",
            startedAt: iso(-45),
            finishedAt: iso(-42),
            createdAt: iso(-45),
          },
        ],
      }),
    "GET /backup-jobs": () => json({ items: [JOB], uncovered: { mail: 0, endpoint: 0 } }),
    "GET /backup-jobs/defaults": () => json(defaults("endpoint")),
    "GET /backup-jobs/candidates": () => json({ items: [], total: 0 }),
    ...over,
  };
}

describe("the page of a machine job", () => {
  it("names the job and shows its key facts, with one primary button and no Pause", async () => {
    opened = await openJobs("/jobs/definitions/job-srv?type=endpoint", { routes: machineRoutes() });
    await flush(6);
    const page = slot("job-detail");
    expect(page?.getAttribute("data-kind")).toBe("endpoint");
    expect(page?.querySelector("h1")?.textContent).toBe("Linux servers, daily");
    expect(slot("job-overview")?.textContent).toContain("3 servers");
    expect(slot("job-overview")?.textContent).toContain("Daily at");
    expect(slot("job-overview")?.textContent).toContain("Daily 14, weekly 8, monthly 6");
    expect(primaryButtons(page ?? document.body).map((node) => node.textContent?.trim())).toEqual([
      "Run now",
    ]);
    // A machine job cannot be paused: the agent decides when to back up.
    expect(buttonByText(page as HTMLElement, "Pause")).toBeNull();
    expect(buttonByText(page as HTMLElement, "Resume")).toBeNull();
    expect(buttonByText(page as HTMLElement, "Edit")).not.toBeNull();
  });

  it("lists the four tabs and keeps the tab in the address, the kind with it", async () => {
    opened = await openJobs("/jobs/definitions/job-srv?type=endpoint", { routes: machineRoutes() });
    await flush(6);
    expect([...document.querySelectorAll('[role="tab"]')].map((node) => node.textContent)).toEqual([
      "Overview",
      "Scope",
      "Settings",
      "Runs",
    ]);
    // Tabs activate when they take the focus (the arrow keys move it).
    await focusOn(tab("Scope"));
    await flush(3);
    expect(opened.where().search).toEqual({ type: "endpoint", tab: "scope" });
    await focusOn(tab("Overview"));
    await flush(3);
    expect(opened.where().search).toEqual({ type: "endpoint" });
  });

  it("adds the kind to an address that came without one, once the job is known", async () => {
    opened = await openJobs("/jobs/definitions/job-srv", { routes: machineRoutes() });
    await flush(8);
    expect(opened.where().pathname).toBe("/jobs/definitions/job-srv");
    expect(opened.where().search).toEqual({ type: "endpoint" });
  });

  it("opens on the tab the address names", async () => {
    opened = await openJobs("/jobs/definitions/job-srv?type=endpoint&tab=scope", {
      routes: machineRoutes(),
    });
    await flush(6);
    expect(tab("Scope")?.getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("FS-BERGISCH");
  });

  it("shows each machine with its schedule, last backup, restore check and what it does differently", async () => {
    opened = await openJobs("/jobs/definitions/job-srv?type=endpoint&tab=scope", {
      routes: machineRoutes(),
    });
    await flush(6);
    const rows = [...document.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(3);
    const first = rows.find((row) => row.textContent?.includes("FS-BERGISCH"));
    // A machine's name leads to its own page; the first column is pinned.
    expect(first?.querySelector("a")?.getAttribute("href")).toBe("/inventory/m1");
    expect(first?.querySelector('td[data-pinned="left"]')).not.toBeNull();
    expect(first?.textContent).toContain("2 overrides");
    expect(first?.textContent).toContain("Ready");
    const failing = rows.find((row) => row.textContent?.includes("APP-SRV2"));
    expect(failing?.textContent).toContain("Failed");
    expect(failing?.textContent).toContain("None");
    const fresh = rows.find((row) => row.textContent?.includes("DC01"));
    expect(fresh?.textContent).toContain("No backup yet");
  });

  it("offers Edit overrides, Run now and Remove on a row", async () => {
    opened = await openJobs("/jobs/definitions/job-srv?type=endpoint&tab=scope", {
      routes: machineRoutes(),
    });
    await flush(6);
    const items = await openMenu(byLabel("Actions for FS-BERGISCH"));
    expect(items.map((item) => item.textContent)).toEqual([
      "Edit overrides",
      "Run now",
      "Remove from job",
    ]);
  });

  it("runs the job for the machines asked for, and the whole job from the header", async () => {
    const bodies: unknown[] = [];
    opened = await openJobs("/jobs/definitions/job-srv?type=endpoint&tab=scope", {
      routes: machineRoutes({
        "POST /backup-jobs/job-srv/run": () => {
          return json({ queued: 1, skipped: [] }, 202);
        },
      }),
    });
    await flush(6);
    const items = await openMenu(byLabel("Actions for APP-SRV2"));
    await click(items.find((item) => item.textContent === "Run now"));
    await flush(4);
    const run = opened.requests.filter((request) => request.path === "/backup-jobs/job-srv/run");
    bodies.push(...run.map((request) => request.body));
    expect(bodies).toEqual([{ targetIds: ["m2"] }]);
    await click(buttonByText(slot("job-detail") as HTMLElement, "Run now"));
    await flush(4);
    expect(
      opened.requests
        .filter((request) => request.path === "/backup-jobs/job-srv/run")
        .map((request) => request.body),
    ).toEqual([{ targetIds: ["m2"] }, {}]);
  });

  it("edits the overrides of a machine: a switch per setting, the same fields when on, only those sent", async () => {
    let body: unknown = null;
    opened = await openJobs("/jobs/definitions/job-srv?type=endpoint&tab=scope", {
      routes: machineRoutes({
        "PATCH /backup-jobs/job-srv/members/m2": (request) => {
          body = request.body;
          return json(endpointJob());
        },
      }),
    });
    await flush(6);
    const items = await openMenu(byLabel("Actions for APP-SRV2"));
    await click(items.find((item) => item.textContent === "Edit overrides"));
    await flush(8);
    const sheet = slot("overrides-sheet") as HTMLElement;
    expect(sheet.textContent).toContain("Overrides of APP-SRV2");
    const switches = [...sheet.querySelectorAll('[role="switch"]')].map((node) => {
      const label = sheet.querySelector(`label[for="${node.id}"]`);
      return label?.textContent;
    });
    expect(switches).toEqual([
      "Own schedule",
      "Own folders",
      "Own exclusions",
      "Own bandwidth limit",
      "Own commands",
      "Own retention",
    ]);
    // Everything is off: the job's values apply, and the fields are not shown.
    expect(sheet.querySelector('[data-slot="folders-field"]')).toBeNull();
    const folders = sheet.querySelector<HTMLElement>('[role="switch"][id$="folders-on"]');
    await click(folders);
    expect(sheet.querySelector('[data-slot="folders-field"]')).not.toBeNull();
    // The folders start as the job's.
    expect(sheet.textContent).toContain("/var/www");
    await click(buttonByText(sheet, "Save overrides"));
    await flush(5);
    expect(body).toEqual({ overrides: { paths: ["/etc", "/var/www"] } });
    expect(slot("overrides-sheet")).toBeNull();
  });

  it("clears a machine's overrides by saving with every switch off", async () => {
    let body: unknown = null;
    opened = await openJobs("/jobs/definitions/job-srv?type=endpoint&tab=scope", {
      routes: machineRoutes({
        "PATCH /backup-jobs/job-srv/members/m1": (request) => {
          body = request.body;
          return json(endpointJob());
        },
      }),
    });
    await flush(6);
    const items = await openMenu(byLabel("Actions for FS-BERGISCH"));
    await click(items.find((item) => item.textContent === "Edit overrides"));
    await flush(8);
    const sheet = slot("overrides-sheet") as HTMLElement;
    const on = [...sheet.querySelectorAll<HTMLElement>('[role="switch"]')].filter(
      (node) => node.getAttribute("aria-checked") === "true",
    );
    expect(on.map((node) => sheet.querySelector(`label[for="${node.id}"]`)?.textContent)).toEqual([
      "Own folders",
      "Own bandwidth limit",
    ]);
    for (const node of on) {
      await click(node);
    }
    await click(buttonByText(sheet, "Save overrides"));
    await flush(5);
    expect(body).toEqual({ overrides: {} });
  });

  it("asks before removing a machine and says what becomes of it", async () => {
    opened = await openJobs("/jobs/definitions/job-srv?type=endpoint&tab=scope", {
      routes: machineRoutes({
        "DELETE /backup-jobs/job-srv/members/m3": () => json(endpointJob()),
      }),
    });
    await flush(6);
    const items = await openMenu(byLabel("Actions for DC01"));
    await click(items.find((item) => item.textContent === "Remove from job"));
    await flush(3);
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("Remove DC01 from the job?");
    expect(dialog.textContent).toContain("keeps the configuration it has now");
    await click(buttonByText(dialog, "Remove from job"));
    await flush(4);
    expect(opened.requests.some((request) => request.method === "DELETE")).toBe(true);
  });

  it("adds machines with the same picker as the editor", async () => {
    let body: unknown = null;
    opened = await openJobs("/jobs/definitions/job-srv?type=endpoint&tab=scope", {
      routes: machineRoutes({
        "GET /backup-jobs/candidates": () =>
          json({
            items: [
              {
                targetId: "m9",
                kind: "server",
                name: "NEW-SRV",
                detail: "Linux",
                status: "active",
                job: null,
              },
            ],
            total: 1,
          }),
        "POST /backup-jobs/job-srv/members": (request) => {
          body = request.body;
          return json({ mode: "selected", items: MEMBERS });
        },
      }),
    });
    await flush(6);
    await click(buttonByText(document.body, "Add"));
    await flush(6);
    const sheet = slot("add-members-sheet") as HTMLElement;
    expect(buttonByText(sheet, "Add")?.hasAttribute("disabled")).toBe(true);
    await click(sheet.querySelector('[aria-label="Select NEW-SRV"]'));
    await click(buttonByText(sheet, "Add 1 selected"));
    await flush(5);
    expect(body).toEqual({ members: [{ id: "m9" }] });
    expect(slot("add-members-sheet")).toBeNull();
  });

  it("reads the settings of the job and opens the editor from there", async () => {
    opened = await openJobs("/jobs/definitions/job-srv?type=endpoint&tab=settings", {
      routes: machineRoutes(),
    });
    await flush(6);
    const view = slot("job-settings") as HTMLElement;
    expect(view.textContent).toContain("/etc");
    expect(view.textContent).toContain("/var/www");
    expect(view.textContent).toContain("Temporary files");
    expect(view.textContent).toContain("*.bak");
    expect(view.textContent).toContain("4 GB");
    expect(view.textContent).toContain("20000 kbit/s");
    expect(view.textContent).toContain("db-dump");
    await click(buttonByText(view, "Edit"));
    await flush(8);
    expect(slot("job-editor")?.textContent).toContain("Edit Linux servers, daily");
    // The editor starts from what the job says.
    const name = [...(slot("job-editor")?.querySelectorAll("input") ?? [])].find(
      (input) => input.value === "Linux servers, daily",
    );
    expect(name).toBeDefined();
  });

  describe("time windows of the bandwidth limit", () => {
    const WINDOWS = [
      { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", kbps: 2000 },
      { days: [1, 2, 3, 4, 5], from: "22:00", to: "06:00", kbps: 0 },
    ];
    const WINDOWED = endpointJob({ settings: { ...JOB.settings, bandwidthWindows: WINDOWS } });
    const windowedRoutes = (over: Record<string, Handler> = {}) =>
      machineRoutes({
        "GET /backup-jobs/job-srv": () => json(WINDOWED),
        "GET /backup-jobs/job-srv/members": () =>
          json({
            mode: "selected",
            items: [
              member({
                targetId: "m2",
                name: "APP-SRV2",
                effective: {
                  schedule: WINDOWED.schedule,
                  verifySchedule: null,
                  settings: WINDOWED.settings,
                },
              }),
            ],
          }),
        ...over,
      });

    it("lists the windows on the settings tab, in words, with the time zone and when the limit applies", async () => {
      opened = await openJobs("/jobs/definitions/job-srv?type=endpoint&tab=settings", {
        routes: windowedRoutes(),
      });
      await flush(6);
      const view = slot("job-settings") as HTMLElement;
      const items = [...view.querySelectorAll('[data-slot="job-windows"] li')].map(
        (item) => item.textContent,
      );
      expect(items).toEqual([
        "Mon\u2013Fri, 08:00 to 18:00: 2000 kbit/s",
        "Mon\u2013Fri, 22:00 to 06:00 the next day: unlimited",
      ]);
      expect(view.textContent).toContain(
        "Read in Europe/Berlin. A limit applies when a run starts.",
      );
    });

    it("says so when a job has no windows", async () => {
      opened = await openJobs("/jobs/definitions/job-srv?type=endpoint&tab=settings", {
        routes: machineRoutes(),
      });
      await flush(6);
      const view = slot("job-settings") as HTMLElement;
      expect(view.querySelector('[data-slot="job-windows"]')).toBeNull();
      expect(view.textContent).toContain("Time windows");
      expect(view.textContent).toContain("None");
    });

    it("opens the editor on the windows of the job and sends nothing when they are left as they were", async () => {
      const patches: unknown[] = [];
      opened = await openJobs("/jobs/definitions/job-srv?type=endpoint&tab=settings", {
        routes: windowedRoutes({
          "PATCH /backup-jobs/job-srv": (request) => {
            patches.push(request.body);
            return json(WINDOWED);
          },
        }),
      });
      await flush(6);
      await click(buttonByText(slot("job-settings") as HTMLElement, "Edit"));
      await flush(8);
      const editor = slot("job-editor") as HTMLElement;
      const rows = [...editor.querySelectorAll('[data-slot="bandwidth-window"]')];
      expect(rows.map((row) => row.querySelector("h4")?.textContent)).toEqual([
        "Window 1",
        "Window 2",
      ]);
      expect(
        rows.map((row) => row.querySelector('[data-slot="window-summary"]')?.textContent),
      ).toEqual([
        "Mon\u2013Fri, 08:00 to 18:00: 2000 kbit/s",
        "Mon\u2013Fri, 22:00 to 06:00 the next day: unlimited",
      ]);
      await click(buttonByText(editor, "Save changes"));
      await flush(5);
      expect(patches).toEqual([]);
    });

    it("starts a member's own bandwidth from the job's windows, in the zone of its schedule, and sends both", async () => {
      let body: unknown = null;
      opened = await openJobs("/jobs/definitions/job-srv?type=endpoint&tab=scope", {
        routes: windowedRoutes({
          "PATCH /backup-jobs/job-srv/members/m2": (request) => {
            body = request.body;
            return json(WINDOWED);
          },
        }),
      });
      await flush(6);
      const items = await openMenu(byLabel("Actions for APP-SRV2"));
      await click(items.find((item) => item.textContent === "Edit overrides"));
      await flush(8);
      const sheet = slot("overrides-sheet") as HTMLElement;
      // Off: the job's windows apply, and the fields are not shown.
      expect(sheet.querySelector('[data-slot="bandwidth-windows"]')).toBeNull();
      expect(sheet.textContent).toContain(
        "Follows the bandwidth limit and the time windows of the job.",
      );
      await click(sheet.querySelector('[role="switch"][id$="bandwidth-on"]'));
      const field = sheet.querySelector('[data-slot="bandwidth-windows"]') as HTMLElement;
      expect(field).not.toBeNull();
      expect(field.querySelectorAll('[data-slot="bandwidth-window"]')).toHaveLength(2);
      expect(field.querySelector('[data-slot="windows-zone"]')?.textContent).toBe(
        "Times are read in Europe/Berlin, the time zone of the schedule.",
      );
      // Taking the first window away: the member's own list has one.
      await click(field.querySelector('[aria-label="Remove window 1"]'));
      await click(buttonByText(sheet, "Save overrides"));
      await flush(5);
      expect(body).toEqual({
        overrides: {
          bandwidthKbps: 20000,
          bandwidthWindows: [{ days: [1, 2, 3, 4, 5], from: "22:00", to: "06:00", kbps: 0 }],
        },
      });
    });
  });

  it("never shows a hook text the API hid", async () => {
    opened = await openJobs("/jobs/definitions/job-srv?type=endpoint&tab=settings", {
      routes: machineRoutes({
        "GET /backup-jobs/job-srv": () =>
          json(endpointJob({ settings: { ...JOB.settings, hooks: { pre: "********" } } })),
      }),
    });
    await flush(6);
    const view = slot("job-settings") as HTMLElement;
    expect(view.textContent).toContain("Set, hidden for your role.");
    expect(view.textContent).not.toContain("********");
  });

  it("lists the runs: a machine run belongs to the machine", async () => {
    opened = await openJobs("/jobs/definitions/job-srv?type=endpoint&tab=runs", {
      routes: machineRoutes(),
    });
    await flush(6);
    const row = document.querySelector("tbody tr") as HTMLElement;
    expect(row.textContent).toContain("Backup");
    expect(row.querySelector("a")?.getAttribute("href")).toBe("/inventory/m1");
  });

  it("says plainly that a job does not exist in this tenant, with the way back", async () => {
    opened = await openJobs("/jobs/definitions/nope?type=endpoint", {
      routes: {
        "GET /backup-jobs/nope": () => problem("urn:restow:problem:not-found", 404),
        "GET /backup-jobs/nope/members": () => problem("urn:restow:problem:not-found", 404),
      },
    });
    await flush(6);
    expect(text()).toContain("Job not found");
    expect(text()).toContain("does not exist in the selected tenant");
    const back = [...document.querySelectorAll("a")].find((anchor) =>
      anchor.textContent?.includes("All jobs"),
    );
    expect(back?.getAttribute("href")).toContain("/jobs");
  });

  it("closes Run now, Edit and the menu in the public demo, with the reason named at each button", async () => {
    opened = await openJobs("/jobs/definitions/job-srv?type=endpoint", {
      routes: machineRoutes(),
      demo: true,
    });
    await flush(6);
    const page = slot("job-detail") as HTMLElement;
    for (const label of ["Run now", "Edit"]) {
      const button = buttonByText(page, label) as HTMLButtonElement;
      expect(button.disabled, label).toBe(true);
      expect(describedText(button), label).toContain("This is the public demo");
    }
    const menu = byLabel("Actions for Linux servers, daily");
    expect(describedText(menu as HTMLElement)).toContain("This is the public demo");
    expect(slot("access-note")?.getAttribute("data-reason")).toBe("demo");
  });
});

describe("the page of a mail job", () => {
  const MAIL = mailJob();
  const mailRoutes = (job = MAIL) => ({
    [`GET /backup-jobs/${job.id}`]: () => json(job),
    [`GET /backup-jobs/${job.id}/members`]: () =>
      json({
        mode: job.scopeMode,
        items: [
          member({
            targetId: "o1",
            kind: "mailbox",
            name: "Anna Berg",
            detail: "anna@mueller.example.test",
            explicit: false,
            effective: { schedule: job.schedule, verifySchedule: job.verifySchedule, settings: {} },
          }),
        ],
      }),
    "GET /backup-jobs": () => json({ items: [job], uncovered: { mail: 0, endpoint: 0 } }),
    "GET /backup-jobs/defaults": () => json(defaults("mail")),
    "GET /backup-jobs/candidates": () => json({ items: [], total: 0 }),
  });

  it("offers Pause on a mail job, and Resume once it is paused", async () => {
    opened = await openJobs(`/jobs/definitions/${MAIL.id}?type=mail`, { routes: mailRoutes() });
    await flush(6);
    expect(buttonByText(slot("job-detail") as HTMLElement, "Pause")).not.toBeNull();
    await opened.mounted.unmount();
    opened = null;
    document.body.innerHTML = "";
    const paused = mailJob({ enabled: false, state: "paused" });
    opened = await openJobs(`/jobs/definitions/${paused.id}?type=mail`, {
      routes: mailRoutes(paused),
    });
    await flush(6);
    expect(buttonByText(slot("job-detail") as HTMLElement, "Resume")).not.toBeNull();
    expect(buttonByText(slot("job-detail") as HTMLElement, "Pause")).toBeNull();
    expect(slot("job-badges")?.textContent).toContain("Paused");
  });

  it("asks before pausing and says how many objects stop being backed up on a schedule", async () => {
    let body: unknown = null;
    opened = await openJobs(`/jobs/definitions/${MAIL.id}?type=mail`, {
      routes: {
        ...mailRoutes(),
        [`PATCH /backup-jobs/${MAIL.id}`]: (request) => {
          body = request.body;
          return json(mailJob({ enabled: false }));
        },
      },
    });
    await flush(6);
    await click(buttonByText(slot("job-detail") as HTMLElement, "Pause"));
    await flush(3);
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("220 objects are not backed up on a schedule");
    await click(buttonByText(dialog, "Pause job"));
    await flush(4);
    expect(body).toEqual({ enabled: false });
  });

  it("explains an 'all' job and offers neither Add nor Remove, while overrides stay possible", async () => {
    opened = await openJobs(`/jobs/definitions/${MAIL.id}?type=mail&tab=scope`, {
      routes: mailRoutes(),
    });
    await flush(6);
    expect(slot("all-note")?.textContent).toContain(
      "every mailbox, OneDrive and IMAP account that is in no other job",
    );
    expect(buttonByText(document.body, "Add")).toBeNull();
    const items = await openMenu(byLabel("Actions for Anna Berg"));
    expect(items.map((item) => item.textContent)).toEqual(["Edit overrides", "Run now"]);
  });

  it("links a mail run to its page in History", async () => {
    opened = await openJobs(`/jobs/definitions/${MAIL.id}?type=mail&tab=runs`, {
      routes: {
        ...mailRoutes(),
        [`GET /backup-jobs/${MAIL.id}/runs`]: () =>
          json({
            items: [
              {
                id: "run-7",
                source: "mail",
                type: "backup",
                status: "completed",
                targetId: "o1",
                targetName: "Anna Berg",
                startedAt: iso(-30),
                finishedAt: iso(-25),
                createdAt: iso(-31),
              },
            ],
          }),
      },
    });
    await flush(6);
    const link = document.querySelector("tbody a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/history/run-7");
    expect(link.textContent).toContain("Backup");
  });
});
