package dbprobe

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"
)

// claim: DB-004
func TestHealthCheckReadsTheHealthFactsWithTheConfirmedCertificate(t *testing.T) {
	cert := selfSigned(t)
	f := &fakeMySQL{version: "5.5.5-11.4.4-MariaDB", password: "s3cret-pass", plugin: mysqlAuthNative, ssl: true, cert: cert}
	port := listen(t, f.serve)
	s := spec(port)
	s.Engine = sp(EngineMariaDB)
	s.PinnedFingerprintSHA256 = sp(certFingerprint(cert))
	r := Health(context.Background(), s, fast)
	if r.Error != nil || r.Login != LoginOK || r.MySQL != nil || r.Health == nil {
		t.Fatalf("result %+v %+v", r, r.Error)
	}
	h := r.Health
	if deref(r.ServerVersion) != "11.4.4" || h.ConnectionsUsed == nil || *h.ConnectionsUsed != 4 || h.ConnectionsMax == nil || *h.ConnectionsMax != 151 ||
		h.ServerID == nil || *h.ServerID != 7 || deref(h.Datadir) != "/var/lib/mysql/" || h.Databases != nil || h.StartedAt == nil {
		t.Fatalf("health %+v", h)
	}
	started, err := time.Parse(time.RFC3339, *h.StartedAt)
	if err != nil || time.Since(started) < 59*time.Minute || time.Since(started) > 61*time.Minute {
		t.Fatalf("started %v %v", *h.StartedAt, err)
	}
	s.Sizes = true
	r = Health(context.Background(), s, fast)
	if r.Health == nil || len(r.Health.Databases) != 3 || r.Health.Databases[0].Name != "app" || *r.Health.Databases[0].SizeBytes != 16384 {
		t.Fatalf("sizes %+v", r.Health)
	}
}

// claim: DB-004
func TestHealthCheckSendsNoCredentialToAnotherCertificate(t *testing.T) {
	f := &fakeMySQL{version: "8.4.3", password: "s3cret-pass", plugin: mysqlAuthCachingSHA2, ssl: true, cert: selfSigned(t)}
	port := listen(t, f.serve)
	s := spec(port)
	s.Engine = sp(EngineMySQL)
	s.PinnedFingerprintSHA256 = sp(strings.Repeat("AB:", 31) + "AB")
	r := Health(context.Background(), s, fast)
	if r.Error == nil || r.Error.Code != CodeTLSChanged || r.Login != LoginSkipped {
		t.Fatalf("result %+v %+v", r, r.Error)
	}
	time.Sleep(50 * time.Millisecond)
	if sawTLS, sawUser := f.seen(); !sawTLS || sawUser != "" {
		t.Fatalf("the server saw tls=%v user=%q", sawTLS, sawUser)
	}
	if r.TLS.FingerprintSHA256 == nil || *r.TLS.FingerprintSHA256 == *s.PinnedFingerprintSHA256 {
		t.Fatalf("tls %+v", r.TLS)
	}
}

// claim: DB-004
func TestHealthCheckEndsAtItsDeadlineAndClosesItsConnections(t *testing.T) {
	closed := make(chan struct{}, 4)
	port := listen(t, func(c net.Conn) {
		buf := make([]byte, 64)
		for {
			_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
			if _, err := c.Read(buf); err != nil {
				closed <- struct{}{}
				return
			}
		}
	})
	s := spec(port)
	s.Engine = sp(EnginePostgreSQL)
	s.TimeoutSeconds = 1
	start := time.Now()
	r := Health(context.Background(), s, Options{Step: 5 * time.Second})
	if time.Since(start) > 3*time.Second {
		t.Fatalf("the check took %v", time.Since(start))
	}
	if r.Error == nil || r.Error.Code != CodeUnreachable {
		t.Fatalf("result %+v %+v", r, r.Error)
	}
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("the connection stayed open after the deadline")
	}
}

// The size query of a health check reads within the probe's budget and cuts
// every value while it reads it.
//
// claim: DB-004
func TestHealthCheckKeepsTheReadBudgetAndTheValueCut(t *testing.T) {
	big := []byte(strings.Repeat("a", 900<<10))
	flood := openPG(func() [][]byte {
		out := make([][]byte, 20)
		for i := range out {
			out[i] = big
		}
		return out
	})
	s := pgSpec(flood.listen(t))
	s.Sizes = true
	if r := Health(context.Background(), s, fast); code(r) != CodeProbeFailed || r.Health != nil {
		t.Fatalf("flood: %+v %+v", r.Error, r.Health)
	}
	long := openPG(func() [][]byte { return [][]byte{[]byte(strings.Repeat("b", 300<<10))} })
	s = pgSpec(long.listen(t))
	s.Sizes = true
	r := Health(context.Background(), s, fast)
	if r.Error != nil || r.Health == nil || len(deref(r.ServerVersion)) > maxValueBytes {
		t.Fatalf("long: %+v %+v", r.Error, r.Health)
	}
	for _, d := range r.Health.Databases {
		if len(d.Name) > 128 {
			t.Fatalf("name of %d bytes", len(d.Name))
		}
	}
}
