package dbrun

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/paths"
)

// The PostgreSQL programs (O2): in D3 only those on this machine, the newest
// major version that is at least as new as the server (pg_dump must be,
// 5.2). The restow-agent-dbtools package follows with D7.

// Tools are pg_dump, pg_dumpall and pg_restore of one major version.
type Tools struct {
	Major int
	Dir   string
	// resolved are the checked programs, links resolved: what runs.
	resolved map[string]string
}

// Path is the program's path: the checked, resolved one once chosen, never
// a name through a link someone could point elsewhere after the check.
func (t Tools) Path(tool string) string {
	if p, ok := t.resolved[tool]; ok {
		return p
	}
	name := tool
	if os.PathSeparator == '\\' {
		name += ".exe"
	}
	return filepath.Join(t.Dir, name)
}

// ToolError says why no programs fit, with its code.
type ToolError struct {
	Code    string
	Message string
	Found   []int
}

func (e *ToolError) Error() string { return e.Message }

var versionPattern = regexp.MustCompile(`\(PostgreSQL\)\s+(\d+)`)

// ToolMajor is the major version in a program's --version, 0 when unknown
// (before 10 the version had two parts).
func ToolMajor(text string) int {
	m := versionPattern.FindStringSubmatch(text)
	if m == nil {
		return 0
	}
	major, err := strconv.Atoi(m[1])
	if err != nil || major < 10 {
		return 0
	}
	return major
}

// ToolDirs are where the programs may lie: the packages' version
// directories (Debian, PGDG for RHEL, Homebrew), then PATH.
func ToolDirs() []string {
	var dirs []string
	for _, pattern := range []string{"/usr/lib/postgresql/*/bin", "/usr/pgsql-*/bin", "/opt/homebrew/opt/postgresql@*/bin", "/usr/local/opt/postgresql@*/bin"} {
		matches, _ := filepath.Glob(pattern)
		dirs = append(dirs, matches...)
	}
	dirs = append(dirs, filepath.SplitList(os.Getenv("PATH"))...)
	seen := map[string]bool{}
	var out []string
	for _, dir := range dirs {
		if dir != "" && !seen[dir] {
			seen[dir] = true
			out = append(out, dir)
		}
	}
	return out
}

// TrustedTool checks a program before the agent (root, LocalSystem) runs it,
// even for --version: the program and every folder above it, as named and
// where a link leads, must be owned by root (Windows: only SYSTEM,
// Administrators and TrustedInstaller may change them) and not writable by
// group or others. A pg_dump in a folder a user can write (a Homebrew
// prefix, a PATH entry) would otherwise run as root.
// It returns the resolved path, which is what must run.
func TrustedTool(path string) (string, error) {
	return paths.TrustedFile(path)
}

// recheck checks a chosen program again right before it runs: still trusted
// and still where the choice found it.
func recheck(trusted func(string) (string, error), path string) error {
	if trusted == nil {
		trusted = TrustedTool
	}
	resolved, err := trusted(path)
	if err != nil {
		return &ToolError{Code: "db_tool_missing", Message: "the program is no longer safe to run: " + err.Error()}
	}
	if resolved != path {
		return &ToolError{Code: "db_tool_missing", Message: "the program " + path + " moved after it was checked"}
	}
	return nil
}

// ChooseTools picks the programs for a server of serverMajor, trusted ones only.
func ChooseTools(ctx context.Context, serverMajor int, dirs []string) (Tools, error) {
	return chooseTrusted(ctx, serverMajor, dirs, nil)
}

