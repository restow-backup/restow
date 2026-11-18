import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chooseMysqlTools,
  defaultMysqlRestoreName,
  MysqlDumpScanner,
  mysqlClientFailureCode,
  mysqlDefinerFilter,
  mysqlDumpArgs,
  mysqlOptionFile,
  mysqlRestoreArgs,
  mysqlToolVersion,
  validMysqlSchemaName,
} from "./mysql-tools.js";

/**
 * The MySQL and MariaDB programs (docs/DATABASES.md 16 "D4"): fixed arguments, the password only
 * in the option file, the family rule, and the dump read as text: the object counter and the
 * DEFINER filter of a restore, which rewrite only the header forms the dump programs write and
 * never a data line.
 */

const DUMP = [
  "-- MySQL dump 10.13  Distrib 8.4.3, for Linux (x86_64)",
  "/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;",
  "",
  "DROP TABLE IF EXISTS `orders`;",
  "/*!40101 SET @saved_cs_client     = @@character_set_client */;",
  "CREATE TABLE `orders` (",
  "  `id` int NOT NULL,",
  "  `note` text,",
  "  PRIMARY KEY (`id`)",
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;",
  "INSERT INTO `orders` VALUES (1,'CREATE DEFINER=`x`@`%` PROCEDURE `evil`()'),(2,'\\nCREATE TABLE `fake` (');",
  "/*!50001 CREATE VIEW `cheap` AS SELECT 1 AS `id`*/;",
  "/*!50003 CREATE*/ /*!50017 DEFINER=`app`@`%`*/ /*!50003 TRIGGER `t1` BEFORE INSERT ON `orders` FOR EACH ROW SET NEW.note = 'x' */;;",
  "DELIMITER ;;",
  "/*!50106 CREATE*/ /*!50117 DEFINER=`app`@`%`*/ /*!50106 EVENT `nightly` ON SCHEDULE EVERY 1 DAY STARTS '2026-01-01 00:00:00' ON COMPLETION NOT PRESERVE ENABLE DO DELETE FROM orders */ ;;",
  "DELIMITER ;",
  "DELIMITER ;;",
  "CREATE DEFINER=`app`@`localhost` PROCEDURE `cleanup`()",
  "BEGIN",
  "CREATE DEFINER=`root`@`%` PROCEDURE `not_a_header`();",
  "CREATE TABLE `inside_body` (id int);",
  "END ;;",
  "DELIMITER ;",
  "DELIMITER ;;",
  "CREATE DEFINER=`o``dd`@`h` FUNCTION `f`() RETURNS int",
  "    DETERMINISTIC",
  "RETURN 1 ;;",
  "DELIMITER ;",
  "/*!50001 DROP VIEW IF EXISTS `cheap`*/;",
  "/*!50001 CREATE ALGORITHM=UNDEFINED */",
  "/*!50013 DEFINER=`app`@`%` SQL SECURITY DEFINER */",
  "/*!50001 VIEW `cheap` AS select `orders`.`id` AS `id` from `orders` */;",
  "-- Dump completed",
  "",
].join("\n");

function scan(
  text: string,
  stripDefiners: boolean,
  chunk = 0,
): { out: string; scanner: MysqlDumpScanner } {
  const scanner = new MysqlDumpScanner({ stripDefiners });
  const input = Buffer.from(text, "utf8");
  const parts: Buffer[] = [];
  if (chunk <= 0) {
    parts.push(scanner.push(input));
  } else {
    for (let offset = 0; offset < input.length; offset += chunk) {
      parts.push(scanner.push(input.subarray(offset, offset + chunk)));
    }
  }
  parts.push(scanner.end());
  return { out: Buffer.concat(parts).toString("utf8"), scanner };
}

