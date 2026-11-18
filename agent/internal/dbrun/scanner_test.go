package dbrun

import (
	"bytes"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

var sampleDump = strings.Join([]string{
	"-- MySQL dump 10.13  Distrib 8.4.3, for Linux (x86_64)",
	"/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;",
	"",
	"DROP TABLE IF EXISTS `orders`;",
	"CREATE TABLE `orders` (",
	"  `id` int NOT NULL,",
	"  PRIMARY KEY (`id`)",
	") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;",
	"INSERT INTO `orders` VALUES (1,'CREATE DEFINER=`x`@`%` PROCEDURE `evil`()'),(2,'\\nCREATE TABLE `fake` (');",
	"/*!50001 CREATE VIEW `cheap` AS SELECT 1 AS `id`*/;",
	"/*!50003 CREATE*/ /*!50017 DEFINER=`app`@`%`*/ /*!50003 TRIGGER `t1` BEFORE INSERT ON `orders` FOR EACH ROW SET NEW.id = 1 */;;",
	"DELIMITER ;;",
	"/*!50106 CREATE*/ /*!50117 DEFINER=`app`@`%`*/ /*!50106 EVENT `nightly` ON SCHEDULE EVERY 1 DAY DO DELETE FROM orders */ ;;",
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
	"/*!50001 CREATE ALGORITHM=UNDEFINED */",
	"/*!50013 DEFINER=`app`@`%` SQL SECURITY DEFINER */",
	"/*!50001 VIEW `cheap` AS select `orders`.`id` AS `id` from `orders` */;",
	"-- Dump completed",
	"",
}, "\n")

func scanAll(text string, strip bool, chunk int) (string, *MysqlDumpScanner) {
	s := NewMysqlDumpScanner(strip)
	in := []byte(text)
	var out bytes.Buffer
	if chunk <= 0 {
		chunk = len(in)
	}
	for off := 0; off < len(in); off += chunk {
		end := min(off+chunk, len(in))
		out.Write(s.Push(in[off:end]))
	}
	out.Write(s.End())
	return out.String(), s
}

// claim: DB-007
func TestDumpScannerCountsOnlyStatementHeaders(t *testing.T) {
	out, s := scanAll(sampleDump, false, 0)
	if out != sampleDump {
		t.Fatal("the counter changed the dump")
	}
	want := map[string]int{"TABLE": 1, "TRIGGER": 1, "EVENT": 1, "PROCEDURE": 1, "FUNCTION": 1, "VIEW": 1}
	if !reflect.DeepEqual(s.Counts, want) {
		t.Fatalf("counts %v", s.Counts)
	}
	for _, size := range []int{1, 7, 64, 4096} {
		if _, c := scanAll(sampleDump, false, size); !reflect.DeepEqual(c.Counts, want) {
			t.Fatalf("chunk %d: %v", size, c.Counts)
		}
		a, _ := scanAll(sampleDump, true, size)
		b, _ := scanAll(sampleDump, true, 0)
		if a != b {
			t.Fatalf("chunk %d rewrites differently", size)
		}
	}
}

// claim: DB-008
func TestDefinerFilterTouchesOnlyHeaderForms(t *testing.T) {
	out, s := scanAll(sampleDump, true, 0)
	if s.DefinersRemoved != 5 {
		t.Fatalf("removed %d", s.DefinersRemoved)
	}
	for _, want := range []string{
		"/*!50003 CREATE*/ /*!50003 TRIGGER `t1` BEFORE INSERT",
		"/*!50106 CREATE*/ /*!50106 EVENT `nightly` ON SCHEDULE EVERY 1 DAY DISABLE DO DELETE FROM orders */ ;;",
		"\nCREATE PROCEDURE `cleanup`()\n",
		"\nCREATE FUNCTION `f`() RETURNS int\n",
		"\n/*!50013 SQL SECURITY DEFINER */\n",
		"INSERT INTO `orders` VALUES (1,'CREATE DEFINER=`x`@`%` PROCEDURE `evil`()')",
		"\nCREATE DEFINER=`root`@`%` PROCEDURE `not_a_header`();\n",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q", want)
		}
	}
	tricky := strings.Join([]string{
		"INSERT INTO `t` VALUES ('a;;');",
		"INSERT INTO `t` VALUES ('/*!50003 CREATE*/ /*!50017 DEFINER=`a`@`b`*/ /*!50003 TRIGGER');",
		"CREATE DEFINER=root@localhost PROCEDURE `p`()",
		"BEGIN END;",
		"CREATE TABLE `x` (",
		"CREATE DEFINER=`a`@`b` PROCEDURE `q`()",
		");",
		"/*!50013 DEFINER=`a`@`b` SQL SECURITY DEFINER */",
		"",
	}, "\n")
	if got, s := scanAll(tricky, true, 3); got != tricky || s.DefinersRemoved != 0 {
		t.Fatalf("a look-alike was rewritten: %q", got)
	}
	blob := "INSERT INTO `t` VALUES (0x" + strings.Repeat("ab", 200000) + ");"
	header := "CREATE DEFINER=`a`@`b` PROCEDURE `p`(" + strings.Repeat("x int,", 20000) + "y int)"
	long := blob + "\n" + header + "\nBEGIN END;\n"
	params := strings.Repeat("x int,", 20000) + "y int"
	for _, chunk := range []int{0, 1000} {
		got, s := scanAll(long, true, chunk)
		if got != blob+"\nCREATE PROCEDURE `p`("+params+")\nBEGIN END;\n" || s.Counts["PROCEDURE"] != 1 || s.DefinersRemoved != 1 || s.Failure != "" {
			t.Fatalf("chunk %d: a long header was not rewritten within its beginning", chunk)
		}
	}
	if got, _ := scanAll(long, false, 1000); got != long {
		t.Fatal("the counter changed a long line")
	}
	raw := "CREATE DEFINER=`a`@`b` PROCEDURE `p\xe9`()\r\nBEGIN END;\r\n\xff\xfe\n"
	if got, _ := scanAll(raw, true, 5); got != "CREATE PROCEDURE `p\xe9`()\r\nBEGIN END;\r\n\xff\xfe\n" {
		t.Fatalf("bytes changed: %q", got)
	}
}

