// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import "./i18n.js";
import { restoreNameValid } from "./components/backups.js";
import { DatabasePage } from "./database-page.js";
import {
  connectionFixture,
  databaseFixture,
  type Rendered,
  render,
  sessionWithRole,
  slot,
  text,
} from "./testing.js";

/**
 * One database's backups (docs/DATABASES.md 7.1, 16 "D3"): an administrator backs up now and
 * restores into a new database (on this or another connection of the same engine); a restore
 * operator reads and downloads without the actions.
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

const backup = {
  id: "backup-1",
  kind: "database",
  databaseName: "app",
  snapshotId: "4f0a1b2c3d4e5f60",
  fileName: "postgresql/app.pgdump",
  sha256: "9d1f8e0c3b2a4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6",
  bytes: 81920,
  objects: { TABLE: 2 },
  toolVersion: "16",
  serverVersion: "16.4",
  startedAt: "2026-11-18T10:00:00.000Z",
  finishedAt: "2026-11-18T10:00:05.000Z",
};

const run = {
  id: "run-1",
  kind: "restore",
  trigger: "manual",
  status: "queued",
  executor: "server",
  targetConnectionId: "conn-2",
  targetName: "app_copy",
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-11-18T10:05:00.000Z",
  startedAt: null,
  finishedAt: null,
};

const globals = {
  ...backup,
  id: "globals-1",
  kind: "globals",
  databaseName: "",
  fileName: "postgresql/globals.sql",
};

function routes(posted: { path: string; body: unknown }[]) {
  const database = {
    ...databaseFixture({
      id: "db-1",
      name: "app",
      lastBackupAt: backup.finishedAt,
      rating: "unverified",
    }),
    connection: connectionFixture(),
  };
  return {
    "GET /databases/db-1": () => json(database),
    "GET /databases/db-1/backups": () => json({ backups: [backup] }),
    "GET /databases/connections/conn-1/globals": () => {
      posted.push({ path: "globals", body: null });
      return json({ backups: [globals] });
    },
    "GET /databases/db-1/health": () => json({ from: "x", to: "y", days: [] }),
    "GET /databases/connections": () =>
      json({
        connections: [
          connectionFixture(),
          connectionFixture({ id: "conn-2", name: "Test instance" }),
          connectionFixture({ id: "conn-3", name: "Shop", engine: "mysql" }),
        ],
      }),
    "POST /databases/db-1/backup": (request: { body: unknown }) => {
      posted.push({ path: "backup", body: request.body });
      return json({ ...run, kind: "backup", targetConnectionId: null, targetName: null }, 202);
    },
    "POST /databases/db-1/restore": (request: { body: unknown }) => {
      posted.push({ path: "restore", body: request.body });
      return json(run, 202);
    },
  };
}

describe("the backups of a database [DB-008]", () => {
  it("backs up now and restores into a new database, never over one", async () => {
    const posted: { path: string; body: unknown }[] = [];
    rendered = await render(<DatabasePage databaseId="db-1" />, { routes: routes(posted) });
    expect(slot("database-backups")).not.toBeNull();
    expect(text()).toContain("80 kB");
    await click(buttonByText(document, "Back up now") as HTMLElement);
    await flush(5);
    expect(posted.map((entry) => entry.path).filter((path) => path !== "globals")).toEqual([
      "backup",
    ]);
    expect(text()).toContain("The backup is planned");

    // The roles of the instance, with their password hashes: listed for administrators.
    expect(slot("database-globals")).not.toBeNull();
    expect(buttonByText(document, "Download globals.sql")).not.toBeNull();

    await click(buttonByText(slot("database-backups") as ParentNode, "Restore") as HTMLElement);
    await flush(5);
    expect(text()).toContain("An existing database is never overwritten");
    const restore = [...document.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === "Restore",
    );
    await click(restore[restore.length - 1] as HTMLElement);
    await flush(5);
    expect(posted.filter((entry) => entry.path === "restore")).toEqual([
      { path: "restore", body: { backupId: "backup-1" } },
    ]);
    expect(text()).toContain("The restore into “app_copy” is planned");
  });

  it("lets a restore operator read and download without the actions", async () => {
    const asked: { path: string; body: unknown }[] = [];
    rendered = await render(<DatabasePage databaseId="db-1" />, {
      routes: routes(asked),
      session: sessionWithRole("tenant_restore"),
    });
    // Never the globals: not shown, not even asked for.
    expect(slot("database-globals")).toBeNull();
    expect(asked.map((entry) => entry.path)).not.toContain("globals");
    expect(buttonByText(document, "Download")).not.toBeNull();
    expect(buttonByText(document, "Restore guide")).not.toBeNull();
    expect(buttonByText(document, "Back up now")).toBeNull();
    expect(buttonByText(slot("database-backups") as ParentNode, "Restore")).toBeNull();
  });

  it("offers no backup or restore through an agent on Windows yet", async () => {
    const base = routes([]);
    rendered = await render(<DatabasePage databaseId="db-1" />, {
      routes: {
        ...base,
        "GET /databases/db-1": () =>
          json({
            ...databaseFixture({ id: "db-1", name: "app", lastBackupAt: backup.finishedAt }),
            connection: connectionFixture({ notices: ["db_platform_unsupported"] }),
          }),
      },
    });
    expect(slot("database-platform-unsupported")).not.toBeNull();
    expect(buttonByText(document, "Back up now")).toBeNull();
    expect(buttonByText(slot("database-backups") as ParentNode, "Restore")).toBeNull();
    expect(buttonByText(document, "Download")).not.toBeNull();
  });

  it("offers backups of MySQL and MariaDB, with their names of 64 characters", async () => {
    const base = routes([]);
    rendered = await render(<DatabasePage databaseId="db-1" />, {
      routes: {
        ...base,
        "GET /databases/db-1": () =>
          json({
            ...databaseFixture({
              id: "db-1",
              name: "app",
              engine: "mariadb",
              lastBackupAt: backup.finishedAt,
            }),
            connection: connectionFixture({ engine: "mariadb" }),
          }),
      },
    });
    expect(buttonByText(document, "Back up now")).not.toBeNull();
    expect(buttonByText(document, "Download users.sql")).not.toBeNull();
    expect(restoreNameValid("ä".repeat(64), "mariadb")).toBe(true);
    expect(restoreNameValid("ä".repeat(64), "postgresql")).toBe(false);
    expect(restoreNameValid("a".repeat(65), "mysql")).toBe(false);
  });

  it("accepts a new name of at most 63 bytes", () => {
    expect(restoreNameValid("a".repeat(63))).toBe(true);
    expect(restoreNameValid("a".repeat(64))).toBe(false);
    expect(restoreNameValid("ä".repeat(32))).toBe(false);
    expect(restoreNameValid(" app")).toBe(false);
    expect(restoreNameValid("a\nb")).toBe(false);
    expect(restoreNameValid("a\\'b")).toBe(true);
  });
});
