import { describe, expect, it } from "vitest";
import { formatDbAddress, parseDbAddress } from "./address.js";
import { dbExecutorRefusal, isDbSystemDatabase } from "./model.js";

describe("the address field (docs/DATABASES.md 3.1)", () => {
  it("takes URLs and hands user and password back without keeping them in the address", () => {
    const parsed = parseDbAddress(
      "postgresql://backup:p%40ss@db.example.com:6432/app?sslmode=disable",
    );
    expect(parsed).toEqual({
      ok: true,
      address: {
        kind: "network",
        host: "db.example.com",
        port: 6432,
        engineHint: "postgresql",
        database: "app",
      },
      user: "backup",
      password: "p@ss",
    });
    if (parsed.ok && parsed.address.kind === "network") {
      expect(formatDbAddress(parsed.address)).toBe("db.example.com:6432");
    }
    expect(parseDbAddress("postgres://db.example.com")).toMatchObject({
      ok: true,
      address: { engineHint: "postgresql", port: null },
      user: null,
      password: null,
    });
    expect(parseDbAddress("mysql://root@10.0.0.5")).toMatchObject({
      ok: true,
      address: { host: "10.0.0.5", engineHint: "mysql" },
      user: "root",
      password: null,
    });
    expect(parseDbAddress("mariadb://[2001:db8::5]:3307")).toMatchObject({
      ok: true,
      address: { host: "2001:db8::5", port: 3307, engineHint: "mariadb" },
    });
    expect(parseDbAddress("sqlserver://sql01.corp.example:1433;database=erp")).toMatchObject({
      ok: true,
      address: { host: "sql01.corp.example", port: 1433, engineHint: "sqlserver" },
    });
  });

  it("takes host and port, a bare host, and IPv6 literals", () => {
    expect(parseDbAddress(" DB01:5432 ")).toMatchObject({
      ok: true,
      address: { kind: "network", host: "db01", port: 5432, engineHint: null },
    });
    expect(parseDbAddress("db01")).toMatchObject({
      ok: true,
      address: { host: "db01", port: null },
    });
    expect(parseDbAddress("[fd00::1]:3306")).toMatchObject({
      ok: true,
      address: { host: "fd00::1", port: 3306 },
    });
    expect(parseDbAddress("fd00::1")).toMatchObject({
      ok: true,
      address: { host: "fd00::1", port: null },
    });
    expect(formatDbAddress({ host: "fd00::1", port: 3306 })).toBe("[fd00::1]:3306");
  });

  it("takes file paths as SQLite", () => {
    expect(parseDbAddress("/var/lib/app/data.db")).toMatchObject({
      ok: true,
      address: { kind: "file", path: "/var/lib/app/data.db", engineHint: "sqlite" },
    });
    expect(parseDbAddress("sqlite:///var/lib/app.db")).toMatchObject({
      ok: true,
      address: { kind: "file", path: "/var/lib/app.db" },
    });
    expect(parseDbAddress("C:\\data\\app.db")).toMatchObject({
      ok: true,
      address: { kind: "file" },
    });
  });

  it("refuses what is no address", () => {
    expect(parseDbAddress("")).toEqual({ ok: false, reason: "empty" });
    expect(parseDbAddress("ftp://example.com")).toEqual({ ok: false, reason: "scheme" });
    expect(parseDbAddress("db01:99999")).toEqual({ ok: false, reason: "port" });
    expect(parseDbAddress("db01:abc")).toEqual({ ok: false, reason: "port" });
    expect(parseDbAddress("bad host")).toEqual({ ok: false, reason: "host" });
    expect(parseDbAddress("a\nb")).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("executors (4.1, 4.2)", () => {
  it("lets the server open PostgreSQL, MySQL and MariaDB with a password only", () => {
    expect(dbExecutorRefusal("server", "postgresql", "password")).toBeNull();
    expect(dbExecutorRefusal("server", "mariadb", "password")).toBeNull();
    expect(dbExecutorRefusal("server", null, "password")).toBeNull();
    expect(dbExecutorRefusal("server", "sqlserver", "password")).toBe("engine_needs_agent");
    expect(dbExecutorRefusal("server", "sqlite", "password")).toBe("engine_needs_agent");
    expect(dbExecutorRefusal("server", "postgresql", "socket")).toBe("socket_needs_agent");
    expect(dbExecutorRefusal("agent", "sqlite", "socket")).toBeNull();
  });

  it("knows the system databases", () => {
    expect(isDbSystemDatabase("postgresql", "template1")).toBe(true);
    expect(isDbSystemDatabase("postgresql", "postgres")).toBe(false);
    expect(isDbSystemDatabase("mysql", "performance_schema")).toBe(true);
    expect(isDbSystemDatabase("mariadb", "app")).toBe(false);
  });
});
