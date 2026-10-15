// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  json,
  type Mounted,
  problem,
  routedFetch,
  type,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { resetWebExtensionsForTesting } from "@/lib/extensions";

import { failureKey, problemKey } from "./sections/database-api";
import { openInstallation, providerSession, SETTINGS } from "./testing";

/**
 * Installation > Database in a DOM: the location, the disks and their warning, checking a
 * directory and what the checks found, the move behind its confirmation (the directory
 * typed again), a move that rolled back, the old copy and its removal, and the read-only
 * state for everyone but the owner.
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

const GIB = 1024 ** 3;
let mounted: Mounted | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  resetWebExtensionsForTesting();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const steps = (statuses: string[]) =>
  [
    "stop_application",
    "stop_database",
    "copy",
    "verify",
    "trial",
    "switch",
    "start_database",
    "start_application",
  ].map((id, index) => ({
    id,
    status: statuses[index] ?? "pending",
    startedAt: null,
    finishedAt: null,
  }));

function view(overrides: Record<string, unknown> = {}) {
  return {
    updater: "ready",
    updateActive: false,
    location: { kind: "volume", source: "restow_pgdata" },
    usage: {
      dataBytes: 29 * GIB,
      filesystemTotalBytes: 38 * GIB,
      filesystemFreeBytes: 4 * GIB,
      filesystem: "ext2/ext3",
      measuredAt: "2026-10-02T10:00:00.000Z",
    },
    movable: true,
    move: null,
    oldCopies: [],
    removal: null,
    updateSpace: {
      dumpBytes: 1.25 * GIB,
      dumpBasis: "last_dump",
      imageBytes: GIB,
      migrationBytes: 2.9 * GIB,
      marginBytes: GIB,
      stateFreeBytes: 4 * GIB,
      stateRequiredBytes: 6.15 * GIB,
      databaseFreeBytes: 4 * GIB,
      databaseRequiredBytes: 0,
      sameFilesystem: true,
      enough: false,
    },
    disks: {
      database: {
        kind: "database",
        location: "restow_pgdata",
        freeBytes: 4 * GIB,
        totalBytes: 38 * GIB,
        thresholdBytes: 5 * GIB,
        low: true,
      },
      repository: {
        kind: "repository",
        location: "/data/chunks",
        freeBytes: 500 * GIB,
        totalBytes: 1000 * GIB,
        thresholdBytes: 100 * GIB,
        low: false,
      },
    },
    projectDir: "/opt/restow",
    ...overrides,
  };
}

const CHECK_OK = {
  ok: true,
  problems: [],
  targetDir: "/mnt/volume-1/restow-db",
  filesystem: "xfs",
  freeBytes: 95 * GIB,
  totalBytes: 100 * GIB,
  dataBytes: 29 * GIB,
  requiredBytes: 32 * GIB,
  checkedAt: "2026-10-02T10:00:00.000Z",
};

function routes(overrides: Record<string, () => Response> = {}) {
  return routedFetch({
    "GET /settings": () => json(SETTINGS),
    "GET /updates/database": () => json(view()),
    ...overrides,
  });
}

function text(scope: ParentNode | null | undefined = document.body): string {
  return (scope?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function slot(name: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-slot="${name}"]`);
}

async function open(options: Parameters<typeof openInstallation>[1] = {}) {
  mounted = await openInstallation("/installation/database", options);
  await flush(8);
}

describe("Installation > Database", () => {
  it("shows where the database is, the disks and the warning when one is low", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open();
    expect(text(slot("database-where"))).toBe("Docker volume restow_pgdata (on the system disk)");
    const database = document.querySelector('[data-disk="database"]');
    expect(database?.getAttribute("data-low")).toBe("true");
    expect(text(database)).toContain("Low");
    expect(text(slot("disk-low"))).toContain("Little free space");
    expect(slot("update-space")?.getAttribute("data-enough")).toBe("false");
    expect(text(slot("update-space"))).toContain("The updater refuses the update");
  });

  it("checks a directory, then moves after the directory is typed again", async () => {
    let current = view();
    const { mock, requests } = routes({
      "GET /updates/database": () => json(current),
      "POST /updates/database/check": () => json(CHECK_OK),
      "POST /updates/database/move": () => {
        current = view({
          move: {
            id: "m-1",
            status: "running",
            requestedBy: { userId: "u", label: "owner@example.com", ip: null },
            startedAt: "2026-10-02T10:00:00.000Z",
            finishedAt: null,
            from: { kind: "volume", source: "restow_pgdata" },
            targetDir: "/mnt/volume-1/restow-db",
            dataDir: "/mnt/volume-1/restow-db/restow-postgres-20261002-100000",
            step: "copy",
            steps: steps(["done", "done", "running"]),
            progress: 30,
            dataBytes: 29 * GIB,
            verified: null,
            failure: null,
            keptCopy: null,
            log: [],
          },
        });
        return json(current);
      },
    });
    vi.stubGlobal("fetch", mock);
    await open();
    const form = slot("database-move-form") as HTMLElement;
    const move = buttonByText(form, "Move database…") as HTMLButtonElement;
    expect(move.disabled).toBe(true);
    await type(form.querySelector("input"), "/mnt/volume-1/restow-db");
    await click(buttonByText(form, "Check directory"));
    await flush(8);
    expect(text(slot("database-check-ok"))).toContain("File system xfs");
    expect(move.disabled).toBe(false);
    await click(move);
    await flush(4);
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(text(dialog)).toContain("Restow is unavailable during the move");
    const confirm = buttonByText(dialog, "Move database") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await type(dialog.querySelector("input"), "/mnt/volume-1/restow-db");
    expect(confirm.disabled).toBe(false);
    await click(confirm);
    await flush(8);
    expect(requests.filter((request) => request.path === "/updates/database/move")).toEqual([
      {
        method: "POST",
        path: "/updates/database/move",
        body: { targetDir: "/mnt/volume-1/restow-db" },
      },
    ]);
    const card = slot("database-move");
    expect(card?.getAttribute("data-status")).toBe("running");
    expect(text(card)).toContain("Restow is stopped while the database moves");
  });

  it("lists what the checks found", async () => {
    const { mock } = routes({
      "POST /updates/database/check": () =>
        json({
          ...CHECK_OK,
          ok: false,
          problems: [
            {
              code: "same_filesystem",
              detail: "/srv is on the file system the database is on now.",
            },
            { code: "filesystem_unsuitable", detail: "nfs" },
          ],
          targetDir: "/srv",
        }),
    });
    vi.stubGlobal("fetch", mock);
    await open();
    const form = slot("database-move-form") as HTMLElement;
    await type(form.querySelector("input"), "/srv");
    await click(buttonByText(form, "Check directory"));
    await flush(8);
    const problems = [...document.querySelectorAll("[data-problem]")].map((node) =>
      node.getAttribute("data-problem"),
    );
    expect(problems).toEqual(["same_filesystem", "filesystem_unsuitable"]);
    expect(text(slot("database-check-failed"))).toContain("same disk as the database");
    expect((buttonByText(form, "Move database…") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says what happened when a move went back", async () => {
    const rolledBack = view({
      move: {
        id: "m-1",
        status: "rolled_back",
        requestedBy: { userId: "u", label: "owner@example.com", ip: null },
        startedAt: "2026-10-02T10:00:00.000Z",
        finishedAt: "2026-10-02T10:20:00.000Z",
        from: { kind: "volume", source: "restow_pgdata" },
        targetDir: "/mnt/volume-1/restow-db",
        dataDir: "/mnt/volume-1/restow-db/restow-postgres-20261002-100000",
        step: null,
        steps: steps([
          "done",
          "done",
          "done",
          "failed",
          "skipped",
          "skipped",
          "skipped",
          "skipped",
        ]),
        progress: 60,
        dataBytes: 29 * GIB,
        verified: null,
        failure: {
          code: "verify.mismatch",
          step: "verify",
          detail: "Original / copy: the content differs.",
        },
        keptCopy: null,
        log: ["2026-10-02T10:00:00.000Z Moving the database"],
      },
    });
    vi.stubGlobal("fetch", routes({ "GET /updates/database": () => json(rolledBack) }).mock);
    await open();
    const failure = slot("database-failure");
    expect(failure?.getAttribute("data-code")).toBe("verify.mismatch");
    expect(text(failure)).toContain("The copy differs from the original.");
    expect(text(failure)).toContain("Restow went back to the old location");
  });

  it("removes the old copy after a destructive confirmation", async () => {
    const withCopy = view({
      oldCopies: [
        {
          id: "c-1",
          location: { kind: "volume", source: "restow_pgdata" },
          moveId: "m-1",
          movedAt: "2026-10-02T10:20:00.000Z",
        },
      ],
    });
    const { mock, requests } = routes({
      "GET /updates/database": () => json(withCopy),
      "DELETE /updates/database/old-copies/c-1": () => json(view()),
    });
    vi.stubGlobal("fetch", mock);
    await open();
    const card = slot("database-old-copies") as HTMLElement;
    await click(buttonByText(card, "Remove old copy"));
    await flush(4);
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(text(dialog)).toContain("This cannot be undone");
    await click(buttonByText(dialog, "Remove old copy"));
    await flush(8);
    expect(requests.some((request) => request.method === "DELETE")).toBe(true);
  });

  it("shows the refusal of a stale session through the identity dialog", async () => {
    const { mock } = routes({
      "POST /updates/database/check": () => json(CHECK_OK),
      "POST /updates/database/move": () =>
        problem("urn:restow:problem:recent-sign-in-required", 403, { maxAgeSeconds: 600 }),
    });
    vi.stubGlobal("fetch", mock);
    await open();
    const form = slot("database-move-form") as HTMLElement;
    await type(form.querySelector("input"), "/mnt/volume-1/restow-db");
    await click(buttonByText(form, "Check directory"));
    await flush(8);
    await click(buttonByText(form, "Move database…"));
    await flush(4);
    let dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
    await type(dialog.querySelector("input"), "/mnt/volume-1/restow-db");
    await click(buttonByText(dialog, "Move database"));
    await flush(8);
    dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(text(dialog)).toMatch(/confirm/i);
  });

  it("is read-only for everyone but the owner", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open({ session: providerSession("administrator") });
    const form = slot("database-move-form") as HTMLElement;
    expect(form.querySelector('[data-slot="access-note"]')).not.toBeNull();
    expect((form.querySelector("input") as HTMLInputElement).disabled).toBe(true);
  });

  it("says when no updater answers", async () => {
    vi.stubGlobal(
      "fetch",
      routes({
        "GET /updates/database": () =>
          json(
            view({
              updater: "unavailable",
              location: null,
              usage: null,
              disks: { database: null, repository: null },
            }),
          ),
      }).mock,
    );
    await open();
    expect(text(slot("database-unavailable"))).toContain("The optional updater does not answer");
  });
});

describe("text keys", () => {
  it("fall back for codes this version does not know", () => {
    expect(problemKey("same_filesystem")).toBe("database.problems.same_filesystem");
    expect(problemKey("new_thing")).toBe("database.problems.unknown");
    expect(failureKey("verify.mismatch")).toBe("database.failure.verify.mismatch");
    expect(failureKey("x.y")).toBe("database.failure.unknown");
  });
});
