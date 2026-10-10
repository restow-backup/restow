// @vitest-environment happy-dom
import { act } from "react";
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
  type as typeInto,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { candidate, defaults, endpointJob, list, mailJob } from "../fixtures.js";
import "../i18n.js";
import { type Opened, focusOn, openJobs, press } from "../testing.js";

/**
 * The job editor: errors where they belong and announced, what is sent, the question before
 * a object is taken from another job, exclusions as chips, folders by typing, and the way
 * out (Escape asks first when something was entered).
 */

// The sign-in confirmation looks up the person's passkeys with the auth client; there is no server here.
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    passkey: { listUserPasskeys: async () => ({ data: [], error: null }) },
    signIn: { passkey: async () => ({ error: null }) },
  },
  browserSupportsPasskeys: () => false,
  needsSecondFactor: () => false,
}));

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
const editor = () => slot("job-editor") as HTMLElement;
const textOf = (node: ParentNode | null) => node?.textContent ?? "";

/** The control a label names. */
function field(label: string): HTMLInputElement {
  const found = [...editor().querySelectorAll("label")].find(
    (candidateLabel) => candidateLabel.textContent?.trim() === label,
  );
  const control = found ? document.getElementById(found.htmlFor) : null;
  if (!control) throw new Error(`no field ${label}`);
  return control as HTMLInputElement;
}

const MAIL_ROUTES = {
  "GET /backup-jobs": () => json(list([mailJob()])),
  "GET /backup-jobs/defaults": () => json(defaults("mail")),
  "GET /backup-jobs/candidates": () =>
    json({
      items: [
        candidate({
          targetId: "o1",
          kind: "mailbox",
          name: "Anna Berg",
          detail: "anna@mueller.example.test",
        }),
        candidate({
          targetId: "o2",
          kind: "mailbox",
          name: "Ben Koch",
          detail: "ben@mueller.example.test",
        }),
        candidate({
          targetId: "o3",
          kind: "onedrive",
          name: "Buchhaltung",
          detail: "buchhaltung@mueller.example.test",
          job: { id: "j9", name: "Old job" },
        }),
      ],
      total: 3,
    }),
};

const ENDPOINT_ROUTES = {
  "GET /backup-jobs": () => json(list([endpointJob()])),
  "GET /backup-jobs/defaults": () => json(defaults("endpoint")),
  "GET /backup-jobs/candidates": () =>
    json({
      items: [
        candidate({ targetId: "m1", name: "FS-BERGISCH" }),
        candidate({ targetId: "m2", name: "APP-SRV2" }),
      ],
      total: 2,
    }),
};

type Handler = (request: RecordedRequest) => Response | Promise<Response>;

async function open(url: string, routes: Record<string, Handler>, demo = false) {
  opened = await openJobs(url, { routes, demo });
  await flush(8);
  expect(slot("job-editor")).not.toBeNull();
}

/** Whether the editor asked the server to create a job (the schedule preview is a POST too). */
const created = () =>
  opened?.requests.some(
    (request) => request.method === "POST" && request.path === "/backup-jobs",
  ) ?? false;

const checkbox = (name: string) =>
  editor().querySelector<HTMLElement>(`[aria-label="Select ${name}"]`) as HTMLElement;

describe("opening the editor", () => {
  it("puts the focus on the name, so a person can start typing", async () => {
    await open("/jobs?type=mail&new=1", MAIL_ROUTES);
    expect(document.activeElement).toBe(field("Name"));
    // And the sheet is a dialog with a title and a description.
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog?.getAttribute("aria-describedby")).toBeTruthy();
  });
});