// claim: DB-002
func TestMysqlProgramsGetFixedArguments(t *testing.T) {
	dump := MysqlDumpArgs("/dev/shm/x/my.cnf", "mysql", "--evil")
	if dump[0] != "--defaults-file=/dev/shm/x/my.cnf" || dump[len(dump)-2] != "--" || dump[len(dump)-1] != "--evil" {
		t.Fatalf("dump args %v", dump)
	}
	joined := strings.Join(dump, " ")
	for _, want := range []string{"--single-transaction", "--set-gtid-purged=OFF", "--skip-add-locks"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %s", want)
		}
	}
	if strings.Contains(strings.Join(MysqlDumpArgs("/f", "mariadb", "a"), " "), "gtid") || strings.Contains(strings.Join(MysqlRestoreArgs("/f", "a"), " "), "--force") {
		t.Fatal("wrong family arguments")
	}
	file := MysqlOptionFile("backup", "p\"a\\s s\nw#'", "/dev/shm/r/mysqld.sock")
	if file != "[client]\nuser=\"backup\"\npassword=\"p\"a\\\\s s\\nw#'\"\nsocket=\"/dev/shm/r/mysqld.sock\"\nprotocol=SOCKET\n[mysql]\nlocal-infile=0\n" {
		t.Fatalf("option file %q", file)
	}
	for text, want := range map[string]string{
		"mysqldump  Ver 8.4.3 for Linux on x86_64 (MySQL Community Server - GPL)":      "mysql 8.4",
		"mariadb-dump from 11.8.2-MariaDB, client 10.19 for debian-linux-gnu (x86_64)": "mariadb 11.8",
		"mysqldump  Ver 10.19 Distrib 10.11.6-MariaDB, for debian-linux-gnu (x86_64)":  "mariadb 10.11",
	} {
		fam, a, b, ok := MysqlToolVersion(text)
		if !ok || fam+" "+itoa(a)+"."+itoa(b) != want {
			t.Fatalf("%s: %s %d.%d", text, fam, a, b)
		}
	}
	if !ValidMysqlName(strings.Repeat("ä", 64)) || ValidMysqlName(strings.Repeat("a", 65)) || ValidMysqlName("a ") || ValidMysqlName("a\nb") || ValidMysqlName("a😀") {
		t.Fatal("names")
	}
	if DumpFileName("mariadb", "database", "a/b") != "mariadb/a_b.sql" || DumpFileName("mysql", "globals", "") != "mysql/users.sql" || DumpFileName("postgresql", "database", "x") != "postgresql/x.pgdump" {
		t.Fatal("file names")
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

func TestMysqlClientFailureCodes(t *testing.T) {
	for text, want := range map[string]string{
		"ERROR 1419 (HY000) at line 81: You do not have the SUPER privilege and binary logging is enabled": "db_permission_missing",
		"ERROR 1227 (42000) at line 9: Access denied":                                                      "db_permission_missing",
		"ERROR 1064 (42000) at line 3: You have an error":                                                  "db_restore_failed",
		"": "db_restore_failed",
	} {
		if got := MysqlClientFailureCode(text); got != want {
			t.Errorf("%q: %s, want %s", text, got, want)
		}
	}
}

// claim: DB-008
func TestDefinerFilterStopsAtAHeaderItCannotCheck(t *testing.T) {
	long := strings.Repeat("n", 70000)
	for i, text := range []string{
		"CREATE DEFINER=`" + long + "`@`b` PROCEDURE `p`()\nBEGIN END;\n",
		"/*!50003 CREATE*/ /*!50017 DEFINER=`" + long + "`@`%`*/ /*!50003 TRIGGER `t` BEFORE INSERT ON `x` FOR EACH ROW SET @a = 1 */;\n",
		"/*!50106 CREATE*/ /*!50106 EVENT `e` ON SCHEDULE EVERY 1 DAY ON COMPLETION NOT PRESERVE ENABLE COMMENT '" + long + "' DO SELECT 1 */ ;\n",
		"/*!50001 CREATE ALGORITHM=UNDEFINED */\n/*!50013 DEFINER=`" + long + "`@`%` SQL SECURITY DEFINER */\n/*!50001 VIEW `v` AS select 1 */;\n",
	} {
		for _, chunk := range []int{0, 4096} {
			out, s := scanAll("SELECT 1;\n"+text+"INSERT INTO `t` VALUES (1);\n", true, chunk)
			if !strings.Contains(s.Failure, "header") || strings.Contains(out, long[:100]) || strings.Contains(out, "INSERT") {
				t.Fatalf("case %d chunk %d: %q", i, chunk, s.Failure)
			}
		}
	}
	var sink bytes.Buffer
	f := &definerFilter{w: &sink, s: NewMysqlDumpScanner(true)}
	if _, err := f.Write([]byte("/*!50106 CREATE*/ /*!50106 EVENT `e` ON SCHEDULE EVERY 1 DAY COMMENT 'x\n")); err == nil || !strings.Contains(err.Error(), "event header") {
		t.Fatalf("write %v", err)
	}
}

// claim: DB-008
func TestDefinerFilterNeverCreatesAnEventEnabled(t *testing.T) {
	event := func(rest string) string {
		return "/*!50106 CREATE*/ /*!50117 DEFINER=`a`@`%`*/ /*!50106 EVENT `e` " + rest + " */ ;;"
	}
	line := func(rest string) (string, *MysqlDumpScanner) {
		out, s := scanAll("DELIMITER ;;\n"+event(rest)+"\nDELIMITER ;\n", true, 3)
		parts := strings.Split(out, "\n")
		if len(parts) < 2 {
			return "", s
		}
		return parts[1], s
	}
	for rest, want := range map[string]string{
		"ON SCHEDULE AT CURRENT_TIMESTAMP ON COMPLETION PRESERVE ENABLE DO INSERT INTO t VALUES (1)":                      "ON SCHEDULE AT CURRENT_TIMESTAMP ON COMPLETION PRESERVE DISABLE DO INSERT INTO t VALUES (1)",
		"ON SCHEDULE EVERY 1 SECOND DO SET @a = 'ENABLE'":                                                                 "ON SCHEDULE EVERY 1 SECOND DISABLE DO SET @a = 'ENABLE'",
		"ON SCHEDULE EVERY 1 DAY ON COMPLETION NOT PRESERVE ENABLE COMMENT 'it''s \\' ENABLE DO x' DO SELECT 'ENABLE DO'": "ON SCHEDULE EVERY 1 DAY ON COMPLETION NOT PRESERVE DISABLE COMMENT 'it''s \\' ENABLE DO x' DO SELECT 'ENABLE DO'",
		"ON SCHEDULE EVERY 1 DAY DISABLE ON SLAVE DO SELECT 1":                                                            "ON SCHEDULE EVERY 1 DAY DISABLE ON SLAVE DO SELECT 1",
	} {
		got, s := line(rest)
		if got != "/*!50106 CREATE*/ /*!50106 EVENT `e` "+want+" */ ;;" || s.EventsDisabled != 1 {
			t.Fatalf("%q became %q", rest, got)
		}
	}
	if got, s := line("ON SCHEDULE EVERY 1 DAY COMMENT 'open"); !strings.Contains(s.Failure, "event") || strings.Contains(got, "EVENT") {
		t.Fatalf("an unchecked event header passed: %q", got)
	}
	if out, _ := scanAll("DELIMITER ;;\n"+event("ON SCHEDULE EVERY 1 DAY ENABLE DO SELECT 1")+"\n", false, 0); !strings.Contains(out, "ENABLE DO SELECT 1") {
		t.Fatal("a backup changed an event")
	}
}
