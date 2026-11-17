package dbprobe

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"
)

func fingerprintOf(der []byte) string {
	sum := sha256.Sum256(der)
	parts := make([]string, len(sum))
	for i, b := range sum {
		parts[i] = fmt.Sprintf("%02X", b)
	}
	return strings.Join(parts, ":")
}

// claim: DB-004
func TestHealthCheckReadsTheHealthFactsWithTheConfirmedCertificate(t *testing.T) {
	cert := selfSigned(t)
	f := &fakeMySQL{version: "5.5.5-11.4.4-MariaDB", password: "s3cret-pass", plugin: mysqlAuthNative, ssl: true, cert: cert}
	port := listen(t, f.serve)
	s := spec(port)
	s.Engine = sp(EngineMariaDB)
	s.TLSFingerprint = sp(fingerprintOf(cert.Certificate[0]))
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
	s.TLSFingerprint = sp(strings.Repeat("AB:", 31) + "AB")
	r := Health(context.Background(), s, fast)
	if r.Error == nil || r.Error.Code != CodeTLSChanged || r.Login != LoginSkipped {
		t.Fatalf("result %+v %+v", r, r.Error)
	}
	time.Sleep(50 * time.Millisecond)
	if !f.sawTLS || f.sawUser != "" {
		t.Fatalf("the server saw tls=%v user=%q", f.sawTLS, f.sawUser)
	}
	if r.TLS.FingerprintSHA256 == nil || *r.TLS.FingerprintSHA256 == *s.TLSFingerprint {
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
