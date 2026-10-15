// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

import type { FileShareDetail, RestoreTarget } from "../api.js";
import {
  OTHER_ID,
  SHARE_ID,
  SNAPSHOT_ID,
  iso,
  runFixture,
  shareFixture,
  snapshotFixture,
} from "../fixtures.js";
import "../i18n.js";
import { type Rendered, render, slot, text } from "../testing.js";
import { ShareRestoreDialog } from "./restore-dialog.js";
import { ShareRestorePoints } from "./share-restore-points.js";

/**
 * The file restore of a file share (docs/FILESHARES.md 12.4): the browser the machines use,
 * fed by the share's adapter (restore points, folders, ZIP), and the restore dialog with every
 * destination: the original location with what happens to a file that exists, a new folder,
 * another share that allows restores into it, or a ZIP.
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
const TARGETS: RestoreTarget[] = [
  { id: SHARE_ID, name: "Projects", protocol: "smb", location: "\\\\files\\Projects" },
  { id: OTHER_ID, name: "Archive", protocol: "nfs", location: "nas:/archive" },
];

function entry(name: string, type: "dir" | "file", path: string) {
  return { name, path, type, size: type === "file" ? 2048 : null, mtime: iso(-700) };
}

const box = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe("the restore points of a share", () => {
  it("browses a restore point with the machines' browser and restores the selection", async () => {
    rendered = await render(
      <ShareRestorePoints share={shareFixture()} onShowRuns={() => undefined} />,
      {
        routes: {
          [`GET ${BASE}/snapshots`]: () =>
            json({
              items: [
                snapshotFixture(),
                snapshotFixture({ id: "older", shortId: "0ld0ld00", time: iso(-2000) }),
              ],
            }),
          [`GET ${BASE}/browse`]: () =>
            json({
              snapshotId: SNAPSHOT_ID,
              path: "/",
              entries: [
                entry("Finance", "dir", "/Finance"),
                entry("readme.txt", "file", "/readme.txt"),
              ],
              nextCursor: null,
              permissions: null,
            }),
          [`GET ${BASE}/search`]: () => json({ items: [], truncated: false }),
          "GET /file-shares/restore-targets": () => json({ items: TARGETS }),
        },
      },
    );
    const points = [...document.querySelectorAll('[data-slot="snapshot-list"] li')];
    expect(points).toHaveLength(2);
    expect(points[0]?.textContent).toContain("1,200 files");
    await click(buttonByText(document.body, /a1b2c3d4/));
    await flush(4);
    expect(text()).toContain("Permissions of 1,280 entries");
    expect([...document.querySelectorAll("tbody tr")].map((row) => row.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Finance"),
        expect.stringContaining("readme.txt"),
      ]),
    );
    await click(box("Select readme.txt"));
    await click(buttonByText(slot("selection-bar") as HTMLElement, "Restore"));
    await flush(3);
    expect(slot("share-restore-dialog")).not.toBeNull();
    expect(text()).toContain("/readme.txt");
  });
});

describe("the restore dialog", () => {
  async function openDialog(share: FileShareDetail, onDownload = vi.fn()) {
    rendered = await render(
      <ShareRestoreDialog
        open
        onOpenChange={() => undefined}
        share={share}
        point={snapshotFixture()}
        paths={["Finance", "readme.txt"]}
        onDownload={onDownload}
        onRequested={() => undefined}
        onShowRuns={() => undefined}
        now={() => new Date("2026-10-10T12:30:05")}
      />,
      {
        routes: {
          "GET /file-shares/restore-targets": () => json({ items: TARGETS }),
          [`POST ${BASE}/restores`]: () =>
            json(runFixture({ kind: "restore", status: "queued" }), 201),
        },
      },
    );
    await flush(3);
    return onDownload;
  }

  const radio = (where: string) =>
    document.querySelector<HTMLButtonElement>(`[data-where="${where}"]`);
  const next = () => buttonByText(slot("share-restore-dialog") as HTMLElement, "Next");
  const posted = () => rendered?.requests.find((request) => request.path === `${BASE}/restores`);

  it("restores to the original location with the conflict mode, after a summary", async () => {
    await openDialog(shareFixture());
    await click(radio("original"));
    await click(document.querySelector<HTMLButtonElement>('[data-conflict="overwrite"]'));
    await click(next());
    expect(slot("restore-summary")?.textContent).toContain(
      "2 items go back to Projects, where they came from. If a file exists: Overwrite.",
    );
    await click(buttonByText(slot("share-restore-dialog") as HTMLElement, "Restore"));
    await flush();
    expect(posted()?.body).toEqual({
      snapshotId: SNAPSHOT_ID,
      paths: ["Finance", "readme.txt"],
      destination: "original",
      conflict: "overwrite",
      restorePermissions: true,
      verify: false,
    });
  });

  it("restores into a new folder of the same share, named after the time when left empty", async () => {
    await openDialog(shareFixture());
    // "A new folder in the same file share" is the default where restores are allowed.
    expect(radio("new_folder")?.getAttribute("data-state")).toBe("checked");
    await click(next());
    expect(slot("restore-summary")?.textContent).toContain("Restow-Restore-20261010-123005");
    await click(buttonByText(slot("share-restore-dialog") as HTMLElement, "Restore"));
    await flush();
    expect(posted()?.body).toMatchObject({ destination: "new_folder", restorePermissions: true });
  });

  it("restores into another share without its permissions and verifies on NFS", async () => {
    await openDialog(shareFixture());
    await click(radio("other_share"));
    await type(document.getElementById("restore-folder"), "From Projects");
    await click(next());
    expect(slot("restore-summary")?.textContent).toContain(
      "into the folder From Projects of Archive",
    );
    await click(buttonByText(slot("share-restore-dialog") as HTMLElement, "Restore"));
    await flush();
    expect(posted()?.body).toMatchObject({
      destination: "other_share",
      targetShareId: OTHER_ID,
      folder: "From Projects",
      restorePermissions: false,
      verify: true,
    });
  });

  it("offers only the ZIP and another share when the share does not allow restores into it", async () => {
    const onDownload = await openDialog(shareFixture({ allowRestore: false }));
    expect(radio("original")?.disabled).toBe(true);
    expect(radio("new_folder")?.disabled).toBe(true);
    expect(document.querySelector('[data-disabled-reason="original"]')?.textContent).toContain(
      "This file share does not allow restores into it.",
    );
    expect(radio("zip")?.getAttribute("data-state")).toBe("checked");
    await click(buttonByText(slot("share-restore-dialog") as HTMLElement, "Download"));
    expect(onDownload).toHaveBeenCalledOnce();
    expect(posted()).toBeUndefined();
  });
});
