// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { endpointJob } from "@/features/backup-jobs/fixtures";
import {
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  type,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import "../i18n.js";
import {
  SHARE_ID,
  failureFixture,
  settingsFixture,
  shareFixture,
  testResultFixture,
} from "../fixtures.js";
import { type Rendered, action, render, slot, text } from "../testing.js";
import { AddShareDialog } from "./add-share-dialog.js";

/**
 * "Add file share" as a person goes through it (docs/FILESHARES.md 12.2): the protocol, the
 * connection checked while typing, the test through a runner with its classified error or the
 * top level of the share (a folder of which becomes the subfolder), the options, saving, and
 * putting the new share into a job.
 */

enableActEnvironment();

let rendered: Rendered | null = null;

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await rendered?.mounted.unmount();
  rendered = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/** The input a visible label names. */
function field(label: string): HTMLInputElement {
  const element = [...document.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const input = element ? document.getElementById(element.htmlFor) : null;
  if (!input) throw new Error(`no field "${label}"`);
  return input as HTMLInputElement;
}

const SHARE_JOB = endpointJob({
  id: "job-share",
  kind: "share",
  name: "File server, nightly",
  scope: { count: 1, byKind: { smb: 1 }, overrides: 0 },
});

async function open(testResults: ReturnType<typeof testResultFixture>[]) {
  const results = [...testResults];
  rendered = await render(<AddShareDialog open onOpenChange={() => undefined} />, {
    routes: {
      "GET /file-shares/settings": () => json(settingsFixture()),
      "POST /file-shares/test": () => json(results.shift() ?? testResultFixture()),
      "POST /file-shares": (request) =>
        json(shareFixture({ name: (request.body as { name: string }).name }), 201),
      "GET /backup-jobs": () => json({ items: [SHARE_JOB], uncovered: {}, unscheduled: {} }),
      [`GET /file-shares/${SHARE_ID}/source`]: () =>
        json({
          ok: true,
          path: "",
          entries: [],
          truncated: false,
          cause: null,
          failure: null,
          params: {},
          detail: null,
        }),
      "POST /backup-jobs/job-share/members": () => json(SHARE_JOB),
    },
  });
}

async function fillSmb() {
  await click(action("next"));
  await type(field("Server"), "files.example.com");
  await type(field("Share"), "Projects");
  await type(field("Account"), "CORP\\backup");
  await type(field("Password"), "s3cret!");
}

describe("the add dialog", () => {
  it("checks the connection while typing and sends nothing that the API would refuse", async () => {
    await open([]);
    expect(slot("add-share-dialog")).not.toBeNull();
    await click(action("next"));
    await type(field("Server"), "smb://files.example.com");
    await click(action("next"));
    expect(text()).toContain("Enter the server without \\\\ or a protocol such as smb://.");
    expect(text()).toContain("Enter a value.");
    expect(rendered?.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("says why a test failed in the words of the failure catalog, then shows the top level", async () => {
    await open([
      testResultFixture({
        ok: false,
        code: "share.auth_failed",
        cause: "auth_failed",
        failure: failureFixture("share.auth_failed"),
        entries: [],
        permissions: null,
        address: null,
      }),
      testResultFixture(),
    ]);
    await fillSmb();
    await click(action("next"));
    await flush();
    const tested = rendered?.requests.find((request) => request.path === "/file-shares/test");
    expect(tested?.body).toMatchObject({
      protocol: "smb",
      server: "files.example.com",
      share: "Projects",
      account: "CORP\\backup",
      password: "s3cret!",
      smbVersion: "3.1.1",
    });
    expect(text()).toContain("The file server refused the account");

    await click(buttonByText(document.body, "Test connection"));
    await flush();
    expect(text()).toContain("Connected to 93.184.216.34");
    expect(text()).toContain("Owner and permissions can be read.");
    expect(text()).toContain("Finance");
  });

  it("takes a folder of the top level as the subfolder and tests again with it", async () => {
    await open([testResultFixture(), testResultFixture({ entries: [] })]);
    await fillSmb();
    await click(action("next"));
    await flush();
    const use = buttonByText(slot("test-step") as HTMLElement, "Use as subfolder");
    await click(use);
    await click(buttonByText(document.body, "Test connection"));
    await flush();
    const tests = (rendered?.requests ?? []).filter(
      (request) => request.path === "/file-shares/test",
    );
    expect(tests).toHaveLength(2);
    expect(tests[1]?.body).toMatchObject({ subfolder: "Finance" });
  });

  it("saves with the options, then puts the share into a job", async () => {
    await open([testResultFixture()]);
    await fillSmb();
    await click(action("next"));
    await flush();
    await click(action("next"));
    // The name follows the share until someone types one.
    expect(field("Name").value).toBe("Projects");
    await click(action("save-share"));
    await flush();
    const saved = rendered?.requests.find(
      (request) => request.method === "POST" && request.path === "/file-shares",
    );
    expect(saved?.body).toMatchObject({
      protocol: "smb",
      name: "Projects",
      allowRestore: false,
      permissionsMode: "auto",
    });
    expect(text()).toContain("Projects is saved. Which job backs it up?");
    await click(buttonByText(document.body, "Add to job"));
    await flush();
    const added = rendered?.requests.find(
      (request) => request.path === "/backup-jobs/job-share/members",
    );
    expect(added?.body).toEqual({ members: [{ id: SHARE_ID }] });
  });

  it("asks once before saving a share whose test did not pass", async () => {
    await open([
      testResultFixture({
        ok: false,
        code: "share.unreachable",
        failure: failureFixture("share.unreachable", { steps: [] }),
        entries: [],
      }),
    ]);
    await fillSmb();
    await click(action("next"));
    await flush();
    await click(action("next"));
    const save = action("save-share") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(slot("untested-notice")).not.toBeNull();
    await click(action("confirm-untested"));
    expect((action("save-share") as HTMLButtonElement).disabled).toBe(false);
  });
});
