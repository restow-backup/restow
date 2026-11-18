package dbrun

import (
	"context"
	"encoding/binary"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

var authOK = []byte{'R', 0, 0, 0, 8, 0, 0, 0, 0}

// fakeUpstream is the server side of a pinned connection: it answers the
// program's startup with AuthenticationOk and echoes what follows.
func fakeUpstream(t *testing.T) net.Conn {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		buf := make([]byte, 4096)
		first := true
		for {
			n, err := c.Read(buf)
			if err != nil {
				return
			}
			if first {
				first = false
				_, _ = c.Write(authOK)
				continue
			}
			_, _ = c.Write(buf[:n])
		}
	}()
	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func dialRelay(t *testing.T, r *Relay) net.Conn {
	t.Helper()
	c, err := net.Dial("unix", filepath.Join(r.Dir, ".s.PGSQL.5432"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Write([]byte("start")); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(authOK))
	if _, err := c.Read(got); err != nil {
		t.Fatal(err)
	}
	return c
}

// claim: DB-003
func TestRelayTakesOneClientAndCleansUp(t *testing.T) {
	r, err := OpenRelay(context.Background(), fakeUpstream(t), RelayOptions{MaxDuration: 30 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(r.Dir)
	if err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("directory mode %v, %v", st.Mode().Perm(), err)
	}
	path := filepath.Join(r.Dir, ".s.PGSQL.5432")
	if st, err := os.Stat(path); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode %v, %v", st, err)
	}
	c := dialRelay(t, r)
	if _, err := c.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 5)
	if _, err := c.Read(got); err != nil || string(got) != "hello" {
		t.Fatalf("echo %q %v", got, err)
	}
	time.Sleep(20 * time.Millisecond)
	if _, err := net.Dial("unix", path); err == nil {
		t.Fatal("a second client reached the relay")
	}
	_ = c.Close()
	if reason := r.Wait(); reason != "client_closed" && reason != "server_closed" {
		t.Fatalf("reason %q", reason)
	}
	if _, err := os.Stat(r.Dir); !os.IsNotExist(err) {
		t.Fatalf("directory left: %v", err)
	}
	if up, _ := r.Bytes(); up != 10 {
		t.Fatalf("bytes to the server %d", up)
	}
}

// claim: DB-003
func TestRelayEndsIdleAtItsDeadlineAndWithoutAClient(t *testing.T) {
	idle, err := OpenRelay(context.Background(), fakeUpstream(t), RelayOptions{MaxDuration: 30 * time.Second, Idle: 120 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	c := dialRelay(t, idle)
	defer c.Close()
	if reason := idle.Wait(); reason != "idle" {
		t.Fatalf("idle: %q", reason)
	}
	lonely, err := OpenRelay(context.Background(), fakeUpstream(t), RelayOptions{MaxDuration: 30 * time.Second, Accept: 80 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if reason := lonely.Wait(); reason != "accept_timeout" {
		t.Fatalf("accept: %q", reason)
	}
	busy, err := OpenRelay(context.Background(), fakeUpstream(t), RelayOptions{MaxDuration: 150 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	b := dialRelay(t, busy)
	defer b.Close()
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(20 * time.Millisecond):
				_, _ = b.Write([]byte("x"))
			}
		}
	}()
	if reason := busy.Wait(); reason != "deadline" {
		t.Fatalf("deadline: %q", reason)
	}
	close(stop)
}

func TestSignInFilterDropsChannelBinding(t *testing.T) {
	body := []byte("SCRAM-SHA-256-PLUS\x00SCRAM-SHA-256\x00\x00")
	msg := append([]byte{'R', 0, 0, 0, 0, 0, 0, 0, 10}, body...)
	binary.BigEndian.PutUint32(msg[1:5], uint32(len(msg)-1))
	f := &signInFilter{}
	out, err := f.push(msg[:6])
	if err != nil || len(out) != 0 {
		t.Fatalf("partial: %q %v", out, err)
	}
	out, err = f.push(msg[6:])
	if err != nil || string(out[9:]) != "SCRAM-SHA-256\x00\x00" || int(binary.BigEndian.Uint32(out[1:5])) != len(out)-1 {
		t.Fatalf("rewritten: %q %v", out, err)
	}
	out, _ = f.push(append(append([]byte{}, authOK...), []byte("Z-rest")...))
	if !f.done || string(out[9:]) != "Z-rest" {
		t.Fatalf("after ok: %q", out)
	}
	if out, _ := f.push([]byte("raw")); string(out) != "raw" {
		t.Fatalf("raw: %q", out)
	}
	if _, err := (&signInFilter{}).push([]byte{'R', 0x7f, 0, 0, 0}); err == nil {
		t.Fatal("a huge sign-in message passed")
	}
}

// claim: DB-002
func TestProgramsGetFixedArgumentsAndAnEnvironmentOfTheirOwn(t *testing.T) {
	if got := DumpArgs("shop's=db"); !reflect.DeepEqual(got, []string{"--format=custom", "--compress=0", "--no-password", `--dbname=dbname='shop\'s=db'`}) {
		t.Fatalf("dump args %q", got)
	}
	if got := RestoreArgs("new"); !reflect.DeepEqual(got, []string{"--exit-on-error", "--no-owner", "--no-privileges", "--no-password", "--dbname=dbname='new'"}) {
		t.Fatalf("restore args %q", got)
	}
	env := strings.Join(ToolEnv("/dev/shm/x", 5432, "backup", "/dev/shm/p"), "\n")
	for _, want := range []string{"PGHOST=/dev/shm/x", "PGSSLMODE=disable", "PGPASSFILE=/dev/shm/p", "PGUSER=backup"} {
		if !strings.Contains(env, want) {
			t.Fatalf("env misses %s: %s", want, env)
		}
	}
	if PassFileLine(`se:cr\et`) != `*:*:*:*:se\:cr\\et`+"\n" {
		t.Fatalf("pass file line %q", PassFileLine(`se:cr\et`))
	}
	dir := t.TempDir()
	path, err := WritePassFile(dir, "secret")
	if err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o600 {
		t.Fatalf("pass file mode %v", st.Mode().Perm())
	}
	if ToolMajor("pg_dump (PostgreSQL) 18.1 (Debian 18.1-1.pgdg12+1)") != 18 || ToolMajor("pg_dump (PostgreSQL) 9.6.24") != 0 {
		t.Fatal("tool major")
	}
	if _, err := ChooseTools(context.Background(), 16, nil); err == nil || err.(*ToolError).Code != "db_tool_missing" {
		t.Fatalf("tools: %v", err)
	}
	counts := CountListEntries("215; 1259 16390 TABLE public orders restow\n3380; 0 16390 TABLE DATA public orders restow\n3200; 2606 16400 FK CONSTRAINT public items fk restow\n;\n")
	if !reflect.DeepEqual(counts, map[string]int{"TABLE": 1, "TABLE DATA": 1, "FK CONSTRAINT": 1}) {
		t.Fatalf("counts %v", counts)
	}
	if !ValidName(strings.Repeat("a", 63)) || ValidName(strings.Repeat("a", 64)) || ValidName("") {
		t.Fatal("names")
	}
}
