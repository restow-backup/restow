//go:build !windows

package dbrun

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/dbprobe"
)

// The agent's MySQL relay against a fake server without TLS: the server is
// connected only once the program is (a server ends a connection that does
// not sign in in time); the full step of caching_sha2_password and a method
// that would send the password readable end the relay, and the password never
// reaches the server; no local files; one client only. Real servers with TLS:
// mysql_run_pg_test.go.

var fakeScramble = []byte("abcdefghijklmnopqrst")

func fakeGreeting(plugin string) []byte {
	low := uint16(0x0001 | 0x0004 | 0x0200 | 0x2000 | 0x8000 | 0x20 | 0x80)
	head := make([]byte, 4+8+1+2+1+2+2+1+10)
	binary.LittleEndian.PutUint32(head, 7)
	copy(head[4:], fakeScramble[:8])
	binary.LittleEndian.PutUint16(head[13:], low)
	head[15] = 45
	binary.LittleEndian.PutUint16(head[18:], uint16((0x80000|0x200000)>>16))
	head[20] = 21
	var b bytes.Buffer
	b.WriteByte(10)
	b.WriteString("8.4.3\x00")
	b.Write(head)
	b.Write(fakeScramble[8:])
	b.WriteByte(0)
	b.WriteString(plugin + "\x00")
	return b.Bytes()
}

func readPacket(r io.Reader) (byte, []byte, error) {
	h := make([]byte, 4)
	if _, err := io.ReadFull(r, h); err != nil {
		return 0, nil, err
	}
	n := int(h[0]) | int(h[1])<<8 | int(h[2])<<16
	p := make([]byte, n)
	_, err := io.ReadFull(r, p)
	return h[3], p, err
}

// lockedBuffer is what the fake server received, read by the test.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) Bytes() []byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]byte(nil), l.b.Bytes()...)
}

type fakeMy struct {
	addr     string
	received lockedBuffer
	login    chan []byte
	accepted atomic.Int32
	// connectTimeout closes a connection without a login after it, like a
	// server's connect_timeout.
	connectTimeout time.Duration
}

func startFakeMy(t *testing.T, scenario string, connectTimeout time.Duration) *fakeMy {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	f := &fakeMy{addr: ln.Addr().String(), login: make(chan []byte, 1), connectTimeout: connectTimeout}
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		f.accepted.Add(1)
		defer c.Close()
		if f.connectTimeout > 0 {
			_ = c.SetReadDeadline(time.Now().Add(f.connectTimeout))
		}
		r := io.TeeReader(c, &f.received)
		plugin := "mysql_native_password"
		if scenario == "rsa" {
			plugin = "caching_sha2_password"
		}
		_, _ = c.Write(dbprobe.MysqlPacket(0, fakeGreeting(plugin)))
		seq, login, err := readPacket(r)
		if err != nil {
			return
		}
		_ = c.SetReadDeadline(time.Time{})
		f.login <- login
		switch scenario {
		case "ok":
			_, _ = c.Write(dbprobe.MysqlPacket(seq+1, []byte{0, 0, 0, 2, 0, 0, 0}))
		case "rsa":
			// The full step: the server would now want the password.
			_, _ = c.Write(dbprobe.MysqlPacket(seq+1, []byte{0x01, 0x04}))
			_, _, _ = readPacket(r)
			return
		case "clear":
			_, _ = c.Write(dbprobe.MysqlPacket(seq+1, []byte("\xfemysql_clear_password\x00")))
		}
		// After the sign-in a COM_PING passes as it is.
		if _, ping, err := readPacket(r); err == nil && bytes.Equal(ping, []byte{0x0e}) {
			_, _ = c.Write(dbprobe.MysqlPacket(1, []byte{0, 0, 0, 2, 0, 0, 0}))
		}
	}()
	return f
}

func openFakeRelay(t *testing.T, f *fakeMy) *Relay {
	return openFakeRelayAs(t, f, "mysql")
}

