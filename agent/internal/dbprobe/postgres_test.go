package dbprobe

import (
	"context"
	"net/url"
	"os"
	"strconv"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
)

// The agent's probe against a real PostgreSQL (the server of the pipeline's
// test job): the engine from the address alone, TLS when the server offers
// it, the sign-in (SCRAM-SHA-256 on PostgreSQL 16) and the facts. Skipped
// without RESTOW_TEST_DATABASE_URL.
//
// claim: DB-001
func TestRealPostgreSQL(t *testing.T) {
	raw := os.Getenv("RESTOW_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("RESTOW_TEST_DATABASE_URL is not set")
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	password, _ := u.User.Password()
	user := u.User.Username()
	host := u.Hostname()
	s := api.DBProbeSpec{ProbeID: "p", Host: &host, AuthMethod: AuthPassword, User: &user, Password: &password, TimeoutSeconds: 20}
	if p := u.Port(); p != "" && p != "5432" {
		n, _ := strconv.Atoi(p)
		s.Port = &n
	}
	r := Run(context.Background(), s, Options{})
	if r.Error != nil {
		t.Fatalf("error %+v", r.Error)
	}
	if deref(r.Engine) != EnginePostgreSQL || r.Login != LoginOK || r.PostgreSQL == nil {
		t.Fatalf("result %+v", r)
	}
	if r.PostgreSQL.SystemIdentifier == nil || r.PostgreSQL.VersionNum < 140000 || len(r.PostgreSQL.Databases) == 0 {
		t.Fatalf("facts %+v", r.PostgreSQL)
	}
	if r.TLS.Offered != nil && *r.TLS.Offered && (!r.TLS.Used || r.TLS.FingerprintSHA256 == nil) {
		t.Fatalf("the server offered TLS and the probe did not use it: %+v", r.TLS)
	}

	wrong := "wrong-" + password
	s.Password = &wrong
	r = Run(context.Background(), s, Options{})
	if r.Login != LoginFailed || r.Error == nil || r.Error.Code != CodeLoginFailed {
		t.Fatalf("wrong password: %+v %+v", r, r.Error)
	}
}
