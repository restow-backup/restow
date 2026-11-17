import { describe, expect, it } from "vitest";
import type { DbMysqlFacts, DbPostgresFacts, DbProbeResult } from "./facts.js";
import { evaluateDbRights, parseMysqlGrant } from "./rights.js";

const base: DbProbeResult = {
  engine: "postgresql",
  port: 5432,
  serverVersion: "16.4",
  tls: {
    offered: true,
    used: true,
    fingerprintSha256: null,
    subject: null,
    issuer: null,
    notAfter: null,
  },
  login: "ok",
  error: null,
  durationMs: 12,
};

function pg(facts: Partial<DbPostgresFacts>): DbProbeResult {
  return {
    ...base,
    postgresql: {
      versionNum: 160004,
      version: "PostgreSQL 16.4",
      currentUser: "app",
      superuser: false,
      createDb: false,
      replication: false,
      readAllData: false,
      systemIdentifier: "7701435355509418483",
      databases: [
        { name: "app", oid: "16384", allowConnections: true, canConnect: true, sizeBytes: 1 },
      ],
      ...facts,
    },
  };
}

function my(engine: "mysql" | "mariadb", facts: Partial<DbMysqlFacts>): DbProbeResult {
  return {
    ...base,
    engine,
    mysql: {
      version: "8.4.3",
      versionComment: null,
      currentUser: "u@%",
      grants: [],
      serverUuid: null,
      serverId: 1,
      datadir: "/var/lib/mysql/",
      logBin: true,
      binlogFormat: "ROW",
      databases: [],
      ...facts,
    },
  };
}

describe("rights matrix (docs/DATABASES.md 3.2)", () => {
  it("PostgreSQL: a superuser can do everything but pg_hba.conf is not visible", () => {
    const rights = evaluateDbRights(pg({ superuser: true }));
    expect(rights?.admin).toBe(true);
    expect(rights?.capabilities.backup.state).toBe("granted");
    expect(rights?.capabilities.verifyOnInstance.state).toBe("granted");
    expect(rights?.capabilities.pitr).toMatchObject({ state: "unknown", note: "pg_hba_unchecked" });
    expect(rights?.adminExtras).toEqual(["SUPERUSER"]);
    // The recommendation is still the backup user.
    expect(rights?.grantSql).toContain("CREATE ROLE restow_backup LOGIN");
  });

  it("PostgreSQL: pg_read_all_data and CREATEDB, and the SQL for what is missing", () => {
    const missing = evaluateDbRights(pg({}));
    expect(missing?.capabilities.backup).toMatchObject({
      state: "missing",
      missing: ["pg_read_all_data"],
    });
    expect(missing?.grantSql).toBe(
      [
        "CREATE ROLE restow_backup LOGIN PASSWORD '<password>';",
        "GRANT pg_read_all_data TO restow_backup;",
        "ALTER ROLE restow_backup CREATEDB;",
        "ALTER ROLE restow_backup REPLICATION;",
        "-- pg_hba.conf: host replication restow_backup <address of the executor>/32 scram-sha-256",
      ].join("\n"),
    );
    const granted = evaluateDbRights(pg({ readAllData: true, createDb: true }));
    expect(granted?.capabilities.backup.state).toBe("granted");
    expect(granted?.capabilities.verifyOnInstance.state).toBe("granted");
    expect(granted?.grantSql).not.toContain("CREATEDB");
  });

  it("PostgreSQL: a database without CONNECT makes the backup partial; before 14 it is unknown", () => {
    const partial = evaluateDbRights(
      pg({
        readAllData: true,
        databases: [
          { name: "app", oid: "1", allowConnections: true, canConnect: true, sizeBytes: null },
          { name: "hr", oid: "2", allowConnections: true, canConnect: false, sizeBytes: null },
        ],
      }),
    );
    expect(partial?.capabilities.backup).toMatchObject({
      state: "partial",
      missing: ["CONNECT hr"],
    });
    const old = evaluateDbRights(pg({ versionNum: 130012, readAllData: null }));
    expect(old?.capabilities.backup).toMatchObject({ state: "unknown", note: "pg_before_14" });
    expect(old?.grantSql).toContain("GRANT SELECT ON ALL TABLES IN SCHEMA public");
  });

  it("MySQL: global grants decide, aliases of MariaDB count, binlog off blocks point-in-time", () => {
    const backupUser = evaluateDbRights(
      my("mysql", {
        grants: [
          "GRANT USAGE ON *.* TO `restow_backup`@`%`",
          "GRANT SELECT, RELOAD, PROCESS, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER ON *.* TO `restow_backup`@`%`",
        ],
      }),
    );
    expect(backupUser?.capabilities.backup.state).toBe("granted");
    expect(backupUser?.capabilities.verifyOnInstance.state).toBe("missing");
    expect(backupUser?.grantSql).toContain("CREATE ROUTINE, ALTER ROUTINE, REPLICATION SLAVE");

    const maria = evaluateDbRights(
      my("mariadb", {
        grants: ["GRANT REPLICATION SLAVE, BINLOG MONITOR ON *.* TO `r`@`%`"],
        logBin: false,
      }),
    );
    expect(maria?.capabilities.pitr).toMatchObject({
      state: "missing",
      missing: ["log_bin"],
      note: "binlog_off",
    });

    const admin = evaluateDbRights(
      my("mariadb", {
        grants: ["GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost` WITH GRANT OPTION"],
      }),
    );
    expect(admin?.admin).toBe(true);
    expect(admin?.capabilities.verifyOnInstance.state).toBe("granted");
    expect(admin?.adminExtras).toEqual(["ALL PRIVILEGES"]);
  });

  it("MySQL: grants on one database make the backup partial, never the check", () => {
    const rights = evaluateDbRights(
      my("mysql", { grants: ["GRANT ALL PRIVILEGES ON `app`.* TO `u`@`%`"] }),
    );
    expect(rights?.capabilities.backup).toMatchObject({ state: "partial", note: "some_databases" });
    expect(rights?.capabilities.verifyOnInstance.state).toBe("missing");
  });

  it("reads grant lines", () => {
    expect(
      parseMysqlGrant("GRANT SELECT (id, name), INSERT ON `shop`.`orders` TO 'u'@'%'"),
    ).toEqual({
      privileges: ["SELECT", "INSERT"],
      scope: "shop.orders",
    });
    expect(parseMysqlGrant("GRANT `admin`@`%` TO `u`@`%`")).toEqual({
      privileges: [],
      scope: null,
    });
    expect(parseMysqlGrant("REVOKE x")).toBeNull();
  });

  it("SQLite needs no rights; SQL Server waits for its move into the module; no sign-in, no matrix", () => {
    expect(
      evaluateDbRights({
        ...base,
        engine: "sqlite",
        login: "skipped",
        sqlite: {
          path: "/var/lib/app.db",
          sizeBytes: 4096,
          pageSize: 4096,
          inode: "12",
          device: "2049",
          createdAt: null,
          modifiedAt: null,
        },
      })?.capabilities,
    ).toMatchObject({ backup: { state: "granted" }, pitr: { state: "not_applicable" } });
    expect(
      evaluateDbRights({ ...base, engine: "sqlserver", login: "skipped" })?.capabilities.backup,
    ).toMatchObject({ state: "unknown", note: "sqlserver_later" });
    expect(evaluateDbRights({ ...pg({}), login: "failed" })).toBeNull();
    expect(evaluateDbRights({ ...base, engine: null })).toBeNull();
  });
});