describe("the dump as text [DB-007]", () => {
  it("counts the objects by their statement headers only, never in data or a routine body", () => {
    const { out, scanner } = scan(DUMP, false);
    expect(out).toBe(DUMP);
    expect(scanner.counts).toEqual({
      TABLE: 1,
      TRIGGER: 1,
      EVENT: 1,
      PROCEDURE: 1,
      FUNCTION: 1,
      VIEW: 1,
    });
  });

  it("reads the same whatever the chunks, a byte at a time included", () => {
    for (const size of [1, 7, 64, 4096]) {
      expect(scan(DUMP, false, size).scanner.counts).toEqual(scan(DUMP, false).scanner.counts);
      expect(scan(DUMP, true, size).out).toBe(scan(DUMP, true).out);
    }
  });
});

describe("the DEFINER filter of a restore [DB-008]", () => {
  it("removes the definer from each header form and from nothing else", () => {
    const { out, scanner } = scan(DUMP, true);
    expect(scanner.definersRemoved).toBe(5);
    expect(out).toContain(
      "/*!50003 CREATE*/ /*!50003 TRIGGER `t1` BEFORE INSERT ON `orders` FOR EACH ROW SET NEW.note = 'x' */;;",
    );
    expect(out).toContain(
      "/*!50106 CREATE*/ /*!50106 EVENT `nightly` ON SCHEDULE EVERY 1 DAY STARTS '2026-01-01 00:00:00' ON COMPLETION NOT PRESERVE DISABLE DO DELETE FROM orders */ ;;",
    );
    expect(scanner.eventsDisabled).toBe(1);
    expect(out).toContain("\nCREATE PROCEDURE `cleanup`()\n");
    expect(out).toContain("\nCREATE FUNCTION `f`() RETURNS int\n");
    expect(out).toContain("\n/*!50013 SQL SECURITY DEFINER */\n");
    // Data and the body of a routine stay byte for byte.
    expect(out).toContain(
      "INSERT INTO `orders` VALUES (1,'CREATE DEFINER=`x`@`%` PROCEDURE `evil`()'),(2,'\\nCREATE TABLE `fake` (');",
    );
    expect(out).toContain("\nCREATE DEFINER=`root`@`%` PROCEDURE `not_a_header`();\n");
    // Only the definer clauses went (and ENABLE became DISABLE, one byte more).
    const removed = DUMP.length - out.length;
    expect(removed).toBeGreaterThan(0);
    expect(out.split("\n").length).toBe(DUMP.split("\n").length);
  });

  it("leaves a line alone that only looks like a header", () => {
    const tricky = [
      // An INSERT that ends a line with ;; and a header-looking value in the next statement.
      "INSERT INTO `t` VALUES ('a;;');",
      "INSERT INTO `t` VALUES ('/*!50003 CREATE*/ /*!50017 DEFINER=`a`@`b`*/ /*!50003 TRIGGER');",
      // A definer that is not quoted the way the dump programs quote it: unchanged.
      "CREATE DEFINER=root@localhost PROCEDURE `p`()",
      "BEGIN END;",
      // A header in the middle of a statement that has not ended.
      "CREATE TABLE `x` (",
      "CREATE DEFINER=`a`@`b` PROCEDURE `q`()",
      ");",
      // A view definer line outside a view statement.
      "/*!50013 DEFINER=`a`@`b` SQL SECURITY DEFINER */",
      "",
    ].join("\n");
    const { out, scanner } = scan(tricky, true);
    expect(out).toBe(tricky);
    expect(scanner.definersRemoved).toBe(0);
  });

  it("passes a long data line as it is and rewrites a long header within its beginning", () => {
    const blob = `INSERT INTO \`t\` VALUES (0x${"ab".repeat(200_000)});`;
    const params = `${"x int,".repeat(20_000)}y int`;
    const header = `CREATE DEFINER=\`a\`@\`b\` PROCEDURE \`p\`(${params})`;
    const text = `${blob}\n${header}\nBEGIN END;\n`;
    expect(header.length).toBeGreaterThan(64 * 1024);
    for (const chunk of [0, 1000]) {
      const { out, scanner } = scan(text, true, chunk);
      expect(out).toBe(`${blob}\nCREATE PROCEDURE \`p\`(${params})\nBEGIN END;\n`);
      expect(scanner.counts.PROCEDURE).toBe(1);
      expect(scanner.definersRemoved).toBe(1);
      expect(scanner.failure).toBeNull();
    }
    // The download keeps the line as it is.
    expect(scan(text, false, 1000).out).toBe(text);
  });

  it("stops a restore at a header longer than it can check", () => {
    const longName = "n".repeat(70_000);
    const cases = [
      // A definer that does not end within the first 64 KiB.
      `CREATE DEFINER=\`${longName}\`@\`b\` PROCEDURE \`p\`()\nBEGIN END;\n`,
      `/*!50003 CREATE*/ /*!50017 DEFINER=\`${longName}\`@\`%\`*/ /*!50003 TRIGGER \`t\` BEFORE INSERT ON \`x\` FOR EACH ROW SET @a = 1 */;\n`,
      // An event whose DO comes after the first 64 KiB.
      `/*!50106 CREATE*/ /*!50106 EVENT \`e\` ON SCHEDULE EVERY 1 DAY ON COMPLETION NOT PRESERVE ENABLE COMMENT '${longName}' DO SELECT 1 */ ;\n`,
      // A view's definer line of that length.
      `/*!50001 CREATE ALGORITHM=UNDEFINED */\n/*!50013 DEFINER=\`${longName}\`@\`%\` SQL SECURITY DEFINER */\n/*!50001 VIEW \`v\` AS select 1 */;\n`,
    ];
    for (const text of cases) {
      for (const chunk of [0, 4096]) {
        const { out, scanner } = scan(
          `SELECT 1;\n${text}INSERT INTO \`t\` VALUES (1);\n`,
          true,
          chunk,
        );
        expect(scanner.failure).toMatch(/header/);
        expect(out).not.toContain(longName.slice(0, 100));
        expect(out).not.toContain("INSERT");
      }
    }
  });

  it("never creates an event enabled, whatever its header holds", () => {
    const event = (rest: string) =>
      `/*!50106 CREATE*/ /*!50117 DEFINER=\`a\`@\`%\`*/ /*!50106 EVENT \`e\` ${rest} */ ;;`;
    const check = (rest: string) => {
      const text = `DELIMITER ;;\n${event(rest)}\nDELIMITER ;\n`;
      const { out, scanner } = scan(text, true, 3);
      return { line: out.split("\n")[1], scanner };
    };
    expect(
      check(
        "ON SCHEDULE AT CURRENT_TIMESTAMP ON COMPLETION PRESERVE ENABLE DO INSERT INTO t VALUES (1)",
      ).line,
    ).toBe(
      "/*!50106 CREATE*/ /*!50106 EVENT `e` ON SCHEDULE AT CURRENT_TIMESTAMP ON COMPLETION PRESERVE DISABLE DO INSERT INTO t VALUES (1) */ ;;",
    );
    // Without a status the server would take ENABLE: DISABLE goes in before DO.
    expect(check("ON SCHEDULE EVERY 1 SECOND DO SET @a = 'ENABLE'").line).toBe(
      "/*!50106 CREATE*/ /*!50106 EVENT `e` ON SCHEDULE EVERY 1 SECOND DISABLE DO SET @a = 'ENABLE' */ ;;",
    );
    // Words in quotes are no status; the body is never touched.
    expect(
      check(
        "ON SCHEDULE EVERY 1 DAY ON COMPLETION NOT PRESERVE ENABLE COMMENT 'it''s \\' ENABLE DO x' DO SELECT 'ENABLE DO'",
      ).line,
    ).toBe(
      "/*!50106 CREATE*/ /*!50106 EVENT `e` ON SCHEDULE EVERY 1 DAY ON COMPLETION NOT PRESERVE DISABLE COMMENT 'it''s \\' ENABLE DO x' DO SELECT 'ENABLE DO' */ ;;",
    );
    expect(
      check("ON SCHEDULE EVERY 1 DAY ON COMPLETION NOT PRESERVE DISABLE ON SLAVE DO SELECT 1").line,
    ).toContain("DISABLE ON SLAVE DO SELECT 1");
    // A quote that does not end on the line: the header cannot be checked.
    const cut = check("ON SCHEDULE EVERY 1 DAY COMMENT 'open");
    expect(cut.scanner.failure).toMatch(/event/);
    expect(cut.line ?? "").not.toContain("EVENT");
    // A backup (counting only) keeps the event as it is.
    const kept = scan(
      `DELIMITER ;;\n${event("ON SCHEDULE EVERY 1 DAY ENABLE DO SELECT 1")}\n`,
      false,
    );
    expect(kept.out).toContain("ENABLE DO SELECT 1");
  });

  it("ends the restore's stream with an error when it stops", async () => {
    const filter = mysqlDefinerFilter();
    const failed = new Promise((resolve) => filter.stream.once("error", resolve));
    filter.stream.resume();
    filter.stream.end(
      Buffer.from("/*!50106 CREATE*/ /*!50106 EVENT `e` ON SCHEDULE EVERY 1 DAY COMMENT 'x\n"),
    );
    expect(String(await failed)).toMatch(/event header/);
    expect(filter.scanner.failure).not.toBeNull();
  });

  it("keeps CRLF and bytes that are no UTF-8", () => {
    const raw = Buffer.concat([
      Buffer.from("CREATE DEFINER=`a`@`b` PROCEDURE `p\xe9`()\r\nBEGIN END;\r\n", "latin1"),
      Buffer.from([0xff, 0xfe, 0x0a]),
    ]);
    const scanner = new MysqlDumpScanner({ stripDefiners: true });
    const out = Buffer.concat([scanner.push(raw), scanner.end()]);
    expect(out.toString("latin1")).toBe(
      `CREATE PROCEDURE \`p\xe9\`()\r\nBEGIN END;\r\n${String.fromCharCode(0xff, 0xfe)}\n`,
    );
  });
});

