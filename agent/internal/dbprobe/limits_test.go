package dbprobe

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

// What a server may make the agent's probe do: one deadline for the whole
// probe, bounded messages, SCRAM with a bounded number of rounds and only in
// its order, the confirmed certificate before anything of the sign-in, and the
// same checks for every further connection.

// fakePG is a PostgreSQL server that follows a script.
type fakePG struct {
	ssl      func(index int) byte
	cert     tls.Certificate
	certFor  func(index int) tls.Certificate
	startup  func(c net.Conn, index int)
	message  func(c net.Conn, typ byte, body []byte, index int)
	startups atomic.Int32
	closed   chan int
}

func (f *fakePG) listen(t *testing.T) int {
	t.Helper()
	f.closed = make(chan int, 16)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	var count atomic.Int32
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			index := int(count.Add(1)) - 1
			go func() {
				defer func() { _ = c.Close() }()
				f.serve(c, index)
				f.closed <- index
			}()
		}
	}()
	return l.Addr().(*net.TCPAddr).Port
}

func (f *fakePG) serve(raw net.Conn, index int) {
	var c = raw
	head := make([]byte, 8)
	if _, err := io.ReadFull(c, head); err != nil {
		return
	}
	answer := byte('N')
	if f.ssl != nil {
		answer = f.ssl(index)
	}
	if _, err := c.Write([]byte{answer}); err != nil {
		return
	}
	if answer == 'S' {
		cert := f.cert
		if f.certFor != nil {
			cert = f.certFor(index)
		}
		tc := tls.Server(raw, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
		if err := tc.Handshake(); err != nil {
			return
		}
		c = tc
	}
	if _, err := io.ReadFull(c, head[:4]); err != nil {
		return
	}
	body := make([]byte, int(binary.BigEndian.Uint32(head[:4]))-4)
	if _, err := io.ReadFull(c, body); err != nil {
		return
	}
	f.startups.Add(1)
	if f.startup != nil {
		f.startup(c, index)
	}
	for {
		if _, err := io.ReadFull(c, head[:5]); err != nil {
			return
		}
		body := make([]byte, int(binary.BigEndian.Uint32(head[1:5]))-4)
		if _, err := io.ReadFull(c, body); err != nil {
			return
		}
		if f.message != nil {
			f.message(c, head[0], body, index)
		}
	}
}

func authMsg(code uint32, data string) []byte {
	body := make([]byte, 4, 4+len(data))
	binary.BigEndian.PutUint32(body, code)
	return pgMessage('R', append(body, data...))
}

func errMsg(state, text string) []byte {
	return pgMessage('E', []byte("SFATAL\x00C"+state+"\x00M"+text+"\x00\x00"))
}

var saslOffer = authMsg(10, "SCRAM-SHA-256\x00\x00")

var nonceRe = regexp.MustCompile(`r=([^,]+)$`)

// serverFirst answers a client-first message with the given iterations.
func serverFirst(body []byte, iterations int) []byte {
	nonce := ""
	if m := nonceRe.FindSubmatch(body); m != nil {
		nonce = string(m[1])
	}
	return authMsg(11, fmt.Sprintf("r=%ssrv0123,s=%s,i=%d", nonce, base64Std([]byte("restow-salt-0123")), iterations))
}

func pgSpec(port int) api.DBProbeSpec {
	s := spec(port)
	s.Engine = sp(EnginePostgreSQL)
	s.Database = sp("postgres")
	return s
}

func certFingerprint(cert tls.Certificate) string {
	sum := sha256.Sum256(cert.Certificate[0])
	parts := make([]string, len(sum))
	for i, b := range sum {
		parts[i] = fmt.Sprintf("%02X", b)
	}
	return strings.Join(parts, ":")
}

func code(r api.DBProbeResult) string {
	if r.Error == nil {
		return ""
	}
	return r.Error.Code
}

func TestSCRAMRefusesMoreRoundsThanItComputesAtOnce(t *testing.T) {
	f := &fakePG{
		startup: func(c net.Conn, _ int) { _, _ = c.Write(saslOffer) },
		message: func(c net.Conn, typ byte, body []byte, _ int) {
			if typ == 'p' {
				_, _ = c.Write(serverFirst(body, 10_000_000))
			}
		},
	}
	port := f.listen(t)
	started := time.Now()
	r := Run(context.Background(), pgSpec(port), fast)
	if code(r) != CodeAuthUnsupported || r.Login == LoginOK {
		t.Fatalf("result %+v %+v", r, r.Error)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("took %v", elapsed)
	}
}

func TestSignInCountsOnlyAfterTheServersProof(t *testing.T) {
	f := &fakePG{
		startup: func(c net.Conn, _ int) { _, _ = c.Write(saslOffer) },
		message: func(c net.Conn, typ byte, body []byte, _ int) {
			if typ != 'p' {
				return
			}
			if strings.HasPrefix(string(body), "SCRAM-SHA-256\x00") {
				_, _ = c.Write(serverFirst(body, 4096))
				return
			}
			// Ok without the server-final message (and its proof).
			_, _ = c.Write(append(authMsg(0, ""), pgMessage('Z', []byte("I"))...))
		},
	}
	port := f.listen(t)
	r := Run(context.Background(), pgSpec(port), fast)
	if r.Login == LoginOK || code(r) != CodeProbeFailed {
		t.Fatalf("result %+v %+v", r, r.Error)
	}
}

func TestSCRAMServerFirstOnlyOnce(t *testing.T) {
	var firsts atomic.Int32
	f := &fakePG{
		startup: func(c net.Conn, _ int) { _, _ = c.Write(saslOffer) },
		message: func(c net.Conn, typ byte, body []byte, _ int) {
			if typ == 'p' {
				firsts.Add(1)
				_, _ = c.Write(serverFirst(body, 4096))
			}
		},
	}
	port := f.listen(t)
	started := time.Now()
	r := Run(context.Background(), pgSpec(port), fast)
	if code(r) != CodeProbeFailed || firsts.Load() != 2 || time.Since(started) > time.Second {
		t.Fatalf("result %+v %+v firsts=%d", r, r.Error, firsts.Load())
	}
}

func TestProbeEndsAtItsDeadline(t *testing.T) {
	f := &fakePG{
		startup: func(c net.Conn, _ int) {
			_, _ = c.Write(authMsg(0, ""))
			for {
				time.Sleep(50 * time.Millisecond)
				if _, err := c.Write(pgMessage('N', []byte("SNOTICE\x00Mstill here\x00\x00"))); err != nil {
					return
				}
			}
		},
	}
	port := f.listen(t)
	s := pgSpec(port)
	s.TimeoutSeconds = 1
	started := time.Now()
	r := Run(context.Background(), s, fast)
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("took %v", elapsed)
	}
	if code(r) != CodeUnreachable || !strings.Contains(r.Error.Message, "did not finish in time") {
		t.Fatalf("result %+v", r.Error)
	}
	select {
	case <-f.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("the probe's connection stayed open")
	}
}

