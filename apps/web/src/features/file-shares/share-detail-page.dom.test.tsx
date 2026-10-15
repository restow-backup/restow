// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type RecordedRequest,
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  type,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";
import type { SessionContextValue } from "@/lib/session";

import type { FileShareDetail } from "./api.js";
import {
  SHARE_ID,
  failureFixture,
  iso,
  runDetailFixture,
  runFixture,
  shareFixture,
} from "./fixtures.js";
import "./i18n.js";
import type { ShareTab } from "./paths.js";
import { ShareDetailPage } from "./share-detail-page.js";
import { type Rendered, action, providerOwner, render, slot, text } from "./testing.js";

/**
 * One file share as a person meets it (docs/FILESHARES.md 12.3): the overview with the run in
 * progress, the runs with the files a run could not handle, and the settings ("Allow restore to
 * this share", a new password, the budget only provider administrators change).
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

const BASE = `/file-shares/${SHARE_ID}`;

async function open(
  share: FileShareDetail,
  tab: ShareTab,
  routes: Record<string, (request: RecordedRequest) => Response> = {},
  session?: SessionContextValue,
) {
  rendered = await render(
    <ShareDetailPage shareId={SHARE_ID} tab={tab} onTabChange={() => undefined} />,
    {
      routes: {
        [`GET ${BASE}`]: () => json(share),
        [`PATCH ${BASE}`]: (request) => json({ ...share, ...(request.body as object) }),
        ...routes,
      },
      ...(session ? { session } : {}),
    },
  );
  await flush(5);
}

describe("the overview", () => {
  it("shows the run in progress with its phase and counts, and cancels it", async () => {
    const running = shareFixture({
      standing: "running",
      activeRun: {
        id: "run-live",
        kind: "backup",
        status: "running",
        startedAt: iso(-5),
        queuedAt: iso(-6),
        finishedAt: null,
        progress: {
          phase: "backup",
          filesDone: 300,
          bytesDone: 1024 ** 3,
          totalFiles: 1200,
          totalBytes: 4 * 1024 ** 3,
          currentPath: "Finance/2026.xlsx",
          bytesUploaded: 0,
          at: iso(),
        },
      },
    });
    await open(running, "overview", {
      [`POST ${BASE}/runs/run-live/cancel`]: () =>
        json(runFixture({ id: "run-live", status: "running" })),
    });
    expect(slot("file-share-detail")?.getAttribute("data-share")).toBe(SHARE_ID);
    expect(text()).toContain("Backing up");
    expect(text()).toContain("300 of 1,200 files");
    expect(document.querySelector('[role="progressbar"]')).not.toBeNull();
    await click(buttonByText(document.body, "Cancel run"));
    await flush();
    expect(
      rendered?.requests.some((request) => request.path === `${BASE}/runs/run-live/cancel`),
    ).toBe(true);
  });

  it("names a refused password and the restore check that passed", async () => {
    await open(shareFixture({ credentialFailedAt: iso(-30) }), "overview");
    expect(text()).toContain("The password was refused");
    expect(text()).toContain("Ready");
  });
});

describe("the runs", () => {
  it("lists the runs and opens one with the files it could not handle, by cause", async () => {
    const warned = runFixture({
      id: "run-warn",
      status: "warning",
      itemCount: 3,
      failure: failureFixture("share.locked_files", { steps: [] }),
    });
    await open(shareFixture(), "runs", {
      [`GET ${BASE}/runs`]: () => json({ items: [warned, runFixture({ id: "run-ok" })] }),
      [`GET ${BASE}/runs/run-warn`]: () =>
        json(
          runDetailFixture({
            ...warned,
            itemsStored: 2,
            itemCounts: { locked_file: 2, read_error: 1 },
            items: [
              {
                path: "Finance/open.xlsx",
                code: "locked_file",
                phase: "backup",
                message: "in use",
              },
              { path: "Finance/old.doc", code: "read_error", phase: "backup", message: "" },
            ],
          }),
        ),
    });
    const rows = document.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("With warnings");
    await click(rows[0]?.querySelector("button") ?? null);
    await flush();
    const items = slot("run-items");
    expect(items?.textContent).toContain("3 files with warnings");
    expect(items?.textContent).toContain("Locked by another program (2)");
    expect(items?.textContent).toContain("Finance/open.xlsx");
    expect(items?.textContent).toContain("1 more is counted but not listed.");
  });
});

describe("the settings", () => {
  it("switches off restores into the share at once", async () => {
    await open(shareFixture({ allowRestore: true }), "settings");
    await click(action("allow-restore"));
    await flush();
    const patch = rendered?.requests.find((request) => request.method === "PATCH");
    expect(patch?.body).toEqual({ allowRestore: false });
  });

  it("sends a new password only, and keeps the stored one when the field stays empty", async () => {
    await open(shareFixture(), "settings");
    const save = action("save-connection") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const label = [...document.querySelectorAll("label")].find(
      (element) => element.textContent?.trim() === "New password",
    );
    await type(document.getElementById(label?.htmlFor ?? ""), "n3w-secret");
    await click(action("save-connection"));
    await flush();
    const patch = rendered?.requests.find((request) => request.method === "PATCH");
    expect(patch?.body).toEqual({ password: "n3w-secret" });
  });

  it("leaves the budget to provider administrators", async () => {
    await open(shareFixture(), "settings");
    expect(slot("budget-settings")?.textContent).toContain(
      "Only provider administrators can change the budget.",
    );
    expect(action("save-budget")).toBeNull();
  });

  it("lets a provider owner set the budget", async () => {
    await open(
      shareFixture(),
      "settings",
      { [`PUT ${BASE}/quota`]: () => json(shareFixture({ quotaGib: 50 })) },
      providerOwner(),
    );
    await click(document.getElementById("share-budget-on"));
    await type(document.getElementById("share-budget"), "50");
    await click(action("save-budget"));
    await flush();
    const put = rendered?.requests.find((request) => request.path === `${BASE}/quota`);
    expect(put?.body).toEqual({ quotaGib: 50 });
  });
});
