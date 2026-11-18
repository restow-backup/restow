package dbrun

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// The MySQL and MariaDB programs (16 "D4" M2, M3), like packages/core
// databases/mysql-tools.ts: fixed argument lists, the password only in an
// option file (0600, in the run's private folder) that is the only one the
// program reads (--defaults-file), the relay's socket. Programs only from
// trusted paths (TrustedTool), never across the family.

// MysqlTools are the dump program and the client of one family.
type MysqlTools struct {
	Family string
	Major  int
	Minor  int
	Dump   string
	Client string
}

var (
	mariaFrom    = regexp.MustCompile(`from (\d+)\.(\d+)\.\d+-MariaDB`)
	mariaDistrib = regexp.MustCompile(`Distrib (\d+)\.(\d+)\.\d+-MariaDB`)
	mysqlVer     = regexp.MustCompile(`Ver (\d+)\.(\d+)\.\d+`)
	serverVer    = regexp.MustCompile(`^(?:5\.5\.5-)?(\d+)\.(\d+)`)
)

// MysqlToolVersion reads the family and version of a program's --version.
func MysqlToolVersion(text string) (family string, major, minor int, ok bool) {
	for _, re := range []*regexp.Regexp{mariaFrom, mariaDistrib} {
		if m := re.FindStringSubmatch(text); m != nil {
			a, _ := strconv.Atoi(m[1])
			b, _ := strconv.Atoi(m[2])
			return "mariadb", a, b, true
		}
	}
	if strings.Contains(strings.ToLower(text), "mariadb") {
		return "", 0, 0, false
	}
	if m := mysqlVer.FindStringSubmatch(text); m != nil {
		a, _ := strconv.Atoi(m[1])
		b, _ := strconv.Atoi(m[2])
		if a >= 8 {
			return "mysql", a, b, true
		}
	}
	return "", 0, 0, false
}

// MysqlServerVersion is the major and minor version of a server's version.
func MysqlServerVersion(v string) (int, int) {
	m := serverVer.FindStringSubmatch(v)
	if m == nil {
		return 0, 0
	}
	a, _ := strconv.Atoi(m[1])
	b, _ := strconv.Atoi(m[2])
	return a, b
}

