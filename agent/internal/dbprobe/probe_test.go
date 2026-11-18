package dbprobe

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

// The agent's probe against servers that speak just enough of each protocol
// (MySQL, MariaDB and SQL Server are not installed where the tests run):
// greetings and PRELOGIN answers built from the protocol descriptions, a
// sign-in that checks the client's proof the way the server does, canned
// answers to the probe's queries. PostgreSQL runs for real in
// postgres_test.go when RESTOW_TEST_DATABASE_URL is set.

var scramble = []byte("abcdefghijklmnopqrst")

func sp(s string) *string { return &s }
func ip(n int) *int       { return &n }

func listen(t *testing.T, serve func(net.Conn)) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = c.Close() }()
				serve(c)
			}()
		}
	}()
	return l.Addr().(*net.TCPAddr).Port
}

func mysqlPacket(seq byte, payload []byte) []byte {
	return append([]byte{byte(len(payload)), byte(len(payload) >> 8), byte(len(payload) >> 16), seq}, payload...)
}

// greetingPacket is a protocol-10 greeting as MySQL 8.4 or MariaDB 11 sends it.
func greetingPacket(version string, ssl bool, plugin string) []byte {
	lower := uint16(0xf7ff)
	if ssl {
		lower = 0xffff
	}
	var b bytes.Buffer
	b.WriteByte(10)
	b.WriteString(version)
	b.WriteByte(0)
	b.Write([]byte{42, 0, 0, 0})
	b.Write(scramble[:8])
	b.WriteByte(0)
	_ = binary.Write(&b, binary.LittleEndian, lower)
	b.WriteByte(45)
	b.Write([]byte{2, 0})
	_ = binary.Write(&b, binary.LittleEndian, uint16(0x81bf))
	b.WriteByte(21)
	b.Write(make([]byte, 10))
	b.Write(scramble[8:20])
	b.WriteByte(0)
	b.WriteString(plugin)
	b.WriteByte(0)
	return b.Bytes()
}

func lenencStr(s *string) []byte {
	if s == nil {
		return []byte{0xfb}
	}
	n := len(*s)
	switch {
	case n < 251:
		return append([]byte{byte(n)}, *s...)
	case n < 1<<16:
		return append([]byte{0xfc, byte(n), byte(n >> 8)}, *s...)
	default:
		return append([]byte{0xfd, byte(n), byte(n >> 8), byte(n >> 16)}, *s...)
	}
}

func resultSet(rows [][]*string, columns int) [][]byte {
	out := [][]byte{{byte(columns)}}
	for i := 0; i < columns; i++ {
		out = append(out, append(lenencStr(sp("def")), make([]byte, 8)...))
	}
	out = append(out, []byte{0xfe, 0, 0, 2, 0})
	for _, row := range rows {
		var b []byte
		for _, v := range row {
			b = append(b, lenencStr(v)...)
		}
		out = append(out, b)
	}
	return append(out, []byte{0xfe, 0, 0, 2, 0})
}

func errPacket(n uint16, msg string) []byte {
	return append([]byte{0xff, byte(n), byte(n >> 8)}, "#28000"+msg...)
}

type fakeMySQL struct {
	version, password, plugin string
	ssl, fullAuth             bool
	grants                    []string
	serverUUID                *string
	cert                      tls.Certificate
	rsaKey                    *rsa.PrivateKey
	mu                        sync.Mutex
	sawTLS                    bool
	sawUser                   string
}

// seen is what the server saw, read under its lock (the server runs in its own goroutine).
func (f *fakeMySQL) seen() (tls bool, user string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sawTLS, f.sawUser
}

func readPacket(c net.Conn) (byte, []byte, error) {
	head := make([]byte, 4)
	if _, err := ioReadFull(c, head); err != nil {
		return 0, nil, err
	}
	n := int(head[0]) | int(head[1])<<8 | int(head[2])<<16
	body := make([]byte, n)
	_, err := ioReadFull(c, body)
	return head[3], body, err
}

func ioReadFull(c net.Conn, b []byte) (int, error) {
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	n := 0
	for n < len(b) {
		m, err := c.Read(b[n:])
		n += m
		if err != nil {
			return n, err
		}
	}
	return n, nil
}

