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

const SPACE_RULE = {
  defaults: { enabled: true, percent: 5, minBytes: 20 * GIB, maxBytes: 500 * GIB },
  override: null,
  effective: { enabled: true, percent: 5, minBytes: 20 * GIB, maxBytes: 500 * GIB },
};

function routes(overrides: Record<string, () => Response> = {}) {
  return routedFetch({
    "GET /settings": () => json(SETTINGS),
    "GET /updates/database": () => json(view()),
    "GET /updates/space-rule": () => json(SPACE_RULE),
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

  it("shows the database's disk read without the updater and the emergency reserve (#98)", async () => {
    const reserve = {
      path: "/data/restow-disk-reserve",
      bytes: 2 * GIB,
      floorBytes: GIB,
      presentBytes: 2 * GIB,
      freeBytes: 30 * GIB,
      totalBytes: 100 * GIB,
      createAtBytes: 12 * GIB,
      marker: null,
    };
    let current: Record<string, unknown> = view({
      updater: "unavailable",
      location: null,
      usage: null,
      disks: {
        database: {
          kind: "database",
          location: "pgdata",
          freeBytes: 30 * GIB,
          totalBytes: 100 * GIB,
          thresholdBytes: 10 * GIB,
          low: false,
          via: "volume",
        },
        repository: null,
      },
      reserve: { ...reserve, state: "present" },
    });
    vi.stubGlobal("fetch", routes({ "GET /updates/database": () => json(current) }).mock);
    await open();
    expect(text(slot("disk-via-volume"))).toContain("Read without the updater");
    expect(slot("disk-reserve")?.getAttribute("data-state")).toBe("present");
    expect(text(slot("disk-reserve"))).toContain("/data/restow-disk-reserve");
    expect(text(slot("disk-reserve"))).toContain(
      "docker compose exec api restow disk-reserve release",
    );
    await mounted?.unmount();
    current = { ...current, reserve: { ...reserve, presentBytes: 0, state: "released" } };
    await open();
    expect(slot("disk-reserve")?.getAttribute("data-state")).toBe("released");
    expect(text(slot("disk-reserve"))).toContain("Freed because the disk was almost full");
  });
});

describe("one disk, and what storage targets keep free (#98, #99)", () => {
  it("shows the database and the repository on the same disk as one line", async () => {
    const shared = view();
    (shared.disks as Record<string, Record<string, unknown>>).database.device = "system";
    (shared.disks as Record<string, Record<string, unknown>>).repository.device = "system";
    vi.stubGlobal("fetch", routes({ "GET /updates/database": () => json(shared) }).mock);
    await open();
    expect(document.querySelectorAll("[data-disk]")).toHaveLength(1);
    expect(text(slot("database-disks") ?? document.body)).toContain(
      "One disk for the database and the local default repository",
    );
    await mounted?.unmount();
    // On two disks (or where the device cannot be told): a line each.
    vi.stubGlobal("fetch", routes().mock);
    await open();
    expect(document.querySelectorAll("[data-disk]")).toHaveLength(2);
  });

  it("shows the installation's space rule and lets the owner change it", async () => {
    const fetch = routes({
      "PUT /updates/space-rule": () =>
        json({
          ...SPACE_RULE,
          override: { percent: 10 },
          effective: { ...SPACE_RULE.effective, percent: 10 },
        }),
    });
    vi.stubGlobal("fetch", fetch.mock);
    await open();
    const card = slot("installation-space-rule");
    expect(text(card)).toContain("Keeps 5 % of the target free, at least 20 GB, at most 500 GB");
    await click(buttonByText(card as HTMLElement, "Change"));
    await flush(2);
    const dialog = slot("space-rule-dialog") as HTMLElement;
    const percent = [...dialog.querySelectorAll("label")].find((label) =>
      label.textContent?.includes("Share of the target's size"),
    );
    await type(document.getElementById(percent?.getAttribute("for") ?? ""), "10");
    await click(buttonByText(dialog, "Save"));
    await flush(4);
    expect(fetch.requests.find((request) => request.method === "PUT")).toEqual({
      method: "PUT",
      path: "/updates/space-rule",
      body: { space: { percent: 10 } },
    });
    expect(text(slot("installation-space-rule"))).toContain("Keeps 10 %");
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
