// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { OTHER_ID, SHARE_ID, listFixture, shareFixture } from "@/features/file-shares/fixtures";
import {
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  problem,
  type,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { COPY_CONFIRM_PROBLEM, COPY_UNSAFE_TARGET_PROBLEM, type JobDefaults } from "../api.js";
import { candidate, defaults, endpointJob, list } from "../fixtures.js";
import "../i18n.js";
import { type Opened, openJobs, openMenu } from "../testing.js";

/**
 * The editors of file share jobs and copy jobs (docs/FILESHARES.md 12.5, 12.6), opened from the
 * address the share pages link to: the shares with folders picked from a live browser, the
 * schedule and what is left out; and a copy job with its badge, its source and target from the
 * address, and the mirror that is confirmed by typing the folder.
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
const action = (name: string) => document.querySelector<HTMLElement>(`[data-action="${name}"]`);

function field(scope: ParentNode, label: string): HTMLInputElement {
  const element = [...scope.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const input = element ? document.getElementById(element.htmlFor) : null;
  if (!input) throw new Error(`no field "${label}"`);
  return input as HTMLInputElement;
}

function shareDefaults(kind: "share" | "copy"): JobDefaults {
  return {
    ...defaults("endpoint"),
    kind,
    schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
    settings: { retention: { keepDaily: 14, keepWeekly: 8, keepMonthly: 6 } },
  } as JobDefaults;
}

const posts = () =>
  (opened?.requests ?? []).filter(
    (request) => request.method === "POST" && request.path === "/backup-jobs",
  );

describe("the file share job editor", () => {
  it("starts with the share of the address, picks its folders live and saves what the API takes", async () => {
    opened = await openJobs(`/jobs?type=share&new=1&select=${SHARE_ID}`, {
      routes: {
        "GET /backup-jobs": () => json(list([])),
        "GET /backup-jobs/defaults": () => json(shareDefaults("share")),
        "GET /backup-jobs/candidates": () =>
          json({
            items: [
              candidate({
                targetId: SHARE_ID,
                kind: "smb",
                name: "Projects",
                detail: "\\\\files\\Projects",
              }),
              candidate({
                targetId: OTHER_ID,
                kind: "nfs",
                name: "Archive",
                detail: "nas:/archive",
              }),
            ],
            total: 2,
          }),
        [`GET /file-shares/${SHARE_ID}/source`]: () =>
          json({
            ok: true,
            path: "",
            entries: [
              { name: "Finance", type: "dir", size: 0, mtime: "2026-10-01T00:00:00.000Z" },
              { name: "Marketing", type: "dir", size: 0, mtime: "2026-10-01T00:00:00.000Z" },
            ],
            truncated: false,
            cause: null,
            failure: null,
            params: {},
            detail: null,
          }),
        "POST /backup-jobs": (request) =>
          json(
            endpointJob({
              id: "job-new",
              kind: "share",
              name: (request.body as { name: string }).name,
            }),
            201,
          ),
      },
    });
    await flush(8);
    const editor = slot("share-job-editor") as HTMLElement;
    expect(editor.textContent).toContain("New file share job");
    expect(
      editor.querySelector('[aria-label="Select Projects"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      editor.querySelector('[aria-label="Select Archive"]')?.getAttribute("aria-checked"),
    ).toBe("false");
    // The preset list is shown under its switch.
    expect(slot("preset-list")?.textContent).toContain("Thumbs.db");

    await type(field(editor, "Name"), "File server, nightly");
    await click(action("pick-folders"));
    await flush(3);
    await click(editor.querySelector('[aria-label="Include Finance"]'));
    await type(editor.querySelector('input[placeholder="iso"]'), ".ISO");
    await click(action("add-file-type"));
    await click(editor.querySelector('[role="radio"][value="interval"]'));
    await type(field(editor, "Every how many hours"), "6");
    await click(action("save-share-job"));
    await flush(3);

    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.body).toMatchObject({
      kind: "share",
      name: "File server, nightly",
      schedule: { kind: "interval", intervalMinutes: 360, timeZone: "Europe/Berlin" },
      scope: {
        mode: "selected",
        members: [{ id: SHARE_ID, overrides: { includes: ["Finance"] } }],
      },
      settings: {
        presets: { systemFiles: true },
        fileTypes: { exclude: ["ISO"] },
        skipOffline: true,
        retention: { keepDaily: 14, keepWeekly: 8, keepMonthly: 6 },
      },
    });
  });

  it("refuses an interval below an hour before asking the API", async () => {
    opened = await openJobs("/jobs?type=share&new=1", {
      routes: {
        "GET /backup-jobs": () => json(list([])),
        "GET /backup-jobs/defaults": () => json(shareDefaults("share")),
        "GET /backup-jobs/candidates": () => json({ items: [], total: 0 }),
      },
    });
    await flush(8);
    const editor = slot("share-job-editor") as HTMLElement;
    await type(field(editor, "Name"), "Nightly");
    await click(editor.querySelector('[role="radio"][value="interval"]'));
    await type(field(editor, "Every how many hours"), "0");
    await click(action("save-share-job"));
    await flush();
    expect(editor.textContent).toContain("Choose a number between 1 and 744.");
    expect(posts()).toHaveLength(0);
  });
});

describe("the copy job editor", () => {
  function copyRoutes(answers: Response[]) {
    const queue = [...answers];
    return {
      "GET /backup-jobs": () => json(list([])),
      "GET /backup-jobs/defaults": () => json(shareDefaults("copy")),
      "GET /file-shares": () =>
        json(listFixture([shareFixture(), shareFixture({ id: OTHER_ID, name: "Archive" })])),
      "GET /file-shares/restore-targets": () =>
        json({
          items: [
            { id: SHARE_ID, name: "Projects", protocol: "smb", location: "\\\\files\\Projects" },
            { id: OTHER_ID, name: "Archive", protocol: "nfs", location: "nas:/archive" },
          ],
        }),
      "POST /backup-jobs": () =>
        queue.shift() ??
        json(endpointJob({ id: "job-copy", kind: "copy", name: "Projects to Archive" }), 201),
    };
  }

  it("says it is not a backup, takes source, target and folder from the address and confirms a mirror", async () => {
    opened = await openJobs(
      `/jobs?type=copy&new=1&source=${SHARE_ID}&target=${OTHER_ID}&folder=Mirror`,
      {
        routes: copyRoutes([
          problem(COPY_CONFIRM_PROBLEM, 409, {
            folder: "Mirror",
            entries: 3,
            targetName: "Archive",
          }),
        ]),
      },
    );
    await flush(8);
    const editor = slot("copy-job-editor") as HTMLElement;
    expect(slot("not-a-backup")?.textContent).toBe("Not a backup: no versions on the target");
    expect(field(editor, "Target folder").value).toBe("Mirror");
    await type(field(editor, "Name"), "Projects to Archive");
    await click(editor.querySelector('[role="radio"][value="mirror"]'));
    expect(slot("mirror-warning")).not.toBeNull();
    await click(action("save-copy-job"));
    await flush(3);

    expect(posts()[0]?.body).toMatchObject({
      kind: "copy",
      sourceFileShareId: SHARE_ID,
      targetFileShareId: OTHER_ID,
      settings: { targetFolder: "Mirror", mode: "mirror", restorePermissions: false },
    });
    expect(posts()[0]?.body).not.toHaveProperty("confirmMirror");
    const confirm = slot("mirror-confirm") as HTMLElement;
    expect(confirm.textContent).toContain("The folder Mirror on Archive is not empty (3 entries).");
    const go = action("confirm-mirror") as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await type(field(confirm, "Type Mirror to confirm"), "Mirro");
    expect((action("confirm-mirror") as HTMLButtonElement).disabled).toBe(true);
    await type(field(confirm, "Type Mirror to confirm"), "Mirror");
    await click(action("confirm-mirror"));
    await flush(3);
    expect(posts()).toHaveLength(2);
    expect(posts()[1]?.body).toMatchObject({ kind: "copy", confirmMirror: true });
  });

  it("checks the mirror's folder and names a copy rule the API refuses", async () => {
    opened = await openJobs(`/jobs?type=copy&new=1&source=${SHARE_ID}&target=${OTHER_ID}`, {
      routes: copyRoutes([
        problem(COPY_UNSAFE_TARGET_PROBLEM, 422, {
          rule: "same_share",
          field: "targetFileShareId",
        }),
      ]),
    });
    await flush(8);
    const editor = slot("copy-job-editor") as HTMLElement;
    await type(field(editor, "Name"), "Projects to Archive");
    await click(editor.querySelector('[role="radio"][value="mirror"]'));
    await click(action("save-copy-job"));
    await flush();
    expect(editor.textContent).toContain(
      "A mirror deletes what the source does not have, so it needs a folder.",
    );
    expect(posts()).toHaveLength(0);

    await click(editor.querySelector('[role="radio"][value="overwrite"]'));
    await click(action("save-copy-job"));
    await flush(3);
    expect(posts()).toHaveLength(1);
    expect(slot("save-error")?.textContent).toContain(
      "Source and target are the same place. A copy never writes into the file share it copies.",
    );
  });

  it("closes the editor with a toast once saved", async () => {
    opened = await openJobs(
      `/jobs?type=copy&new=1&source=${SHARE_ID}&target=${OTHER_ID}&folder=Copy`,
      {
        routes: copyRoutes([]),
      },
    );
    await flush(8);
    const editor = slot("copy-job-editor") as HTMLElement;
    await type(field(editor, "Name"), "Projects to Archive");
    await click(buttonByText(editor, "Create job"));
    await flush(5);
    expect(slot("copy-job-editor")).toBeNull();
  });
});

describe("the page of a copy job", () => {
  const COPY = endpointJob({
    id: "job-copy",
    kind: "copy",
    name: "Projects to Archive",
    scope: { count: 1, byKind: {}, overrides: 0 },
    schedule: { kind: "daily", timeOfDay: "06:00", timeZone: "Europe/Berlin" },
    retention: { policyId: null, policyName: null, keep: null },
    settings: { targetFolder: "Mirror", mode: "mirror", restorePermissions: false },
    copy: {
      source: { id: SHARE_ID, name: "Projects", retired: false },
      target: { id: OTHER_ID, name: "Archive", retired: false, allowRestore: true },
      mode: "mirror",
      targetFolder: "Mirror",
      mirrorConfirmedAt: "2026-10-01T00:00:00.000Z",
      lastCopied: null,
    },
  });

  it("shows source and target instead of members and runs a copy anyway after asking", async () => {
    opened = await openJobs("/jobs/definitions/job-copy?type=copy&tab=scope", {
      routes: {
        "GET /backup-jobs/job-copy": () => json(COPY),
        "GET /backup-jobs/job-copy/members": () => json({ mode: "selected", items: [] }),
        "GET /backup-jobs": () => json(list([COPY])),
        "POST /backup-jobs/job-copy/run": () => json({ queued: 1, skipped: [] }),
      },
    });
    await flush(6);
    expect(slot("job-detail")?.getAttribute("data-kind")).toBe("copy");
    expect(slot("copy-scope")?.textContent).toContain("Projects");
    expect(slot("copy-scope")?.textContent).toContain("Archive");
    expect(slot("copy-scope")?.textContent).toContain("Not a backup: no versions on the target");
    expect(document.querySelector("h1")?.parentElement?.textContent).toContain(
      "Projects to Archive, folder /Mirror",
    );
    const items = await openMenu(
      document.querySelector('[data-slot="job-detail"] button[aria-haspopup="menu"]'),
    );
    const anyway = items.find((item) => item.textContent?.includes("Copy anyway"));
    await click(anyway);
    await flush();
    await click(buttonByText(document.body, "Copy anyway"));
    await flush(3);
    const run = opened.requests.find((request) => request.path === "/backup-jobs/job-copy/run");
    expect(run?.body).toEqual({ force: true });
  });
});