func (f *fakeMySQL) serve(c net.Conn) {
	_, _ = c.Write(mysqlPacket(0, greetingPacket(f.version, f.ssl, f.plugin)))
	seq, p, err := readPacket(c)
	if err != nil {
		return
	}
	if len(p) == 32 && binary.LittleEndian.Uint32(p[:4])&clientSSL != 0 {
		tc := tls.Server(c, &tls.Config{Certificates: []tls.Certificate{f.cert}})
		if tc.Handshake() != nil {
			return
		}
		c = tc
		f.mu.Lock()
		f.sawTLS = true
		f.mu.Unlock()
		if seq, p, err = readPacket(c); err != nil {
			return
		}
	}
	end := bytes.IndexByte(p[32:], 0)
	user := string(p[32 : 32+end])
	f.mu.Lock()
	f.sawUser = user
	f.mu.Unlock()
	n := int(p[32+end+1])
	token := p[32+end+2 : 32+end+2+n]
	var good bool
	if f.plugin == mysqlAuthNative {
		good = bytes.Equal(token, nativePassword(f.password, scramble))
	} else {
		good = bytes.Equal(token, cachingSHA2Password(f.password, scramble))
	}
	ok := []byte{0, 0, 0, 2, 0, 0, 0}
	if !good {
		_, _ = c.Write(mysqlPacket(seq+1, errPacket(1045, "Access denied for user '"+user+"'@'localhost'")))
		return
	}
	next := seq + 1
	if f.plugin == mysqlAuthCachingSHA2 {
		if f.fullAuth {
			_, _ = c.Write(mysqlPacket(next, []byte{0x01, 0x04}))
			s2, req, err := readPacket(c)
			if err != nil || len(req) != 1 || req[0] != 0x02 {
				return
			}
			der, _ := x509.MarshalPKIXPublicKey(&f.rsaKey.PublicKey)
			pemKey := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
			_, _ = c.Write(mysqlPacket(s2+1, append([]byte{0x01}, pemKey...)))
			s3, enc, err := readPacket(c)
			if err != nil {
				return
			}
			plain, err := rsa.DecryptOAEP(sha1.New(), rand.Reader, f.rsaKey, enc, nil)
			if err != nil || string(xorBytes(plain, scramble)[:len(plain)-1]) != f.password {
				_, _ = c.Write(mysqlPacket(s3+1, errPacket(1045, "Access denied")))
				return
			}
			next = s3 + 1
		} else {
			_, _ = c.Write(mysqlPacket(next, []byte{0x01, 0x03}))
			next++
		}
	}
	_, _ = c.Write(mysqlPacket(next, ok))
	for {
		_, q, err := readPacket(c)
		if err != nil || len(q) == 0 || q[0] == 0x01 {
			return
		}
		sql := string(q[1:])
		var parts [][]byte
		switch {
		case strings.HasPrefix(sql, "SELECT VERSION()"):
			parts = resultSet([][]*string{{sp(f.version), sp("Fake"), sp("restow_backup@%"), sp("7"), sp("/var/lib/mysql/")}}, 5)
		case sql == "SELECT @@server_uuid":
			if f.serverUUID == nil {
				parts = [][]byte{errPacket(1193, "Unknown system variable 'server_uuid'")}
			} else {
				parts = resultSet([][]*string{{f.serverUUID}}, 1)
			}
		case sql == "SELECT 1":
			parts = resultSet([][]*string{{sp("1")}}, 1)
		case sql == "SELECT @@max_connections, @@server_id, @@datadir":
			parts = resultSet([][]*string{{sp("151"), sp("7"), sp("/var/lib/mysql/")}}, 3)
		case strings.HasPrefix(sql, "SHOW GLOBAL STATUS"):
			parts = resultSet([][]*string{{sp("Threads_connected"), sp("4")}, {sp("Uptime"), sp("3600")}}, 2)
		case sql == "SELECT @@log_bin":
			parts = resultSet([][]*string{{sp("1")}}, 1)
		case sql == "SELECT @@binlog_format":
			parts = resultSet([][]*string{{sp("ROW")}}, 1)
		case sql == "SHOW GRANTS":
			var rows [][]*string
			for _, g := range f.grants {
				rows = append(rows, []*string{sp(g)})
			}
			parts = resultSet(rows, 1)
		case strings.Contains(sql, "information_schema.SCHEMATA"):
			parts = resultSet([][]*string{{sp("app"), sp("16384")}, {sp("mysql"), sp("2048")}, {sp("shop"), nil}}, 2)
		default:
			parts = [][]byte{errPacket(1064, "unexpected query")}
		}
		for i, part := range parts {
			_, _ = c.Write(mysqlPacket(byte(1+i), part))
		}
	}
}

func selfSigned(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "db.example.test"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), DNSNames: []string{"db.example.test"}}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func spec(port int) api.DBProbeSpec {
	return api.DBProbeSpec{ProbeID: "p", Host: sp("127.0.0.1"), Port: ip(port), AuthMethod: AuthPassword,
		User: sp("restow_backup"), Password: sp("s3cret-pass"), AllowUnencrypted: true, TimeoutSeconds: 10}
}