func chooseTrusted(ctx context.Context, serverMajor int, dirs []string, trusted func(string) (string, error)) (Tools, error) {
	if trusted == nil {
		trusted = TrustedTool
	}
	type found struct {
		major    int
		dir      string
		resolved map[string]string
	}
	var all []found
	var skipped []string
	for _, dir := range dirs {
		t := Tools{Dir: dir}
		complete := true
		for _, tool := range []string{"pg_dump", "pg_dumpall", "pg_restore"} {
			if st, err := os.Stat(t.Path(tool)); err != nil || st.IsDir() {
				complete = false
				break
			}
		}
		if !complete {
			continue
		}
		resolved := map[string]string{}
		untrusted := false
		for _, tool := range []string{"pg_dump", "pg_dumpall", "pg_restore"} {
			p, err := trusted(t.Path(tool))
			if err != nil {
				skipped = append(skipped, err.Error())
				untrusted = true
				break
			}
			resolved[tool] = p
		}
		if untrusted {
			continue
		}
		// From here on only the resolved paths run, checked again right before.
		t.resolved = resolved
		if recheck(trusted, t.Path("pg_dump")) != nil {
			continue
		}
		vctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		out, err := exec.CommandContext(vctx, t.Path("pg_dump"), "--version").Output() // #nosec G204 -- a fixed argument
		cancel()
		if err != nil {
			continue
		}
		if major := ToolMajor(string(out)); major > 0 {
			all = append(all, found{major, dir, resolved})
		}
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].major > all[j].major })
	for _, f := range all {
		if f.major >= serverMajor {
			return Tools{Major: f.major, Dir: f.dir, resolved: f.resolved}, nil
		}
	}
	if len(all) == 0 {
		msg := "pg_dump, pg_dumpall and pg_restore were not found on this machine. Install the PostgreSQL client programs of the server's major version or newer."
		if len(skipped) > 0 {
			if len(skipped) > 3 {
				skipped = append(skipped[:3], fmt.Sprintf("%d more", len(skipped)-3))
			}
			msg += " Skipped as not safe to run: " + strings.Join(skipped, "; ")
		}
		return Tools{}, &ToolError{Code: "db_tool_missing", Message: msg}
	}
	var majors []string
	var nums []int
	for _, f := range all {
		majors = append(majors, strconv.Itoa(f.major))
		nums = append(nums, f.major)
	}
	return Tools{}, &ToolError{Code: "db_tool_too_old", Found: nums, Message: fmt.Sprintf("pg_dump %s found, the server runs PostgreSQL %d. Install the client programs of version %d or newer.", strings.Join(majors, ", "), serverMajor, serverMajor)}
}

// ConninfoValue quotes a conninfo value (dbname='…').
func ConninfoValue(v string) string {
	return "'" + strings.ReplaceAll(strings.ReplaceAll(v, `\`, `\\`), `'`, `\'`) + "'"
}

func dbnameArg(database string) string { return "--dbname=dbname=" + ConninfoValue(database) }

// DumpArgs: one database, custom format, uncompressed (5.2).
func DumpArgs(database string) []string {
	return []string{"--format=custom", "--compress=0", "--no-password", dbnameArg(database)}
}

// GlobalsArgs: roles and tablespaces, without password hashes unless they may be read.
func GlobalsArgs(rolePasswords bool) []string {
	args := []string{"--globals-only"}
	if !rolePasswords {
		args = append(args, "--no-role-passwords")
	}
	return append(args, "--no-password", dbnameArg("postgres"))
}

// RestoreArgs: into the new database only, stop at the first error, no owners or privileges (O3).
func RestoreArgs(database string) []string {
	return []string{"--exit-on-error", "--no-owner", "--no-privileges", "--no-password", dbnameArg(database)}
}

// ToolEnv is a program's whole environment: the relay's socket, the user,
// the password file. Nothing of the agent's own environment reaches it.
func ToolEnv(socketDir string, port int, user, passFile string) []string {
	env := []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8", "TZ=UTC", "PGHOST=" + socketDir, "PGPORT=" + strconv.Itoa(port), "PGUSER=" + user, "PGSSLMODE=disable", "PGGSSENCMODE=disable", "PGAPPNAME=restow", "PGCONNECT_TIMEOUT=30"}
	if passFile != "" {
		env = append(env, "PGPASSFILE="+passFile)
	}
	return env
}

// PassFileLine is a PGPASSFILE line for any host, port, database and user.
func PassFileLine(password string) string {
	escaped := strings.ReplaceAll(strings.ReplaceAll(password, `\`, `\\`), ":", `\:`)
	return "*:*:*:*:" + escaped + "\n"
}

// WritePassFile writes the password file with 0600 into dir.
func WritePassFile(dir, password string) (string, error) {
	path := filepath.Join(dir, "pgpass")
	if err := os.WriteFile(path, []byte(PassFileLine(password)), 0o600); err != nil {
		return "", err
	}
	return path, os.Chmod(path, 0o600)
}