func TestRefusesAMessageLargerThanItReads(t *testing.T) {
	f := &fakePG{
		startup: func(c net.Conn, _ int) {
			head := []byte{'R', 0, 0, 0, 0}
			binary.BigEndian.PutUint32(head[1:], 64<<20)
			_, _ = c.Write(head)
		},
	}
	port := f.listen(t)
	started := time.Now()
	r := Run(context.Background(), pgSpec(port), fast)
	if code(r) != CodeProbeFailed || time.Since(started) > time.Second {
		t.Fatalf("result %+v", r.Error)
	}
}

// claim: DB-003
func TestConfirmedCertificateBeforeTheSignIn(t *testing.T) {
	cert := selfSigned(t)
	f := &fakePG{
		ssl:     func(int) byte { return 'S' },
		cert:    cert,
		startup: func(c net.Conn, _ int) { _, _ = c.Write(errMsg("28P01", "password authentication failed")) },
	}
	port := f.listen(t)
	s := pgSpec(port)
	s.PinnedFingerprintSHA256 = sp(strings.Repeat("AB:", 31) + "AB")
	r := Run(context.Background(), s, fast)
	if code(r) != CodeTLSChanged || f.startups.Load() != 0 {
		t.Fatalf("result %+v startups=%d", r.Error, f.startups.Load())
	}
	if !r.TLS.Used || deref(r.TLS.FingerprintSHA256) != certFingerprint(cert) {
		t.Fatalf("tls %+v", r.TLS)
	}
	s.PinnedFingerprintSHA256 = sp(certFingerprint(cert))
	if r := Run(context.Background(), s, fast); code(r) != CodeLoginFailed || f.startups.Load() != 1 {
		t.Fatalf("matching certificate: %+v startups=%d", r.Error, f.startups.Load())
	}

	plain := &fakePG{startup: func(c net.Conn, _ int) { _, _ = c.Write(authMsg(3, "")) }}
	s = pgSpec(plain.listen(t))
	s.PinnedFingerprintSHA256 = sp(certFingerprint(cert))
	if r := Run(context.Background(), s, fast); code(r) != CodeTLSMissing || plain.startups.Load() != 0 {
		t.Fatalf("no TLS: %+v startups=%d", r.Error, plain.startups.Load())
	}

	m := &fakeMySQL{version: "8.4.3", password: "s3cret-pass", plugin: mysqlAuthCachingSHA2, ssl: true, cert: cert}
	ms := spec(listen(t, m.serve))
	ms.PinnedFingerprintSHA256 = sp(strings.Repeat("AB:", 31) + "AB")
	if r := Run(context.Background(), ms, fast); code(r) != CodeTLSChanged || m.sawUser != "" {
		t.Fatalf("mysql: %+v user=%q", r.Error, m.sawUser)
	}
}