var fast = Options{Step: 2 * time.Second, GreetingWait: 200 * time.Millisecond}

// claim: DB-001
func TestDetectsMySQLAndSignsInWithCachingSHA2OverTLS(t *testing.T) {
	cert := selfSigned(t)
	f := &fakeMySQL{version: "8.4.3", password: "s3cret-pass", plugin: mysqlAuthCachingSHA2, ssl: true, cert: cert,
		grants:     []string{"GRANT SELECT, RELOAD, PROCESS, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER ON *.* TO `restow_backup`@`%`"},
		serverUUID: sp("3e11fa47-71ca-11e1-9e33-c80aa9429562")}
	port := listen(t, f.serve)
	r := Run(context.Background(), spec(port), fast)
	if r.Error != nil {
		t.Fatalf("error %+v", r.Error)
	}
	if deref(r.Engine) != EngineMySQL || deref(r.ServerVersion) != "8.4.3" || r.Login != LoginOK {
		t.Fatalf("result %+v", r)
	}
	sum := sha256.Sum256(cert.Certificate[0])
	if !r.TLS.Used || r.TLS.FingerprintSHA256 == nil || !strings.HasPrefix(*r.TLS.FingerprintSHA256, strings.ToUpper(hexPair(sum[0]))) {
		t.Fatalf("tls %+v", r.TLS)
	}
	if sawTLS, sawUser := f.seen(); !sawTLS || sawUser != "restow_backup" {
		t.Fatalf("server saw tls=%v user=%q", sawTLS, sawUser)
	}
	if r.MySQL == nil || deref(r.MySQL.ServerUUID) == "" || len(r.MySQL.Databases) != 3 || len(r.MySQL.Grants) != 1 {
		t.Fatalf("facts %+v", r.MySQL)
	}
}

// claim: DB-001
func TestReadsLongGrantLinesAndReportsWhatWasCut(t *testing.T) {
	long := "GRANT SELECT (" + strings.Repeat("a_rather_long_column_name, ", 300) + "id) ON `app`.`t` TO `restow_backup`@`%`"
	f := &fakeMySQL{version: "8.4.3", password: "s3cret-pass", plugin: mysqlAuthNative, grants: []string{long}}
	r := Run(context.Background(), spec(listen(t, f.serve)), fast)
	if r.Error != nil || r.MySQL == nil || len(r.MySQL.Grants) != 1 || r.MySQL.Grants[0] != long || r.MySQL.GrantsTruncated {
		t.Fatalf("long line (%d bytes) not read in full: %+v", len(long), r.MySQL)
	}
	huge := "GRANT SELECT (" + strings.Repeat("x", 70<<10) + ") ON `app`.`t` TO `restow_backup`@`%`"
	f = &fakeMySQL{version: "8.4.3", password: "s3cret-pass", plugin: mysqlAuthNative, grants: []string{huge}}
	r = Run(context.Background(), spec(listen(t, f.serve)), fast)
	if r.Error != nil || r.MySQL == nil || len(r.MySQL.Grants) != 1 || len(r.MySQL.Grants[0]) != maxGrantBytes || !r.MySQL.GrantsTruncated {
		t.Fatalf("over-long line not reported as cut: %+v", r.Error)
	}
	// At most maxGrantTotalBytes in all: 20 full lines are more.
	full := make([]string, 20)
	for i := range full {
		full[i] = "GRANT SELECT (" + strings.Repeat("y", maxGrantBytes-60) + ") ON `app`.`t` TO `u`@`%`"
	}
	f = &fakeMySQL{version: "8.4.3", password: "s3cret-pass", plugin: mysqlAuthNative, grants: full}
	r = Run(context.Background(), spec(listen(t, f.serve)), fast)
	total := 0
	for _, g := range r.MySQL.Grants {
		total += len(g)
	}
	if r.Error != nil || !r.MySQL.GrantsTruncated || total > maxGrantTotalBytes || len(r.MySQL.Grants) < 15 {
		t.Fatalf("grants not bounded in all: %d lines, %d bytes", len(r.MySQL.Grants), total)
	}
	many := make([]string, maxGrantLines+5)
	for i := range many {
		many[i] = "GRANT USAGE ON *.* TO `restow_backup`@`%`"
	}
	f = &fakeMySQL{version: "8.4.3", password: "s3cret-pass", plugin: mysqlAuthNative, grants: many}
	r = Run(context.Background(), spec(listen(t, f.serve)), fast)
	if r.Error != nil || r.MySQL == nil || len(r.MySQL.Grants) != maxGrantLines || !r.MySQL.GrantsTruncated {
		t.Fatalf("too many lines not reported: %+v", r.Error)
	}
}

