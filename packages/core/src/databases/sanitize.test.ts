import { describe, expect, it } from "vitest";
import { parseDbInventory, parseDbProbeResult } from "./facts.js";
import {
  compareDbInstance,
  dbFoundDatabases,
  dbInstanceIdentityOf,
  dbInstanceKey,
} from "./identity.js";
import { redactIdentifiedBy, sanitizeDbMessage } from "./sanitize.js";

describe("error texts without credentials (docs/DATABASES.md 10) [DB-002]", () => {
  it("removes URLs with credentials, the user, the password and connection-string secrets", () => {
    const message =
      "connection to postgres://backup:Hunter2!x@db:5432/app failed: password authentication failed for user \"backup_user\" (password=Hunter2!x; pwd='other')";
    const clean = sanitizeDbMessage(message, { user: "backup_user", password: "Hunter2!x" });
    expect(clean).not.toContain("Hunter2!x");
    expect(clean).not.toContain("backup_user");
    expect(clean).not.toContain("other");
    expect(clean).toContain("postgres://***@db:5432/app");
    expect(clean).toContain('for user "***"');
  });

  it("removes the secret of IDENTIFIED BY clauses and bounds the length", () => {
    expect(
      redactIdentifiedBy(
        "GRANT USAGE ON *.* TO `u`@`%` IDENTIFIED BY PASSWORD '*6BB4837EB74329105EE4568DDA7DC67ED2CA2AD9'",
      ),
    ).toBe("GRANT USAGE ON *.* TO `u`@`%` IDENTIFIED BY PASSWORD '***'");
    expect(
      redactIdentifiedBy("CREATE USER x IDENTIFIED VIA ed25519 USING PASSWORD('secret')"),
    ).toBe("CREATE USER x IDENTIFIED VIA ed25519 USING '***'");
    expect(sanitizeDbMessage("x".repeat(2000)).length).toBe(500);
    expect(sanitizeDbMessage("line\u0000one\nline two")).toBe("line one line two");
  });

  it("keeps a two-letter user name (it would replace letters everywhere)", () => {
    expect(sanitizeDbMessage("access denied for sa", { user: "sa" })).toBe("access denied for sa");
  });
});

describe("identity (3.3) and the contract of a result", () => {
  const result = parseDbProbeResult({
    engine: "postgresql",
    port: 5432,
    serverVersion: "16.4",
    tls: {
      offered: true,
      used: true,
      fingerprintSha256: "not-a-fingerprint",
      subject: null,
      issuer: null,
      notAfter: null,
    },
    login: "ok",
    error: null,
    postgresql: {
      versionNum: 160004,
      version: "PostgreSQL 16.4",
      currentUser: "app",
      superuser: false,
      createDb: false,
      replication: false,
      readAllData: true,
      systemIdentifier: "7701435355509418483",
      databases: [
        { name: "template1", oid: "1", allowConnections: true, canConnect: true, sizeBytes: 1 },
        { name: "app", oid: "16384", allowConnections: true, canConnect: true, sizeBytes: 8 },
      ],
    },
    durationMs: 40,
  });

  it("reads a result, dropping a malformed fingerprint instead of the result", () => {
    expect(result?.tls.fingerprintSha256).toBeNull();
    expect(parseDbProbeResult({ engine: "oracle" })).toBeNull();
  });

  it("names the instance and the databases; another instance is a change", () => {
    if (!result) throw new Error("no result");
    const identity = dbInstanceIdentityOf(result);
    expect(identity).toEqual({ engine: "postgresql", systemIdentifier: "7701435355509418483" });
    if (!identity) throw new Error("no identity");
    const key = dbInstanceKey(identity);
    expect(compareDbInstance(key, identity)).toBe("same");
    expect(compareDbInstance(key, { engine: "postgresql", systemIdentifier: "1" })).toBe("changed");
    expect(compareDbInstance(null, identity)).toBe("unknown");
    expect(dbFoundDatabases(result)).toEqual([
      { name: "app", identity: "16384", sizeBytes: 8, accessible: true },
    ]);
  });

  it("names a MariaDB instance by server id and data directory, MySQL by its UUID", () => {
    const base = parseDbProbeResult({
      engine: "mariadb",
      port: 3306,
      serverVersion: "11.8.2",
      tls: {
        offered: false,
        used: false,
        fingerprintSha256: null,
        subject: null,
        issuer: null,
        notAfter: null,
      },
      login: "ok",
      error: null,
      mysql: {
        version: "11.8.2-MariaDB",
        versionComment: null,
        currentUser: "u@%",
        grants: [],
        serverUuid: null,
        serverId: 3,
        datadir: "/var/lib/mysql/",
        logBin: false,
        binlogFormat: "MIXED",
        databases: [
          { name: "mysql", sizeBytes: 1 },
          { name: "shop", sizeBytes: null },
        ],
      },
      durationMs: 1,
    });
    if (!base) throw new Error("no result");
    const identity = dbInstanceIdentityOf(base);
    expect(identity && dbInstanceKey(identity)).toBe("mariadb:3:/var/lib/mysql/");
    expect(dbFoundDatabases(base).map((database) => database.name)).toEqual(["shop"]);
  });

  it("reads an inventory and drops malformed instances one by one", () => {
    expect(
      parseDbInventory({
        collectedAt: "2026-11-17T10:00:00Z",
        instances: [
          {
            engine: "postgresql",
            source: "pg_lsclusters",
            name: "16/main",
            version: "16",
            port: 5432,
            socket: "/var/run/postgresql",
            container: null,
            running: true,
          },
          { engine: "oracle", source: "systemd", name: "x" },
        ],
      })?.instances.map((instance) => instance.name),
    ).toEqual(["16/main"]);
    expect(parseDbInventory({ collectedAt: "yesterday", instances: [] })).toBeNull();
    expect(parseDbInventory(null)).toBeNull();
  });
});