describe("saving a new mail job", () => {
  it("names the field to correct, announces it, puts the focus on the summary and sends nothing", async () => {
    await open("/jobs?type=mail&new=1", MAIL_ROUTES);
    await click(buttonByText(editor(), "Create job"));
    await flush(3);
    const name = field("Name");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    const message = document.getElementById(name.getAttribute("aria-describedby") ?? "");
    expect(message?.getAttribute("role")).toBe("alert");
    expect(message?.textContent).toBe("Enter a name for the job.");
    const summary = slot("editor-summary");
    expect(summary?.querySelector('[role="alert"]')?.textContent).toContain(
      "Some fields need a correction",
    );
    expect(document.activeElement).toBe(summary);
    expect(created()).toBe(false);
  });

  it("sends the name, the schedules, the policy and the chosen objects", async () => {
    let body: unknown = null;
    await open("/jobs?type=mail&new=1", {
      ...MAIL_ROUTES,
      "POST /backup-jobs": (request) => {
        body = request.body;
        return json(mailJob({ id: "new", name: "Board" }), 201);
      },
    });
    await typeInto(field("Name"), "Board");
    await click(checkbox("Anna Berg"));
    await click(checkbox("Ben Koch"));
    await click(buttonByText(editor(), "Create job"));
    await flush(5);
    expect(body).toMatchObject({
      kind: "mail",
      name: "Board",
      schedule: { kind: "interval", intervalMinutes: 480, timeZone: "Europe/Berlin" },
      verifySchedule: { kind: "cron", cron: "0 3 * * 0", timeZone: "Europe/Berlin" },
      retentionPolicyId: null,
      settings: {},
      enabled: true,
      scope: { mode: "selected", members: [{ id: "o1" }, { id: "o2" }] },
    });
    expect(body).not.toHaveProperty("moveMembers");
    expect(body).not.toHaveProperty("archive");
    // The editor closes and the address drops the editor.
    expect(slot("job-editor")).toBeNull();
    expect(opened?.where().search).toEqual({ type: "mail" });
  });

  it("archives the mailboxes on request, warns without Object Lock and says that capture needs Business", async () => {
    let body: unknown = null;
    await open("/jobs?type=mail&new=1", {
      ...MAIL_ROUTES,
      "POST /backup-jobs": (request) => {
        body = request.body;
        return json(mailJob({ id: "new", name: "Archived" }), 201);
      },
    });
    expect(slot("archive-object-lock")).toBeNull();
    await typeInto(field("Name"), "Archived");
    await click(field("Archive this job's mailboxes"));
    // The fixture's repository is an S3 bucket without Object Lock.
    expect(slot("archive-object-lock")?.textContent).toContain("no Object Lock");
    // No extension in this build: the core's own note.
    expect(slot("archive-edition")?.textContent).toContain("Business edition");
    await click(buttonByText(editor(), "Create job"));
    await flush(5);
    expect(body).toMatchObject({ kind: "mail", name: "Archived", archive: true });
  });

  it("covers everything by default when no other job does, and offers that choice only then", async () => {
    await open("/jobs?type=mail&new=1", {
      ...MAIL_ROUTES,
      "GET /backup-jobs": () => json(list([])),
    });
    expect(field("All objects that are in no other job").getAttribute("aria-checked")).toBe("true");
    expect(textOf(editor())).toContain("The job covers every active mailbox");
    // No picker while the job covers all.
    expect(editor().querySelector('[data-slot="member-picker"]')).toBeNull();
  });

  it("does not offer 'all' while another job covers all objects that are in no job", async () => {
    await open("/jobs?type=mail&new=1", MAIL_ROUTES);
    const all = field("All objects that are in no other job");
    expect(all.hasAttribute("disabled")).toBe(true);
    expect(textOf(editor())).toContain(
      "Another job already covers all objects that are in no job.",
    );
    expect(editor().querySelector('[data-slot="member-picker"]')).not.toBeNull();
  });

  it("shows what the server said at the field it names, in the server's words when it has no text", async () => {
    await open("/jobs?type=mail&new=1", {
      ...MAIL_ROUTES,
      "POST /backup-jobs": () =>
        problem("urn:restow:problem:invalid-backup-job", 422, {
          field: "name",
          issues: [{ path: ["name"], code: "taken", message: "A job with this name exists." }],
        }),
    });
    await typeInto(field("Name"), "Board");
    await click(buttonByText(editor(), "Create job"));
    await flush(5);
    const name = field("Name");
    const message = document.getElementById(name.getAttribute("aria-describedby") ?? "");
    expect(message?.getAttribute("role")).toBe("alert");
    expect(message?.textContent).toBe("A job with this name exists.");
    // Typing in the field takes the message away: the person is already on it.
    await typeInto(name, "Board 2");
    expect(
      document.getElementById(name.getAttribute("aria-describedby") ?? "")?.getAttribute("role"),
    ).toBeNull();
  });

  it("puts a schedule the server refused at the cadence field, in the schedules' words", async () => {
    await open("/jobs?type=mail&new=1", {
      ...MAIL_ROUTES,
      "POST /backup-jobs": () =>
        problem("urn:restow:problem:invalid-backup-job", 422, {
          field: "schedule",
          issues: [
            { path: ["schedule", "intervalMinutes"], code: "interval_out_of_range", message: "x" },
          ],
        }),
    });
    await typeInto(field("Name"), "Board");
    await click(buttonByText(editor(), "Create job"));
    await flush(5);
    expect(textOf(editor())).toContain("The interval must be between 15 minutes and 31 days.");
  });
});