func hexPair(b byte) string {
	return string("0123456789abcdef"[b>>4]) + string("0123456789abcdef"[b&15])
}

// claim: DB-001
func TestDetectsMariaDBByItsGreeting(t *testing.T) {
	f := &fakeMySQL{version: "5.5.5-10.11.6-MariaDB-0+deb12u1", password: "s3cret-pass", plugin: mysqlAuthNative,
		grants: []string{"GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost` IDENTIFIED BY PASSWORD '*6BB4837EB74329105EE4568DDA7DC67ED2CA2AD9'"}}
	port := listen(t, f.serve)
	r := Run(context.Background(), spec(port), fast)
	if deref(r.Engine) != EngineMariaDB || deref(r.ServerVersion) != "10.11.6" || r.Login != LoginOK || r.Error != nil {
		t.Fatalf("result %+v %+v", r, r.Error)
	}
	if r.TLS.Used || r.TLS.Offered == nil || *r.TLS.Offered {
		t.Fatalf("tls %+v", r.TLS)
	}
	if strings.Contains(r.MySQL.Grants[0], "6BB4837") {
		t.Fatalf("the password hash of the grant reached the facts: %s", r.MySQL.Grants[0])
	}
}

func TestEncryptsThePasswordWithTheServersKeyWithoutTLS(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeMySQL{version: "8.0.40", password: "s3cret-pass", plugin: mysqlAuthCachingSHA2, fullAuth: true, rsaKey: key}
	port := listen(t, f.serve)
	if r := Run(context.Background(), spec(port), fast); r.Login != LoginOK || r.Error != nil {
		t.Fatalf("result %+v %+v", r, r.Error)
	}
}

// claim: DB-002
func TestAFailedSignInCarriesNoCredential(t *testing.T) {
	f := &fakeMySQL{version: "8.4.3", password: "another", plugin: mysqlAuthNative}
	port := listen(t, f.serve)
	r := Run(context.Background(), spec(port), fast)
	if r.Login != LoginFailed || r.Error == nil || r.Error.Code != CodeLoginFailed {
		t.Fatalf("result %+v %+v", r, r.Error)
	}
	if strings.Contains(r.Error.Message, "restow_backup") || strings.Contains(r.Error.Message, "s3cret-pass") {
		t.Fatalf("message %q", r.Error.Message)
	}
}

func TestNeverSignsInWithoutTLSUnlessAllowed(t *testing.T) {
	f := &fakeMySQL{version: "8.4.3", password: "s3cret-pass", plugin: mysqlAuthNative}
	port := listen(t, f.serve)
	s := spec(port)
	s.AllowUnencrypted = false
	r := Run(context.Background(), s, fast)
	if _, sawUser := f.seen(); r.Error == nil || r.Error.Code != CodeTLSMissing || r.Login != LoginSkipped || sawUser != "" {
		t.Fatalf("result %+v %+v, server saw %q", r, r.Error, sawUser)
	}
}

// claim: DB-001
func TestDetectsSQLServerFromItsPrelogin(t *testing.T) {
	port := listen(t, func(c net.Conn) {
		head := make([]byte, 8)
		if _, err := ioReadFull(c, head); err != nil || head[0] != tdsPrelogin {
			return
		}
		body := make([]byte, int(binary.BigEndian.Uint16(head[2:4]))-8)
		if _, err := ioReadFull(c, body); err != nil {
			return
		}
		reply := tdsPreloginPacket()
		reply[0] = tdsTabularResult
		off := 8 + int(binary.BigEndian.Uint16(reply[9:11]))
		reply[off], reply[off+1] = 16, 0
		binary.BigEndian.PutUint16(reply[off+2:], 1000)
		reply[8+int(binary.BigEndian.Uint16(reply[14:16]))] = 0x00
		_, _ = c.Write(reply)
	})
	r := Run(context.Background(), spec(port), fast)
	if deref(r.Engine) != EngineSQLServer || deref(r.ServerVersion) != "16.0.1000" || r.Login != LoginSkipped || r.Error != nil {
		t.Fatalf("result %+v %+v", r, r.Error)
	}
	if r.SQLServer == nil || deref(r.SQLServer.Encryption) != "off" {
		t.Fatalf("facts %+v", r.SQLServer)
	}
}

