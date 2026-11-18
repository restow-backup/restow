package dbrun

import (
	"context"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
)

// claim: DB-002
func TestRunsAreRefusedWhereThePlatformHasNone(t *testing.T) {
	saved := platformSupported
	platformSupported = false
	defer func() { platformSupported = saved }()
	host, port, user := "db.example.test", 5432, "backup"
	spec := &api.DBRunSpec{RunID: "r", Kind: "backup", Repository: &api.DBRunRepository{URL: "x"}}
	spec.Connection = api.DBRunConnection{ConnectionID: "c", Engine: "postgresql", Host: &host, Port: &port, User: &user}
	for _, run := range []func(context.Context, *api.DBRunSpec, Deps) api.DBRunFinish{Backup, Restore} {
		report := run(context.Background(), spec, Deps{})
		if report.Status != "failed" || report.Error == nil || report.Error.Code != CodePlatformUnsupported || report.Instance != nil {
			t.Fatalf("report %+v %+v", report, report.Error)
		}
	}
}