func openFakeRelayAs(t *testing.T, f *fakeMy, engine string) *Relay {
	t.Helper()
	host, port, _ := net.SplitHostPort(f.addr)
	open := func(ctx context.Context) (*dbprobe.PinnedMysql, error) {
		return dbprobe.OpenPinnedMysql(ctx, dbprobe.PinnedTarget{Host: host, Port: atoiPort(port), AllowUnencrypted: true}, engine, 5*time.Second, nil)
	}
	rl, err := OpenMysqlRelay(context.Background(), open, RelayOptions{MaxDuration: 30 * time.Second, BaseDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rl.Close)
	return rl
}

func atoiPort(s string) int {
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}

func programLogin(t *testing.T, path, plugin string) (net.Conn, []byte) {
	t.Helper()
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	_, hello, err := readPacket(c)
	if err != nil {
		t.Fatal(err)
	}
	fixed := make([]byte, 32)
	binary.LittleEndian.PutUint32(fixed, uint32(0x0001|0x0004|0x0200|0x2000|0x8000|0x80000|0x200000|0x20|0x80))
	binary.LittleEndian.PutUint32(fixed[4:], 1<<24)
	fixed[8] = 45
	login := append(append(append(fixed, []byte("backup\x00")...), 20), bytes.Repeat([]byte{7}, 20)...)
	login = append(login, []byte(plugin+"\x00")...)
	if _, err := c.Write(dbprobe.MysqlPacket(1, login)); err != nil {
		t.Fatal(err)
	}
	return c, hello
}

// claim: DB-003
func TestMysqlRelayNoFullStepPlain(t *testing.T) {
	f := startFakeMy(t, "rsa", 0)
	rl := openFakeRelay(t, f)
	c, hello := programLogin(t, rl.Path, "caching_sha2_password")
	defer c.Close()
	verEnd := bytes.IndexByte(hello[1:], 0)
	caps := binary.LittleEndian.Uint16(hello[1+verEnd+1+4+8+1:])
	if caps&(myClientSSL|myClientCompress|myClientLocalFiles) != 0 {
		t.Fatalf("greeting caps %#x", caps)
	}
	rl.Wait()
	var rf *runFailure
	if err := rl.Failure(); !errors.As(err, &rf) || rf.code != "db_tls_missing" || !strings.Contains(rf.msg, "TLS") {
		t.Fatalf("failure %v", rl.Failure())
	}
	// The program never got the request for its password; what it sends now goes nowhere.
	_ = c.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	if _, _, err := readPacket(c); err == nil {
		t.Fatal("the program got a packet")
	}
	_, _ = c.Write(dbprobe.MysqlPacket(3, []byte("s3cret-pw\x00")))
	time.Sleep(100 * time.Millisecond)
	if bytes.Contains(f.received.Bytes(), []byte("s3cret-pw")) {
		t.Fatal("the readable password reached the server")
	}
	// No local files: the server learns the program takes none.
	login := <-f.login
	if binary.LittleEndian.Uint32(login)&myClientLocalFiles != 0 {
		t.Fatal("the login offers local files")
	}
}

// claim: DB-003
func TestMysqlRelayConnectsLate(t *testing.T) {
	f := startFakeMy(t, "ok", 200*time.Millisecond)
	rl := openFakeRelay(t, f)
	time.Sleep(600 * time.Millisecond)
	if f.accepted.Load() != 0 {
		t.Fatal("the server was connected before the program")
	}
	c, _ := programLogin(t, rl.Path, "mysql_native_password")
	defer c.Close()
	if _, ok, err := readPacket(c); err != nil || len(ok) == 0 || ok[0] != 0 {
		t.Fatalf("sign-in %x %v", ok, err)
	}
	if _, err := c.Write(dbprobe.MysqlPacket(0, []byte{0x0e})); err != nil {
		t.Fatal(err)
	}
	if _, pong, err := readPacket(c); err != nil || pong[0] != 0 {
		t.Fatalf("ping %x %v", pong, err)
	}
	// A second client never gets in.
	if c2, err := net.Dial("unix", rl.Path); err == nil {
		_ = c2.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		if _, _, rerr := readPacket(c2); rerr == nil {
			t.Fatal("a second client was served")
		}
		_ = c2.Close()
	}
	// What refuses the server ends the relay when the program connects.
	g := startFakeMy(t, "ok", 0)
	rl2 := openFakeRelayAs(t, g, "mariadb")
	c3, err := net.Dial("unix", rl2.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer c3.Close()
	rl2.Wait()
	var pe *dbprobe.PinnedError
	if err := rl2.Failure(); !errors.As(err, &pe) || pe.Code != dbprobe.CodeEngineChanged {
		t.Fatalf("failure %v", rl2.Failure())
	}
}

// claim: DB-003
func TestMysqlRelayNoClearText(t *testing.T) {
	f := startFakeMy(t, "clear", 0)
	rl := openFakeRelay(t, f)
	c, _ := programLogin(t, rl.Path, "mysql_native_password")
	defer c.Close()
	rl.Wait()
	var rf *runFailure
	if err := rl.Failure(); !errors.As(err, &rf) || rf.code != "db_auth_unsupported" {
		t.Fatalf("failure %v", rl.Failure())
	}
	// The program named a readable method itself: refused before the server hears of it.
	f2 := startFakeMy(t, "ok", 0)
	rl2 := openFakeRelay(t, f2)
	c2, _ := programLogin(t, rl2.Path, "mysql_clear_password")
	defer c2.Close()
	rl2.Wait()
	if err := rl2.Failure(); !errors.As(err, &rf) || rf.code != "db_auth_unsupported" {
		t.Fatalf("failure %v", rl2.Failure())
	}
	select {
	case <-f2.login:
		t.Fatal("the server got the login")
	default:
	}
}

// claim: DB-003
func TestMysqlPinningRefusesAnotherServer(t *testing.T) {
	cases := []struct {
		name, engine, address, code string
		allowPlain                  bool
	}{
		{"another address than the first connection", "mysql", "127.0.0.2", dbprobe.CodeInstanceChanged, true},
		{"MySQL answers where MariaDB was", "mariadb", "", dbprobe.CodeEngineChanged, true},
		{"no TLS and the connection does not allow it", "mysql", "", dbprobe.CodeTLSMissing, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := startFakeMy(t, "ok", 0)
			host, port, _ := net.SplitHostPort(f.addr)
			target := dbprobe.PinnedTarget{Host: host, Port: atoiPort(port), AllowUnencrypted: c.allowPlain, Address: c.address}
			_, err := dbprobe.OpenPinnedMysql(context.Background(), target, c.engine, 5*time.Second, nil)
			var pe *dbprobe.PinnedError
			if !errors.As(err, &pe) || pe.Code != c.code {
				t.Fatalf("got %v, want %s", err, c.code)
			}
		})
	}
}
