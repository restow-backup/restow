package dbprobe

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

// The inventory (docs/DATABASES.md 3.4) looks for database instances on this
// machine: PostgreSQL clusters (pg_lsclusters), systemd units of PostgreSQL,
// MySQL and MariaDB, Docker containers of their images, and the local
// sockets. It only reads; it never signs in. The server shows what it found as
// suggestions and never creates a connection from it.

// CommandRunner runs a program with a fixed argument list (never a shell).
type CommandRunner func(ctx context.Context, name string, args ...string) ([]byte, error)

// SystemRunner runs the program from PATH with a timeout.
func SystemRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	path, err := exec.LookPath(name)
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return exec.CommandContext(cctx, path, args...).Output() // #nosec G204 -- fixed programs and arguments
}

// maxInventoryInstances bounds what one inventory reports.
const maxInventoryInstances = 64

// Inventory collects the instances of this machine. Missing programs are skipped.
func Inventory(ctx context.Context, run CommandRunner, o Options) []api.DBInventoryInstance {
	var out []api.DBInventoryInstance
	seen := map[string]bool{}
	add := func(i api.DBInventoryInstance) {
		key := i.Engine + "/"
		if i.Port != nil {
			key += strconv.Itoa(*i.Port)
		}
		if i.Container != nil {
			key += "/" + *i.Container
		}
		if seen[key] || len(out) >= maxInventoryInstances {
			return
		}
		seen[key] = true
		out = append(out, i)
	}
	if b, err := run(ctx, "pg_lsclusters", "--no-header"); err == nil {
		for _, i := range parsePgLsclusters(string(b)) {
			add(i)
		}
	}
	if b, err := run(ctx, "docker", "ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Ports}}"); err == nil {
		for _, i := range parseDockerPS(string(b)) {
			add(i)
		}
	}
	if b, err := run(ctx, "systemctl", "list-units", "--type=service", "--all", "--no-legend", "--plain",
		"postgresql*", "mysql*", "mariadb*"); err == nil {
		for _, i := range parseSystemdUnits(string(b)) {
			add(i)
		}
	}
	for _, i := range socketInstances(o) {
		add(i)
	}
	return out
}

func intp(n int) *int { return &n }

// parsePgLsclusters reads `pg_lsclusters --no-header`:
// "16  main    5432 online postgres /var/lib/postgresql/16/main /var/log/...".
func parsePgLsclusters(out string) []api.DBInventoryInstance {
	var res []api.DBInventoryInstance
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 4 {
			continue
		}
		port, err := strconv.Atoi(f[2])
		if err != nil || port < 1 || port > 65535 {
			continue
		}
		running := strings.HasPrefix(f[3], "online")
		res = append(res, api.DBInventoryInstance{
			Engine: EnginePostgreSQL, Source: "pg_lsclusters", Name: clip(f[0]+"/"+f[1], 256),
			Version: str(clip(f[0], 64)), Port: intp(port), Socket: str("/var/run/postgresql"), Running: boolp(running),
		})
	}
	return res
}

var publishedPort = regexp.MustCompile(`(?:[0-9.]+|\[?[0-9a-f:]*\]?):(\d+)->(\d+)/tcp`)

// parseDockerPS reads `docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'`.
func parseDockerPS(out string) []api.DBInventoryInstance {
	var res []api.DBInventoryInstance
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		f := strings.Split(sc.Text(), "\t")
		if len(f) < 2 {
			continue
		}
		name, image := f[0], strings.ToLower(f[1])
		repo := image
		tag := ""
		if i := strings.LastIndex(image, ":"); i > strings.LastIndex(image, "/") {
			repo, tag = image[:i], image[i+1:]
		}
		base := repo[strings.LastIndex(repo, "/")+1:]
		var engine string
		var inner int
		switch {
		case strings.Contains(base, "postgres") || strings.Contains(base, "postgis") || strings.Contains(base, "pgvector"):
			engine, inner = EnginePostgreSQL, 5432
		case strings.Contains(base, "mariadb"):
			engine, inner = EngineMariaDB, 3306
		case strings.Contains(base, "mysql") || strings.Contains(base, "percona"):
			engine, inner = EngineMySQL, 3306
		default:
			continue
		}
		inst := api.DBInventoryInstance{Engine: engine, Source: "docker", Name: clip(name, 256), Container: str(clip(name, 256)), Running: boolp(true)}
		if tag != "" && tag != "latest" {
			inst.Version = str(clip(tag, 64))
		}
		if len(f) >= 3 {
			for _, m := range publishedPort.FindAllStringSubmatch(f[2], -1) {
				if c, _ := strconv.Atoi(m[2]); c == inner {
					if p, err := strconv.Atoi(m[1]); err == nil {
						inst.Port = intp(p)
						break
					}
				}
			}
		}
		res = append(res, inst)
	}
	return res
}

var unitVersion = regexp.MustCompile(`(\d+(?:\.\d+)+)`)

// parseSystemdUnits reads `systemctl list-units --plain --no-legend ...`:
// "mariadb.service loaded active running MariaDB 10.11.6 database server".
func parseSystemdUnits(out string) []api.DBInventoryInstance {
	var res []api.DBInventoryInstance
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 4 || !strings.HasSuffix(f[0], ".service") {
			continue
		}
		unit := strings.TrimSuffix(f[0], ".service")
		var engine string
		var port int
		switch {
		case strings.HasPrefix(unit, "postgresql"):
			// postgresql@16-main is one cluster; plain postgresql.service is the umbrella unit.
			if !strings.Contains(unit, "@") {
				continue
			}
			engine, port = EnginePostgreSQL, 5432
		case strings.HasPrefix(unit, "mariadb"):
			engine, port = EngineMariaDB, 3306
		case strings.HasPrefix(unit, "mysql"):
			engine, port = EngineMySQL, 3306
		default:
			continue
		}
		if f[1] == "not-found" {
			continue
		}
		inst := api.DBInventoryInstance{Engine: engine, Source: "systemd", Name: clip(unit, 256), Port: intp(port), Running: boolp(f[3] == "running")}
		if m := unitVersion.FindString(strings.Join(f[4:], " ")); m != "" {
			inst.Version = str(clip(m, 64))
		}
		res = append(res, inst)
	}
	return res
}

func socketInstances(o Options) []api.DBInventoryInstance {
	var res []api.DBInventoryInstance
	dirs := o.PostgresSocketDirs
	if len(dirs) == 0 {
		dirs = defaultPostgresSocketDirs
	}
	for _, dir := range dirs {
		matches, _ := filepath.Glob(filepath.Join(dir, ".s.PGSQL.*"))
		for _, m := range matches {
			if strings.HasSuffix(m, ".lock") {
				continue
			}
			port, err := strconv.Atoi(strings.TrimPrefix(filepath.Base(m), ".s.PGSQL."))
			if err != nil {
				continue
			}
			res = append(res, api.DBInventoryInstance{Engine: EnginePostgreSQL, Source: "socket", Name: m, Port: intp(port), Socket: str(dir), Running: boolp(true)})
		}
	}
	sockets := o.MySQLSockets
	if len(sockets) == 0 {
		sockets = defaultMySQLSockets
	}
	for _, path := range sockets {
		if info, err := os.Stat(path); err == nil && info.Mode()&os.ModeSocket != 0 {
			// MySQL or MariaDB: the socket does not say which; the dialog's test does.
			res = append(res, api.DBInventoryInstance{Engine: EngineMySQL, Source: "socket", Name: path, Port: intp(3306), Socket: str(path), Running: boolp(true)})
			break
		}
	}
	return res
}