func TestReopenedConnectionGetsTheSameChecks(t *testing.T) {
	f := &fakePG{
		ssl: func(index int) byte {
			if index == 0 {
				return 'N'
			}
			return 'S'
		},
		cert: selfSigned(t),
		startup: func(c net.Conn, index int) {
			_, _ = c.Write(errMsg("3D000", `database "app" does not exist`))
		},
	}
	port := f.listen(t)
	s := pgSpec(port)
	s.Database = sp("app")
	r := Run(context.Background(), s, fast)
	if code(r) != CodeProbeFailed || f.startups.Load() != 1 {
		t.Fatalf("result %+v startups=%d", r.Error, f.startups.Load())
	}
}

func TestSQLiteOpensOnlyARegularFile(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "app.db")
	header := make([]byte, 4096)
	copy(header, sqliteMagic)
	binary.BigEndian.PutUint16(header[16:18], 4096)
	if err := os.WriteFile(db, header, 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.db")
	if err := os.Symlink(db, link); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	r := Run(context.Background(), api.DBProbeSpec{Path: &link, AuthMethod: AuthSocket, TimeoutSeconds: 5}, fast)
	if code(r) != CodeNotADatabase || r.SQLite != nil {
		t.Fatalf("link: %+v %+v", r.Error, r.SQLite)
	}
	r = Run(context.Background(), api.DBProbeSpec{Path: &dir, AuthMethod: AuthSocket, TimeoutSeconds: 5}, fast)
	if code(r) != CodeNotADatabase {
		t.Fatalf("directory: %+v", r.Error)
	}
}

func TestSocketPlacesAreNotWorldWritable(t *testing.T) {
	for _, place := range append(slices.Clone(defaultPostgresSocketDirs), defaultMySQLSockets...) {
		if place == "/tmp" || strings.HasPrefix(place, "/tmp/") || strings.HasPrefix(place, "/var/tmp") {
			t.Fatalf("socket place %q is writable by every user", place)
		}
	}
}

// openPG lets anyone in and answers every query with the given values (one column).
func openPG(values func() [][]byte) *fakePG {
	return &fakePG{
		startup: func(c net.Conn, _ int) {
			_, _ = c.Write(append(authMsg(0, ""), pgMessage('Z', []byte("I"))...))
		},
		message: func(c net.Conn, typ byte, _ []byte, _ int) {
			if typ != 'Q' {
				return
			}
			for _, v := range values() {
				row := make([]byte, 6, 6+len(v))
				binary.BigEndian.PutUint16(row, 1)
				binary.BigEndian.PutUint32(row[2:], uint32(len(v)))
				if _, err := c.Write(pgMessage('D', append(row, v...))); err != nil {
					return
				}
			}
			_, _ = c.Write(append(pgMessage('C', []byte("SELECT\x00")), pgMessage('Z', []byte("I"))...))
		},
	}
}

func TestProbeReadsAtMostItsBudget(t *testing.T) {
	big := []byte(strings.Repeat("a", 900<<10))
	f := openPG(func() [][]byte {
		out := make([][]byte, 20)
		for i := range out {
			out[i] = big
		}
		return out
	})
	r := Run(context.Background(), pgSpec(f.listen(t)), fast)
	if code(r) != CodeProbeFailed || r.PostgreSQL != nil {
		t.Fatalf("result %+v", r.Error)
	}
}

func TestLongValuesAreShortenedWhileRead(t *testing.T) {
	f := openPG(func() [][]byte { return [][]byte{[]byte(strings.Repeat("b", 500<<10))} })
	port := f.listen(t)
	ctx, cancel := context.WithTimeout(withReadBudget(context.Background(), readBudgetBytes), 5*time.Second)
	defer cancel()
	c, err := openConn(ctx, defaultDial, "tcp", addressOf("127.0.0.1", port), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	_ = c.write(pgSSLRequest)
	if _, err := c.readFull(1); err != nil {
		t.Fatal(err)
	}
	if _, err := c.pgSignIn("restow_backup", nil, "postgres"); err != nil {
		t.Fatal(err)
	}
	rows, err := c.pgQuery("SELECT version()")
	if err != nil || len(rows) != 1 || len(deref(rows[0][0])) != maxValueBytes {
		t.Fatalf("rows %d err %v", len(rows), err)
	}
}

func TestSecondConnectionShowsTheSameCertificate(t *testing.T) {
	first, other := selfSigned(t), selfSigned(t)
	f := &fakePG{
		ssl: func(int) byte { return 'S' },
		certFor: func(index int) tls.Certificate {
			if index == 0 {
				return first
			}
			return other
		},
		startup: func(c net.Conn, index int) {
			if index == 0 {
				_, _ = c.Write(errMsg("3D000", `database "app" does not exist`))
				return
			}
			_, _ = c.Write(authMsg(3, ""))
		},
	}
	s := pgSpec(f.listen(t))
	s.Database = sp("app")
	r := Run(context.Background(), s, fast)
	if code(r) != CodeTLSChanged || f.startups.Load() != 1 {
		t.Fatalf("result %+v startups=%d", r.Error, f.startups.Load())
	}
}
