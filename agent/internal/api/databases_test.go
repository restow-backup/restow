package api_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/testutil/fakeserver"
)

func strp(s string) *string { return &s }

// The facts of a test and a health check fit the server's body limit
// (api.MaxDBFactsBody; apps/api middleware/body-limit.ts answers 413 above
// it): grants are cut from the end and said to be cut, sizes dropped, and
// what still does not fit becomes an error.
func TestDBFactsFitTheServersBodyLimit(t *testing.T) {
	s := fakeserver.New(true)
	defer s.Close()
	c := newClient(t, s)
	ctx := context.Background()

	grants := make([]string, 200)
	for i := range grants {
		grants[i] = "GRANT SELECT (" + strings.Repeat("c", 64<<10-40) + ") ON `app`.`t` TO `u`@`%`"
	}
	mysql := api.DBProbeResult{Engine: strp("mysql"), Login: "ok", MySQL: &api.DBMysqlFacts{Grants: grants}}
	if err := c.FinishDBProbe(ctx, "p1", mysql); err != nil {
		t.Fatalf("the server refused the facts: %v", err)
	}
	got := s.DBProbeResults["p1"].MySQL
	if got == nil || !got.GrantsTruncated || len(got.Grants) == 0 || len(got.Grants) >= 200 || got.Grants[0] != grants[0] {
		t.Fatalf("grants not cut to fit: %d lines, truncated=%v", len(got.Grants), got != nil && got.GrantsTruncated)
	}
	if b, _ := json.Marshal(s.DBProbeResults["p1"]); len(b) > api.MaxDBFactsBody {
		t.Fatalf("%d bytes over the limit", len(b))
	}

	databases := make([]api.DBHealthDatabase, 1000)
	for i := range databases {
		databases[i] = api.DBHealthDatabase{Name: strings.Repeat("<", 5000)}
	}
	sample := api.DBHealthSample{ConnectionID: "c1", At: time.Now(), Result: api.DBProbeResult{
		Engine: strp("postgresql"), Login: "ok", Health: &api.DBHealthFacts{LatencyMs: 3, Databases: databases},
	}}
	if err := c.ReportDBHealth(ctx, "t1", []api.DBHealthSample{sample}); err != nil {
		t.Fatalf("the server refused the sample: %v", err)
	}
	if h := s.DBHealthSamples["t1"]; len(h) != 1 || h[0].Result.Health == nil || h[0].Result.Health.Databases != nil || h[0].Result.Health.LatencyMs != 3 {
		t.Fatalf("sizes not dropped to fit: %+v", h)
	}

	huge := api.DBProbeResult{Engine: strp("postgresql"), Login: "ok", ServerVersion: strp(strings.Repeat("v", api.MaxDBFactsBody))}
	if err := c.FinishDBProbe(ctx, "p2", huge); err != nil {
		t.Fatalf("the server refused the facts: %v", err)
	}
	if r := s.DBProbeResults["p2"]; r.Error == nil || r.Error.Code != "db_probe_failed" || r.ServerVersion != nil || r.Login != "skipped" {
		t.Fatalf("not replaced by an error: %+v", r.Error)
	}
}
