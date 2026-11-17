package dbprobe

import (
	"context"
	"errors"
	"testing"
)

func TestInventoryReadsClustersContainersAndUnits(t *testing.T) {
	outputs := map[string]string{
		"pg_lsclusters": "16  main    5432 online postgres /var/lib/postgresql/16/main /var/log/postgresql/postgresql-16-main.log\n" +
			"15  old     5433 down   postgres /var/lib/postgresql/15/old  /var/log/postgresql/postgresql-15-old.log\n",
		"docker": "shop-db\tmariadb:11.4\t0.0.0.0:3307->3306/tcp, [::]:3307->3306/tcp\n" +
			"cache\tredis:7\t6379/tcp\n" +
			"analytics\tpgvector/pgvector:pg16\t5432/tcp\n",
		"systemctl": "postgresql.service loaded active exited PostgreSQL RDBMS\n" +
			"postgresql@16-main.service loaded active running PostgreSQL Cluster 16-main\n" +
			"mariadb.service loaded active running MariaDB 10.11.6 database server\n" +
			"mysql.service not-found inactive dead mysql.service\n",
	}
	run := func(_ context.Context, name string, _ ...string) ([]byte, error) {
		if out, ok := outputs[name]; ok {
			return []byte(out), nil
		}
		return nil, errors.New("not installed")
	}
	got := Inventory(context.Background(), run, Options{PostgresSocketDirs: []string{t.TempDir()}, MySQLSockets: []string{"/nonexistent"}})
	type row struct {
		engine, source, name string
		port                 int
		running              bool
	}
	var rows []row
	for _, i := range got {
		r := row{engine: i.Engine, source: i.Source, name: i.Name, running: i.Running != nil && *i.Running}
		if i.Port != nil {
			r.port = *i.Port
		}
		rows = append(rows, r)
	}
	want := []row{
		{EnginePostgreSQL, "pg_lsclusters", "16/main", 5432, true},
		{EnginePostgreSQL, "pg_lsclusters", "15/old", 5433, false},
		{EngineMariaDB, "docker", "shop-db", 3307, true},
		{EnginePostgreSQL, "docker", "analytics", 0, true},
		{EngineMariaDB, "systemd", "mariadb", 3306, true},
	}
	if len(rows) != len(want) {
		t.Fatalf("got %+v", rows)
	}
	for i := range want {
		if rows[i] != want[i] {
			t.Fatalf("row %d: got %+v want %+v", i, rows[i], want[i])
		}
	}
	if v := got[2].Version; v == nil || *v != "11.4" {
		t.Fatalf("version %v", v)
	}
}