describe("the MySQL programs [DB-002]", () => {
  it("get fixed arguments; the password lives in the option file only", () => {
    const dump = mysqlDumpArgs("/dev/shm/x/my.cnf", "mysql", "--evil");
    expect(dump[0]).toBe("--defaults-file=/dev/shm/x/my.cnf");
    expect(dump).toContain("--single-transaction");
    expect(dump).toContain("--set-gtid-purged=OFF");
    expect(dump).toContain("--skip-add-locks");
    expect(dump).not.toContain("--databases");
    // A schema named like an option is an argument after `--`.
    expect(dump.slice(-2)).toEqual(["--", "--evil"]);
    expect(mysqlDumpArgs("/f", "mariadb", "app")).not.toContain("--set-gtid-purged=OFF");
    const restore = mysqlRestoreArgs("/f", "app copy");
    expect(restore).not.toContain("--force");
    expect(restore).toContain("--database=app copy");
    const file = mysqlOptionFile({
      user: "backup",
      password: "p\"a\\s s\nw#'",
      socket: "/dev/shm/r/mysqld.sock",
    });
    expect(file).toBe(
      '[client]\nuser="backup"\npassword="p"a\\\\s s\\nw#\'"\nsocket="/dev/shm/r/mysqld.sock"\nprotocol=SOCKET\n[mysql]\nlocal-infile=0\n',
    );
    for (const args of [dump, restore]) {
      expect(args.join(" ")).not.toContain("password");
    }
  });

  it("know the family and version from --version", () => {
    expect(
      mysqlToolVersion("mysqldump  Ver 8.4.3 for Linux on x86_64 (MySQL Community Server - GPL)"),
    ).toEqual({
      family: "mysql",
      major: 8,
      minor: 4,
    });
    expect(
      mysqlToolVersion(
        "mariadb-dump from 11.8.2-MariaDB, client 10.19 for debian-linux-gnu (x86_64)",
      ),
    ).toEqual({
      family: "mariadb",
      major: 11,
      minor: 8,
    });
    expect(
      mysqlToolVersion(
        "mysqldump  Ver 10.19 Distrib 10.11.6-MariaDB, for debian-linux-gnu (x86_64)",
      ),
    ).toEqual({
      family: "mariadb",
      major: 10,
      minor: 11,
    });
    expect(mysqlToolVersion("something else")).toBeNull();
  });

  it("never cross the family, and need MySQL 8.4 or the server's version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mysql-tools-"));
    try {
      const fake = async (name: string, version: string) => {
        const path = join(dir, name);
        await writeFile(path, `#!/bin/sh\necho '${version}'\n`);
        await chmod(path, 0o755);
      };
      await fake("mariadb-dump", "mariadb-dump from 11.8.2-MariaDB, client 10.19 for linux");
      await fake("mariadb", "mariadb from 11.8.2-MariaDB, client 15.2 for linux");
      // Only MariaDB's programs: a MySQL server gets none of them.
      expect(await chooseMysqlTools("mysql", { major: 8, minor: 0 }, [dir])).toMatchObject({
        ok: false,
        code: "db_tool_missing",
      });
      expect(await chooseMysqlTools("mariadb", { major: 10, minor: 6 }, [dir])).toMatchObject({
        ok: true,
        tools: { family: "mariadb", dump: join(dir, "mariadb-dump") },
      });
      await fake("mysqldump", "mysqldump  Ver 8.0.36 for Linux on x86_64");
      await fake("mysql", "mysql  Ver 8.0.36 for Linux on x86_64");
      expect(await chooseMysqlTools("mysql", { major: 8, minor: 0 }, [dir])).toMatchObject({
        ok: false,
        code: "db_tool_too_old",
      });
      await fake("mysqldump", "mysqldump  Ver 8.4.3 for Linux on x86_64");
      expect(await chooseMysqlTools("mysql", { major: 8, minor: 0 }, [dir])).toMatchObject({
        ok: true,
        tools: { family: "mysql", version: { major: 8, minor: 4 } },
      });
      expect(await chooseMysqlTools("mysql", { major: 9, minor: 1 }, [dir])).toMatchObject({
        ok: false,
        code: "db_tool_too_old",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("names a new schema within 64 characters, without what a server refuses", () => {
    expect(validMysqlSchemaName("a".repeat(64))).toBe(true);
    expect(validMysqlSchemaName("ä".repeat(64))).toBe(true);
    expect(validMysqlSchemaName("a".repeat(65))).toBe(false);
    expect(validMysqlSchemaName("app ")).toBe(false);
    expect(validMysqlSchemaName("a\nb")).toBe(false);
    expect(validMysqlSchemaName("a😀")).toBe(false);
    expect(validMysqlSchemaName("we`ird'na\\me")).toBe(true);
    const name = defaultMysqlRestoreName("x".repeat(80), new Date("2026-11-18T10:00:00Z"));
    expect([...name]).toHaveLength(64);
    expect(name.endsWith("_restored_20261118_100000")).toBe(true);
  });

  it("tell a missing right from another failure of the client", () => {
    expect(
      mysqlClientFailureCode(
        "ERROR 1419 (HY000) at line 81: You do not have the SUPER privilege and binary logging is enabled",
      ),
    ).toBe("db_permission_missing");
    expect(mysqlClientFailureCode("ERROR 1227 (42000) at line 9: Access denied")).toBe(
      "db_permission_missing",
    );
    expect(mysqlClientFailureCode("ERROR 1064 (42000) at line 3: You have an error")).toBe(
      "db_restore_failed",
    );
    expect(mysqlClientFailureCode("")).toBe("db_restore_failed");
  });
});