func TestSaysWhenAPortIsNoDatabase(t *testing.T) {
	port := listen(t, func(c net.Conn) {
		_, _ = c.Write([]byte("SSH-2.0-OpenSSH_9.6\r\n"))
		time.Sleep(500 * time.Millisecond)
	})
	r := Run(context.Background(), spec(port), fast)
	if r.Engine != nil || r.Error == nil || r.Error.Code != CodeNotADatabase {
		t.Fatalf("result %+v %+v", r, r.Error)
	}
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	closed := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	if r := Run(context.Background(), spec(closed), fast); r.Error == nil || r.Error.Code != CodeUnreachable {
		t.Fatalf("closed port: %+v", r.Error)
	}
}

func TestReadsAnSQLiteFile(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "app.db")
	header := make([]byte, 4096)
	copy(header, sqliteMagic)
	binary.BigEndian.PutUint16(header[16:18], 4096)
	if err := os.WriteFile(db, header, 0o600); err != nil {
		t.Fatal(err)
	}
	r := Run(context.Background(), api.DBProbeSpec{Engine: sp(EngineSQLite), Path: &db, AuthMethod: AuthSocket, TimeoutSeconds: 5}, fast)
	if deref(r.Engine) != EngineSQLite || r.Error != nil || r.SQLite == nil || r.SQLite.PageSize != 4096 || r.SQLite.SizeBytes != 4096 {
		t.Fatalf("result %+v %+v", r, r.Error)
	}
	other := filepath.Join(dir, "notes.txt")
	_ = os.WriteFile(other, []byte(strings.Repeat("hello ", 40)), 0o600)
	if r := Run(context.Background(), api.DBProbeSpec{Path: &other, AuthMethod: AuthSocket, TimeoutSeconds: 5}, fast); r.Error == nil || r.Error.Code != CodeNotADatabase {
		t.Fatalf("text file: %+v", r.Error)
	}
	missing := filepath.Join(dir, "gone.db")
	if r := Run(context.Background(), api.DBProbeSpec{Path: &missing, AuthMethod: AuthSocket, TimeoutSeconds: 5}, fast); r.Error == nil || r.Error.Code != CodeUnreachable {
		t.Fatalf("missing file: %+v", r.Error)
	}
}

// claim: DB-002
func TestSanitizeRemovesCredentials(t *testing.T) {
	msg := `connection to postgres://backup:Hunter2!x@db:5432/app failed: password authentication failed for user "backup_user" (password=Hunter2!x; pwd='other')` + "\x00"
	got := Sanitize(msg, "backup_user", "Hunter2!x")
	for _, bad := range []string{"Hunter2!x", "backup_user", "other", "\x00"} {
		if strings.Contains(got, bad) {
			t.Fatalf("%q still in %q", bad, got)
		}
	}
	if !strings.Contains(got, "postgres://***@db:5432/app") {
		t.Fatalf("got %q", got)
	}
	if got := redactIdentifiedBy("CREATE USER x IDENTIFIED VIA ed25519 USING PASSWORD('secret')"); got != "CREATE USER x IDENTIFIED VIA ed25519 USING '***'" {
		t.Fatalf("got %q", got)
	}
	if got := Sanitize(strings.Repeat("x", 2000), "", ""); len([]rune(got)) != MaxMessage {
		t.Fatalf("length %d", len([]rune(got)))
	}
	if got := Sanitize("access denied for sa", "sa", ""); got != "access denied for sa" {
		t.Fatalf("got %q", got)
	}
}

func TestPostgresAuthentication(t *testing.T) {
	// The MD5 answer of the protocol description for user "u", password "p", salt 01020304.
	if got := pgMD5("u", "p", []byte{1, 2, 3, 4}); !strings.HasPrefix(got, "md5") || len(got) != 35 {
		t.Fatalf("md5 %q", got)
	}
	// RFC 7677's test vector: user "user", password "pencil".
	s := &scram{password: "pencil", clientNonce: "rOprNGfwEbeRWgbNEkqO"}
	final, err := s.clientFinal("r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096")
	if err != nil {
		t.Fatal(err)
	}
	// The RFC's client-first-bare names the user; PostgreSQL's leaves it empty, so the proof differs
	// from the RFC's, but the server's signature must verify against the same auth message.
	if !strings.HasPrefix(final, "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=") {
		t.Fatalf("final %q", final)
	}
	want := hmacSHA256(hmacSHA256(s.salted, "Server Key"), s.authMessage)
	if !s.verify("v="+base64Std(want)) || s.verify("v=AAAA") {
		t.Fatal("server signature check")
	}
}

func base64Std(b []byte) string { return base64.StdEncoding.EncodeToString(b) }
