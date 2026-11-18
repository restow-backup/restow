import type { DatabaseBackup } from "@restow/db";
import { describe, expect, it } from "vitest";
import { mysqlGuide } from "./runs.js";

/**
 * The restore guide of a MySQL or MariaDB backup (docs/DATABASES.md 16 "D4"): the client in
 * binary mode and without its commands that reach the file system, the advice on definers and a
 * restore user of its own, the events.
 */
describe("the MySQL and MariaDB restore guide [DB-008]", () => {
  const backup = {
    finishedAt: new Date("2026-11-18T10:00:00Z"),
    serverVersion: "8.4.3",
    toolVersion: "8.4",
    sha256: "a".repeat(64),
    engineOptions: { characterSet: "utf8mb4", collation: "utf8mb4_0900_ai_ci" },
  } as unknown as DatabaseBackup;

  it("restores in binary mode with the file system commands switched off", () => {
    const mysql = mysqlGuide({
      engine: "mysql",
      database: "shop",
      connection: "ERP",
      backup,
      file: "'shop.sql'",
    });
    expect(mysql).toContain(
      "mysql --binary-mode --skip-system-command --database='shop_restored_20261118_100000' --default-character-set=utf8mb4 --max-allowed-packet=1G < 'shop.sql'",
    );
    expect(mysql).toContain("MySQL client 8.4.3 or newer");
    const maria = mysqlGuide({
      engine: "mariadb",
      database: "shop",
      connection: "ERP",
      backup,
      file: "'shop.sql'",
    });
    expect(maria).toContain("mariadb --binary-mode --sandbox --database='shop_restored_");
    expect(maria).not.toContain("system-command");
  });

  it("recommends a restore user of its own and tells what runs with its rights", () => {
    const guide = mysqlGuide({
      engine: "mysql",
      database: "shop",
      connection: "ERP",
      backup,
      file: "'shop.sql'",
    });
    expect(guide).toContain("Restore as a user of its own");
    expect(guide).toContain("SQL SECURITY DEFINER, triggers and events");
    expect(guide).toContain("creates them disabled");
  });
});