describe("a machine schedule the server refused", () => {
  const refuse = (path: string[], code: string) => ({
    ...ENDPOINT_ROUTES,
    "POST /backup-jobs": () =>
      problem("urn:restow:problem:invalid-backup-job", 422, {
        field: "schedule",
        issues: [{ path, code, message: "The server's words." }],
      }),
  });

  it("shows it at the field it names", async () => {
    await open(
      "/jobs?type=endpoint&new=1&select=m1",
      refuse(["schedule", "timeOfDay"], "time_of_day_invalid"),
    );
    await typeInto(field("Name"), "Servers");
    await click(buttonByText(editor(), "Create job"));
    await flush(5);
    const time = field("Time of day");
    expect(document.getElementById(time.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Use a time such as 02:30.",
    );
  });

  it("says it under the schedule when the field it names is not on screen", async () => {
    await open(
      "/jobs?type=endpoint&new=1&select=m1",
      refuse(["schedule", "intervalMinutes"], "interval_out_of_range"),
    );
    await typeInto(field("Name"), "Servers");
    await click(buttonByText(editor(), "Create job"));
    await flush(5);
    const section = [...editor().querySelectorAll('[data-slot="editor-section"]')].find(
      (candidateSection) => candidateSection.querySelector("h3")?.textContent === "Schedule",
    );
    expect(section?.querySelector('[role="alert"]')?.textContent).toBe(
      "The interval is out of range.",
    );
  });
});

describe("taking objects from another job", () => {
  it("says which job an object is in and takes it only after the person confirms", async () => {
    let body: unknown = null;
    await open("/jobs?type=mail&new=1", {
      ...MAIL_ROUTES,
      "POST /backup-jobs": (request) => {
        body = request.body;
        return json(mailJob({ id: "new" }), 201);
      },
    });
    expect(textOf(editor())).toContain("In Old job");
    expect(checkbox("Buchhaltung").hasAttribute("disabled")).toBe(true);
    await click(buttonByText(editor(), "Move here"));
    await flush(3);
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Move Buchhaltung to this job?");
    expect(dialog?.textContent).toContain("It leaves Old job");
    await click(buttonByText(dialog as HTMLElement, "Move here"));
    await flush(3);
    expect(textOf(editor())).toContain("Moves from Old job");
    expect(checkbox("Buchhaltung").getAttribute("aria-checked")).toBe("true");
    await typeInto(field("Name"), "Moved");
    await click(buttonByText(editor(), "Create job"));
    await flush(5);
    expect(body).toMatchObject({ moveMembers: true, scope: { members: [{ id: "o3" }] } });
  });

  it("asks once more when the server says another administrator took them meanwhile", async () => {
    const bodies: unknown[] = [];
    await open("/jobs?type=endpoint&new=1&select=m1", {
      ...ENDPOINT_ROUTES,
      "POST /backup-jobs": (request) => {
        bodies.push(request.body);
        return bodies.length === 1
          ? problem("urn:restow:problem:backup-job-member-in-other-job", 409, {
              conflicts: [{ targetId: "m1", jobId: "j9", jobName: "Old servers" }],
            })
          : json(endpointJob({ id: "new" }), 201);
      },
    });
    await typeInto(field("Name"), "Servers");
    await click(buttonByText(editor(), "Create job"));
    await flush(5);
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("1 object is in another job");
    expect(dialog?.querySelector('[data-slot="conflict-list"]')?.textContent).toContain(
      "FS-BERGISCH is in Old servers",
    );
    await click(buttonByText(dialog as HTMLElement, "Move here and save"));
    await flush(5);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toHaveProperty("moveMembers");
    expect(bodies[1]).toMatchObject({ moveMembers: true });
    expect(slot("job-editor")).toBeNull();
  });
});

describe("a machine job", () => {
  it("shows folders, exclusions, bandwidth and retention, with the commands behind Advanced", async () => {
    await open("/jobs?type=endpoint&new=1", ENDPOINT_ROUTES);
    for (const title of ["Folders", "Exclusions", "Bandwidth", "Retention", "Repository"]) {
      expect(
        [...editor().querySelectorAll("h3")].some((heading) => heading.textContent === title),
        title,
      ).toBe(true);
    }
    // The bandwidth limit is a section of its own; its time windows live there too.
    const bandwidth = [...editor().querySelectorAll('[data-slot="editor-section"]')].find(
      (section) => section.querySelector("h3")?.textContent === "Bandwidth",
    );
    expect(bandwidth?.querySelector("input")).not.toBeNull();
    // The commands are behind a disclosure that is closed.
    const advanced = buttonByText(editor(), /^Advanced/);
    expect(advanced?.getAttribute("aria-expanded")).toBe("false");
    expect(editor().querySelector('[data-slot="hooks-field"]')).toBeNull();
    await click(advanced);
    expect(advanced?.getAttribute("aria-expanded")).toBe("true");
    expect(editor().querySelector('[data-slot="hooks-field"]')?.textContent).toContain(
      "These commands run with full rights",
    );
    // Only exclusions: said once, plainly.
    expect(textOf(editor())).toContain("a backup cannot be limited to chosen file types");
    // The size limit says which agent it needs, and no longer that it has no effect yet.
    expect(textOf(editor())).toContain("Needs agent version 0.2.0 or later on the machine");
    expect(textOf(editor())).not.toContain("An agent without support for this limit");
    expect(textOf(editor())).toContain("Every backup job writes to the primary repository");
  });

  it("switches exclusion chips on and off, and each chip says it is pressed", async () => {
    await open("/jobs?type=endpoint&new=1", ENDPOINT_ROUTES);
    const chip = (name: string) => buttonByText(editor(), name) as HTMLButtonElement;
    expect(chip("Videos").getAttribute("aria-pressed")).toBe("false");
    await click(chip("Videos"));
    expect(chip("Videos").getAttribute("aria-pressed")).toBe("true");
    expect(chip("Music").getAttribute("aria-pressed")).toBe("false");
    await click(chip("Videos"));
    expect(chip("Videos").getAttribute("aria-pressed")).toBe("false");
    await click(chip("Temporary files"));
    expect(chip("Temporary files").getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the patterns that belong to no chip as own patterns and takes them out again", async () => {
    await open("/jobs?type=endpoint&new=1", ENDPOINT_ROUTES);
    const input = field("Own patterns");
    await typeInto(input, "*.bak");
    await press(input, "Enter");
    await flush(2);
    const list = editor().querySelector('[aria-label="Own patterns of this job"]');
    expect(textOf(list)).toContain("*.bak");
    await click(list?.querySelector('[aria-label="Remove *.bak"]'));
    expect(
      editor().querySelector('[aria-label="Own patterns of this job"]')?.textContent ?? "",
    ).not.toContain("*.bak");
    await typeInto(input, "bad\u0007pattern");
    await press(input, "Enter");
    await flush(2);
    expect(textOf(editor())).toContain("A pattern cannot contain control characters");
  });

  it("checks a typed folder: absolute, and lets a valid one in as a chip that can be removed", async () => {
    await open("/jobs?type=endpoint&new=1", ENDPOINT_ROUTES);
    const input = field("Folders");
    await typeInto(input, "relative/dir");
    await press(input, "Enter");
    await flush(2);
    const message = document.getElementById(input.getAttribute("aria-describedby") ?? "");
    expect(message?.getAttribute("role")).toBe("alert");
    expect(message?.textContent).toContain("Use an absolute path");
    await typeInto(input, "/srv/data/");
    await press(input, "Enter");
    await flush(2);
    const chosen = editor().querySelector('[aria-label="Chosen folders"]');
    expect(textOf(chosen)).toContain("/srv/data");
    expect(textOf(chosen)).not.toContain("/srv/data/");
    await click(chosen?.querySelector('[aria-label="Remove /srv/data"]'));
    expect(textOf(editor().querySelector('[aria-label="Chosen folders"]'))).not.toContain(
      "/srv/data",
    );
  });

  it("says that at least one folder is needed, and a bad bandwidth, when saving", async () => {
    await open("/jobs?type=endpoint&new=1", ENDPOINT_ROUTES);
    for (const remove of [...editor().querySelectorAll('[aria-label^="Remove /"]')]) {
      await click(remove);
    }
    await typeInto(field("Name"), "Servers");
    await typeInto(field("Upload limit (kbit/s)"), "0");
    await click(buttonByText(editor(), "Create job"));
    await flush(3);
    expect(textOf(editor())).toContain("Add at least one folder.");
    expect(textOf(editor())).toContain("Choose a number between 1 and 10000000.");
    expect(created()).toBe(false);
  });

  it("reads the folders from the newest backup of a machine of the scope", async () => {
    await open("/jobs?type=endpoint&new=1&select=m1", {
      ...ENDPOINT_ROUTES,
      "GET /endpoints/m1/snapshots": () =>
        json({
          items: [
            { id: "old", shortId: "old", time: "2026-10-01T00:00:00.000Z" },
            { id: "new", shortId: "new", time: "2026-10-02T00:00:00.000Z" },
          ],
        }),
      "GET /endpoints/m1/browse": () =>
        json({
          snapshotId: "new",
          path: "/",
          entries: [{ name: "srv", path: "/srv", type: "dir", size: null, mtime: null }],
          nextCursor: null,
        }),
    });
    await click(buttonByText(editor(), "Choose from a backup"));
    await flush(8);
    expect(textOf(slot("folder-source"))).toContain(
      "Folders from the newest backup of FS-BERGISCH",
    );
    const tree = editor().querySelector('[role="tree"]');
    expect(tree?.querySelector('[role="treeitem"]')?.getAttribute("data-path")).toBe("/srv");
    const browse = opened?.requests.find((request) => request.path === "/endpoints/m1/browse");
    expect(browse).toBeDefined();
    await focusOn(tree?.querySelector('[role="treeitem"]'));
    await press(tree?.querySelector('[role="treeitem"]'), " ");
    expect(textOf(editor().querySelector('[aria-label="Chosen folders"]'))).toContain("/srv");
  });

  it("says that a machine has no backup yet and shows its configured folders instead", async () => {
    await open("/jobs?type=endpoint&new=1&select=m1", {
      ...ENDPOINT_ROUTES,
      "GET /endpoints/m1/snapshots": () => json({ items: [] }),
      "GET /endpoints/m1": () => json({ id: "m1", config: { paths: ["/opt/app"] } }),
    });
    await click(buttonByText(editor(), "Choose from a backup"));
    await flush(8);
    expect(textOf(slot("folder-source"))).toContain("FS-BERGISCH has no backup yet");
    expect(editor().querySelector('[role="treeitem"]')?.getAttribute("data-path")).toBe("/opt/app");
  });
});

describe("leaving the editor", () => {
  it("closes at once with Escape when nothing was entered", async () => {
    await open("/jobs?type=mail&new=1", MAIL_ROUTES);
    await press(document.activeElement ?? editor(), "Escape");
    await flush(5);
    expect(slot("job-editor")).toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("asks first with Escape when something was entered, and keeps the entries on 'Keep editing'", async () => {
    await open("/jobs?type=mail&new=1", MAIL_ROUTES);
    await typeInto(field("Name"), "Board");
    await press(document.activeElement ?? editor(), "Escape");
    await flush(3);
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Discard your changes?");
    await click(buttonByText(dialog as HTMLElement, "Keep editing"));
    await flush(3);
    expect(slot("job-editor")).not.toBeNull();
    expect(field("Name").value).toBe("Board");
    await press(document.activeElement ?? editor(), "Escape");
    await flush(3);
    await click(
      buttonByText(
        document.querySelector('[role="alertdialog"]') as HTMLElement,
        "Discard changes",
      ),
    );
    await flush(5);
    expect(slot("job-editor")).toBeNull();
  });

  it("asks first on Cancel too", async () => {
    await open("/jobs?type=mail&new=1", MAIL_ROUTES);
    await typeInto(field("Name"), "Board");
    await click(buttonByText(editor(), "Cancel"));
    await flush(3);
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Discard your changes?",
    );
  });
});

describe("time windows of the bandwidth limit", () => {
  const section = () =>
    [...editor().querySelectorAll<HTMLElement>('[data-slot="editor-section"]')].find(
      (candidateSection) => candidateSection.querySelector("h3")?.textContent === "Bandwidth",
    ) as HTMLElement;
  const rows = () => [...editor().querySelectorAll<HTMLElement>('[data-slot="bandwidth-window"]')];
  /** The control a label names, inside one row. */
  const inRow = (row: HTMLElement, label: string) => {
    const found = [...row.querySelectorAll("label")].find(
      (candidateLabel) => candidateLabel.textContent?.trim() === label,
    );
    const control = found ? document.getElementById(found.htmlFor) : null;
    if (!control) throw new Error(`no field ${label} in the row`);
    return control as HTMLInputElement;
  };
  const addWindow = () => click(buttonByText(section(), "Add time window"));
  const dayButtons = (row: HTMLElement) => [
    ...row.querySelectorAll<HTMLButtonElement>('[data-slot="toggle-group-item"]'),
  ];
  const summaryOf = (row: HTMLElement) =>
    row.querySelector('[data-slot="window-summary"]')?.textContent ?? null;

  async function openEndpointEditor(routes: Record<string, Handler> = {}) {
    await open("/jobs?type=endpoint&new=1&select=m1", { ...ENDPOINT_ROUTES, ...routes });
  }

  it("sits in the bandwidth section, says that a limit applies when a run starts and in which time zone, and starts empty", async () => {
    await openEndpointEditor();
    const bandwidth = section();
    expect(bandwidth.querySelector('[data-slot="bandwidth-windows"]')).not.toBeNull();
    expect(textOf(bandwidth)).toContain("Time windows");
    expect(textOf(bandwidth)).toContain("A limit applies when a run starts.");
    expect(textOf(bandwidth)).toContain(
      "The limit that applies when a run starts is used for that whole run.",
    );
    expect(textOf(bandwidth.querySelector('[data-slot="windows-zone"]'))).toBe(
      "Times are read in Europe/Berlin, the time zone of the schedule.",
    );
    expect(textOf(bandwidth)).toContain("No time windows: the limit above applies at all times.");
    expect(rows()).toHaveLength(0);
    // The rules are said, not left to be found out.
    expect(textOf(bandwidth)).toContain("An end that is not after the start ends on the next day");
    expect(textOf(bandwidth)).toContain("Windows must not overlap");
  });

  it("adds a window with a button, puts the focus on its first field and describes it in words once it is complete", async () => {
    await openEndpointEditor();
    await addWindow();
    const [row] = rows();
    expect(row).toBeDefined();
    const window = row as HTMLElement;
    expect(window.querySelector("h4")?.textContent).toBe("Window 1");
    // Working days, office hours, and the focus on the first time field.
    expect(dayButtons(window).map((button) => button.getAttribute("aria-pressed"))).toEqual([
      "true",
      "true",
      "true",
      "true",
      "true",
      "false",
      "false",
    ]);
    expect(inRow(window, "From").value).toBe("08:00");
    expect(inRow(window, "Until").value).toBe("18:00");
    expect(document.activeElement).toBe(inRow(window, "From"));
    // The limit is not chosen yet, so there is nothing to describe.
    expect(summaryOf(window)).toBeNull();
    await typeInto(inRow(window, "Limit (kbit/s)"), "2000");
    expect(summaryOf(window)).toBe("Mon\u2013Fri, 08:00 to 18:00: 2000 kbit/s");
    // A window that runs past midnight says that it ends on the next day, and 0 is unlimited.
    await typeInto(inRow(window, "From"), "22:00");
    await typeInto(inRow(window, "Until"), "06:00");
    await typeInto(inRow(window, "Limit (kbit/s)"), "0");
    expect(summaryOf(window)).toBe("Mon\u2013Fri, 22:00 to 06:00 the next day: unlimited");
    // The same time twice is 24 hours.
    await typeInto(inRow(window, "Until"), "22:00");
    expect(summaryOf(window)).toBe("Mon\u2013Fri, 24 hours from 22:00: unlimited");
  });

  it("switches days like buttons that say they are pressed, each named by its day", async () => {
    await openEndpointEditor();
    await addWindow();
    const window = rows()[0] as HTMLElement;
    const group = window.querySelector('[data-slot="toggle-group"]');
    // The group is named by the sentence above it, and every day by its full name.
    expect(group?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.getElementById(group?.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(
      "Days it starts on",
    );
    expect(dayButtons(window).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]);
    const [monday, , , , friday, saturday, sunday] = dayButtons(window);
    await click(saturday);
    await click(sunday);
    await click(monday);
    await click(friday);
    expect(dayButtons(window).map((button) => button.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
      "true",
      "true",
      "false",
      "true",
      "true",
    ]);
    await typeInto(inRow(window, "Limit (kbit/s)"), "500");
    expect(summaryOf(window)).toBe("Tue\u2013Thu, Sat, Sun, 08:00 to 18:00: 500 kbit/s");
  });

  it("is one tab stop per row for the days, and the arrow keys move between them", async () => {
    await openEndpointEditor();
    await addWindow();
    const window = rows()[0] as HTMLElement;
    const days = dayButtons(window);
    // Roving focus: the seven days are one stop for Tab (the group takes it, then hands it to a day).
    const group = window.querySelector('[data-slot="toggle-group"]') as HTMLElement;
    const stops = [group, ...days].filter((node) => node.getAttribute("tabindex") === "0");
    expect(stops).toEqual([group]);
    const [monday, tuesday] = days as [HTMLButtonElement, HTMLButtonElement];
    await focusOn(monday);
    // The group moves the focus on the next turn of the event loop.
    await press(monday, "ArrowRight");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.activeElement).toBe(tuesday);
    await press(tuesday, "ArrowLeft");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.activeElement).toBe(monday);
    // Every other control of the row is a native input or button: the time fields, the limit, the remove button.
    for (const label of ["From", "Until", "Limit (kbit/s)"]) {
      expect(inRow(window, label).tabIndex).toBeGreaterThanOrEqual(0);
    }
    expect(
      (editor().querySelector('[aria-label="Remove window 1"]') as HTMLButtonElement).tagName,
    ).toBe("BUTTON");
  });

  it("removes a window and gives the focus to the button that adds one", async () => {
    await openEndpointEditor();
    await addWindow();
    await addWindow();
    expect(rows().map((row) => row.querySelector("h4")?.textContent)).toEqual([
      "Window 1",
      "Window 2",
    ]);
    // The button of the first row names it.
    await click(editor().querySelector('[aria-label="Remove window 1"]'));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.querySelector("h4")?.textContent).toBe("Window 1");
    expect(document.activeElement).toBe(buttonByText(section(), "Add time window"));
    await click(editor().querySelector('[aria-label="Remove window 1"]'));
    expect(rows()).toHaveLength(0);
    expect(textOf(section())).toContain("No time windows");
  });

  it("stops at 24 windows and says so", async () => {
    await openEndpointEditor();
    for (let count = 0; count < 24; count++) {
      await addWindow();
    }
    expect(rows()).toHaveLength(24);
    expect((buttonByText(section(), "Add time window") as HTMLButtonElement).disabled).toBe(true);
    expect(textOf(section())).toContain("At most 24 time windows.");
  }, 30_000);

  it("names what is wrong at the row when saving: a missing limit and windows that overlap", async () => {
    await openEndpointEditor();
    await typeInto(field("Name"), "Servers");
    await addWindow();
    await addWindow();
    const [first, second] = rows() as [HTMLElement, HTMLElement];
    // Window 2 shares Monday to Friday 17:00 to 19:00 with window 1 (08:00 to 18:00); window 1 has no limit yet.
    await typeInto(inRow(second, "From"), "17:00");
    await typeInto(inRow(second, "Until"), "19:00");
    await typeInto(inRow(second, "Limit (kbit/s)"), "100");
    await click(buttonByText(editor(), "Create job"));
    await flush(3);
    expect(created()).toBe(false);
    // The missing limit is said at its field, as an alert the field points to.
    const limit = inRow(first, "Limit (kbit/s)");
    const message = document.getElementById(limit.getAttribute("aria-describedby") ?? "");
    expect(message?.getAttribute("role")).toBe("alert");
    expect(message?.textContent).toBe("Enter a limit; 0 means unlimited.");
    expect(limit.getAttribute("aria-invalid")).toBe("true");
    // The overlap is said on the later window, naming the other.
    expect(textOf(second.querySelector('[data-slot="window-overlap"]'))).toBe(
      "This window overlaps window 1. Let one end where the other starts.",
    );
    expect(second.querySelector('[data-slot="window-overlap"]')?.getAttribute("role")).toBe(
      "alert",
    );
    // And the summary at the top says that something needs fixing.
    expect(textOf(editor().querySelector('[data-slot="editor-summary"]'))).toContain(
      "Some fields need a correction",
    );
    // Correcting the first row's limit and the second row's times lets the job go.
    await typeInto(limit, "2000");
    await typeInto(inRow(second, "From"), "18:00");
    await click(buttonByText(editor(), "Create job"));
    await flush(3);
    expect(created()).toBe(true);
  });

  it("asks for at least one day", async () => {
    await openEndpointEditor();
    await typeInto(field("Name"), "Servers");
    await addWindow();
    const row = rows()[0] as HTMLElement;
    for (const button of dayButtons(row).filter(
      (candidateButton) => candidateButton.getAttribute("aria-pressed") === "true",
    )) {
      await click(button);
    }
    await typeInto(inRow(row, "Limit (kbit/s)"), "100");
    await click(buttonByText(editor(), "Create job"));
    await flush(3);
    expect(created()).toBe(false);
    const alert = row.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Choose at least one day.");
  });

  it("checks the times and the limit", async () => {
    await openEndpointEditor();
    await typeInto(field("Name"), "Servers");
    await addWindow();
    const row = rows()[0] as HTMLElement;
    await typeInto(inRow(row, "From"), "");
    await typeInto(inRow(row, "Limit (kbit/s)"), "fast");
    await click(buttonByText(editor(), "Create job"));
    await flush(3);
    expect(created()).toBe(false);
    expect(textOf(row)).toContain("Enter a time such as 08:00.");
    expect(textOf(row)).toContain("Enter a whole number of kbit/s from 0 (unlimited) to 10000000.");
  });

  it("sends the windows in the order of the week with the default limit, and none when there are none", async () => {
    const bodies: Record<string, unknown>[] = [];
    await openEndpointEditor({
      "POST /backup-jobs": (request) => {
        bodies.push(request.body as Record<string, unknown>);
        return json(endpointJob({ id: "new" }), 201);
      },
    });
    await typeInto(field("Name"), "Servers");
    await typeInto(field("Upload limit (kbit/s)"), "500");
    await addWindow();
    await addWindow();
    const [first, second] = rows() as [HTMLElement, HTMLElement];
    // The night window is entered first; the office window sorts before it.
    await typeInto(inRow(first, "From"), "22:00");
    await typeInto(inRow(first, "Until"), "06:00");
    await typeInto(inRow(first, "Limit (kbit/s)"), "0");
    await typeInto(inRow(second, "Limit (kbit/s)"), "2000");
    await click(buttonByText(editor(), "Create job"));
    await flush(5);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      settings: {
        bandwidthKbps: 500,
        bandwidthWindows: [
          { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", kbps: 2000 },
          { days: [1, 2, 3, 4, 5], from: "22:00", to: "06:00", kbps: 0 },
        ],
      },
    });
  });

  it("does not send the key at all for a job without windows", async () => {
    const sent: { settings?: Record<string, unknown> }[] = [];
    await openEndpointEditor({
      "POST /backup-jobs": (request) => {
        sent.push(request.body as { settings?: Record<string, unknown> });
        return json(endpointJob({ id: "new" }), 201);
      },
    });
    await typeInto(field("Name"), "Servers");
    await click(buttonByText(editor(), "Create job"));
    await flush(5);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.settings).not.toHaveProperty("bandwidthWindows");
  });

  it("shows what the server refused at the windows, in the viewer's language", async () => {
    await openEndpointEditor({
      "POST /backup-jobs": () =>
        problem("urn:restow:problem:invalid-backup-job", 422, {
          field: "settings",
          code: "bandwidth_window_overlap",
          issues: [
            {
              path: ["settings", "bandwidthWindows", "1", "window"],
              code: "bandwidth_window_overlap",
              message: "This time window overlaps window 1.",
            },
          ],
        }),
    });
    await typeInto(field("Name"), "Servers");
    await addWindow();
    await typeInto(inRow(rows()[0] as HTMLElement, "Limit (kbit/s)"), "100");
    await click(buttonByText(editor(), "Create job"));
    await flush(5);
    const windows = editor().querySelector('[data-slot="bandwidth-windows"]');
    expect(textOf(windows)).toContain(
      "Two time windows overlap. Let one end where the other starts.",
    );
    expect(windows?.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe("a change that needs a recent sign-in", () => {
  it("asks the person to confirm it is them, then repeats the save", async () => {
    let posts = 0;
    await open("/jobs?type=endpoint&new=1&select=m1", {
      ...ENDPOINT_ROUTES,
      "POST /backup-jobs": () => {
        posts += 1;
        return posts === 1
          ? problem("urn:restow:problem:recent-sign-in-required", 403)
          : json(endpointJob({ id: "new" }), 201);
      },
    });
    await typeInto(field("Name"), "Servers");
    await click(buttonByText(editor(), "Create job"));
    await flush(5);
    expect(document.body.textContent).toContain("Confirm it is you");
    expect(posts).toBe(1);
    expect(slot("job-editor")).not.toBeNull();
  });
});
