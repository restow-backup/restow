package api

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// claim: DB-008
func TestRestoreDumpWaitsForAFreeDownloadSlot(t *testing.T) {
	saved := dumpBusyWait
	dumpBusyWait = time.Millisecond
	defer func() { dumpBusyWait = saved }()
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if user, _, ok := r.BasicAuth(); !ok || user != "agent-1" || r.URL.Path != "/agent/v1/databases/runs/run-1/dump" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if calls <= 2 {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		_, _ = w.Write([]byte("PGDMP dump"))
	}))
	defer srv.Close()
	c, err := New(Options{BaseURL: srv.URL, EndpointID: "agent-1", AgentSecret: "s", AllowInsecureHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := c.StreamDBRunDump(context.Background(), "run-1", &out); err != nil || out.String() != "PGDMP dump" || calls != 3 {
		t.Fatalf("dump %q after %d calls: %v", out.String(), calls, err)
	}
}