// MysqlToolDirs are where the programs may lie: the packages, Homebrew, PATH.
func MysqlToolDirs() []string {
	dirs := []string{"/usr/bin", "/usr/local/bin", "/usr/local/mysql/bin", "/opt/mysql/bin"}
	for _, pattern := range []string{"/opt/homebrew/opt/mysql*/bin", "/opt/homebrew/opt/mariadb*/bin", "/usr/local/opt/mysql*/bin", "/usr/local/opt/mariadb*/bin"} {
		matches, _ := filepath.Glob(pattern)
		dirs = append(dirs, matches...)
	}
	dirs = append(dirs, filepath.SplitList(os.Getenv("PATH"))...)
	seen := map[string]bool{}
	var out []string
	for _, d := range dirs {
		if d != "" && !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	return out
}

func atLeast(a, b, c, d int) bool { return a > c || (a == c && b >= d) }

// ChooseMysqlTools picks the programs for a server of family and version:
// never across the family; MySQL needs 8.4 or newer and at least the server's
// version; MariaDB takes the newest. Only trusted programs, run by their
// checked, resolved path (also for --version).
func ChooseMysqlTools(ctx context.Context, family string, serverMajor, serverMinor int, dirs []string, trusted func(string) (string, error)) (MysqlTools, error) {
	if trusted == nil {
		trusted = TrustedTool
	}
	pairs := [][2]string{{"mysqldump", "mysql"}}
	if family == "mariadb" {
		pairs = [][2]string{{"mariadb-dump", "mariadb"}, {"mysqldump", "mysql"}}
	}
	var found []MysqlTools
	var skipped []string
	seen := map[string]bool{}
	for _, dir := range dirs {
		for _, pair := range pairs {
			dump, client := filepath.Join(dir, pair[0]), filepath.Join(dir, pair[1])
			if st, err := os.Stat(dump); err != nil || st.IsDir() {
				continue
			}
			if st, err := os.Stat(client); err != nil || st.IsDir() {
				continue
			}
			rd, err := trusted(dump)
			if err != nil {
				skipped = append(skipped, err.Error())
				continue
			}
			rc, err := trusted(client)
			if err != nil {
				skipped = append(skipped, err.Error())
				continue
			}
			if seen[rd] {
				continue
			}
			seen[rd] = true
			vctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			out, err := exec.CommandContext(vctx, rd, "--version").Output() // #nosec G204 -- a fixed argument
			cancel()
			if err != nil {
				continue
			}
			fam, major, minor, ok := MysqlToolVersion(string(out))
			if !ok {
				continue
			}
			found = append(found, MysqlTools{Family: fam, Major: major, Minor: minor, Dump: rd, Client: rc})
		}
	}
	var same []MysqlTools
	for _, t := range found {
		if t.Family == family {
			same = append(same, t)
		}
	}
	sort.SliceStable(same, func(i, j int) bool { return atLeast(same[i].Major, same[i].Minor, same[j].Major, same[j].Minor+1) })
	if len(same) == 0 {
		msg := "mariadb-dump and mariadb were not found on this machine. A MySQL client never dumps a MariaDB server."
		if family == "mysql" {
			msg = "mysqldump and mysql of MySQL 8.4 or newer were not found on this machine. A MariaDB client never dumps a MySQL server."
		}
		if len(skipped) > 0 {
			msg += " Skipped as not safe to run: " + strings.Join(skipped[:min(3, len(skipped))], "; ")
		}
		return MysqlTools{}, &ToolError{Code: "db_tool_missing", Message: msg}
	}
	best := same[0]
	if family == "mysql" && (!atLeast(best.Major, best.Minor, 8, 4) || !atLeast(best.Major, best.Minor, serverMajor, serverMinor)) {
		return MysqlTools{}, &ToolError{Code: "db_tool_too_old", Message: fmt.Sprintf("mysqldump %d.%d found, the server runs MySQL %d.%d. Install the MySQL client 8.4 or newer, at least the server's version.", best.Major, best.Minor, serverMajor, serverMinor)}
	}
	return best, nil
}

// MysqlOptionValue quotes an option value for the option file parser.
func MysqlOptionValue(v string) string {
	r := strings.NewReplacer(`\`, `\\`, "\n", `\n`, "\r", `\r`, "\t", `\t`, "\b", `\b`)
	return `"` + r.Replace(v) + `"`
}

// MysqlOptionFile is the option file: user, password, the relay's socket.
func MysqlOptionFile(user, password, socket string) string {
	var b strings.Builder
	b.WriteString("[client]\n")
	b.WriteString("user=" + MysqlOptionValue(user) + "\n")
	if password != "" {
		b.WriteString("password=" + MysqlOptionValue(password) + "\n")
	}
	b.WriteString("socket=" + MysqlOptionValue(socket) + "\n")
	b.WriteString("protocol=SOCKET\n")
	// No LOAD DATA LOCAL: the client (mysql, mariadb, both read [mysql]) never
	// sends a local file. The dump programs have no such option and refuse a
	// server's request for one.
	b.WriteString("[mysql]\nlocal-infile=0\n")
	return b.String()
}

// WriteMysqlOptionFile writes it with 0600 into dir.
func WriteMysqlOptionFile(dir, user, password, socket string) (string, error) {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	path := filepath.Join(dir, "my-"+hex.EncodeToString(b)+".cnf")
	if strings.ContainsRune(user+password+socket, 0) {
		return "", fmt.Errorf("a NUL byte cannot be part of an option value")
	}
	if err := os.WriteFile(path, []byte(MysqlOptionFile(user, password, socket)), 0o600); err != nil {
		return "", err
	}
	return path, os.Chmod(path, 0o600)
}

// MysqlToolEnv is a program's whole environment (HOME is the private folder).
func MysqlToolEnv(dir string) []string {
	return []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8", "TZ=UTC", "HOME=" + dir}
}

// MysqlDumpArgs: one schema, without --databases (5.3).
func MysqlDumpArgs(optionFile, family, schema string) []string {
	args := []string{"--defaults-file=" + optionFile, "--single-transaction", "--quick", "--routines", "--events", "--triggers", "--hex-blob", "--default-character-set=utf8mb4", "--no-tablespaces", "--skip-add-locks"}
	if family == "mysql" {
		args = append(args, "--set-gtid-purged=OFF", "--column-statistics=0")
	}
	return append(args, "--", schema)
}

// MariadbUsersArgs: MariaDB's users and grants.
func MariadbUsersArgs(optionFile string) []string {
	return []string{"--defaults-file=" + optionFile, "--system=users", "--skip-add-locks", "--default-character-set=utf8mb4"}
}

// MysqlRestoreArgs: the client into the new schema, stop at the first error.
func MysqlRestoreArgs(optionFile, database string) []string {
	return []string{"--defaults-file=" + optionFile, "--database=" + database, "--default-character-set=utf8mb4", "--max-allowed-packet=1073741824", "--binary-mode", "--batch"}
}

var mysqlClientError = regexp.MustCompile(`\bERROR (\d{4}) \(`)

// MysqlClientFailureCode is the run's code for what the client wrote to stderr
// when it stopped (core mysqlClientFailureCode): a missing right for 1044,
// 1142, 1227, 1370 and 1419 (a routine or trigger while the binary log is on,
// without SUPER or log_bin_trust_function_creators).
func MysqlClientFailureCode(stderr string) string {
	if m := mysqlClientError.FindStringSubmatch(stderr); m != nil {
		switch m[1] {
		case "1044", "1142", "1227", "1370", "1419":
			return "db_permission_missing"
		}
	}
	return "db_restore_failed"
}

// MysqlQuoteIdent is an identifier in backticks.
func MysqlQuoteIdent(name string) string { return "`" + strings.ReplaceAll(name, "`", "``") + "`" }

// ValidMysqlName: 1 to 64 characters of the BMP, no control character, no
// blank at the end (16 "D4" M3).
func ValidMysqlName(name string) bool {
	if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > 64 || strings.TrimRight(name, " \t") != name {
		return false
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f || r > 0xffff {
			return false
		}
	}
	return true
}

// DumpFileName is a dump's file in the repository (core dbDumpFileName).
func DumpFileName(engine, kind, name string) string {
	safe := strings.NewReplacer("/", "_", `\`, "_").Replace(name)
	if engine == "postgresql" {
		if kind == "globals" {
			return "postgresql/globals.sql"
		}
		return "postgresql/" + safe + ".pgdump"
	}
	if kind == "globals" {
		return engine + "/users.sql"
	}
	return engine + "/" + safe + ".sql"
}
