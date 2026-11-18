package dbprobe

import (
	"bytes"
	"context"
	"errors"
	"net"
	"strconv"
	"testing"
	"time"
)

// plainPG answers the SSLRequest with N and then nothing.
func plainPG(t *testing.T) (string, int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				head := make([]byte, 8)
				if _, err := c.Read(head); err == nil {
					_, _ = c.Write([]byte("N"))
				}
				time.Sleep(time.Second)
				_ = c.Close()
			}()
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	return addr.IP.String(), addr.Port
}

// claim: DB-003
func TestPinnedConnectionsGoToTheRunsFirstAddress(t *testing.T) {
	ip, port := plainPG(t)
	var dialed []string
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		dialed = append(dialed, address)
		var d net.Dialer
		return d.DialContext(ctx, network, address)
	}
	// The name is never resolved again: the run's address is dialed, TLS
	// would still name the host.
	p, err := OpenPinned(context.Background(), PinnedTarget{Host: "db.example.test", Port: port, AllowUnencrypted: true, Address: ip}, 5*time.Second, dial)
	if err != nil {
		t.Fatal(err)
	}
	if p.RemoteAddress != ip {
		t.Fatalf("reached %q", p.RemoteAddress)
	}
	p.Close()
	if len(dialed) != 1 || dialed[0] != net.JoinHostPort(ip, itoa(port)) {
		t.Fatalf("dialed %v", dialed)
	}
	// An IP address as the host must be the run's.
	_, err = OpenPinned(context.Background(), PinnedTarget{Host: ip, Port: port, AllowUnencrypted: true, Address: "127.0.0.2"}, 5*time.Second, dial)
	var pe *PinnedError
	if !errors.As(err, &pe) || pe.Code != CodeInstanceChanged || len(dialed) != 1 {
		t.Fatalf("other address: %v (dialed %v)", err, dialed)
	}
	// A connection that lands elsewhere than the run's address is refused.
	elsewhere := func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, net.JoinHostPort(ip, itoa(port)))
	}
	_, err = OpenPinned(context.Background(), PinnedTarget{Host: "db.example.test", Port: port, AllowUnencrypted: true, Address: "127.0.0.2"}, 5*time.Second, elsewhere)
	if !errors.As(err, &pe) || pe.Code != CodeInstanceChanged {
		t.Fatalf("landed elsewhere: %v", err)
	}
}

// claim: DB-008
func TestSessionsAskForUTF8(t *testing.T) {
	if !bytes.Contains(pgStartup("backup", "app"), []byte("client_encoding\x00UTF8\x00")) {
		t.Fatal("the startup message does not set client_encoding UTF8")
	}
}

func itoa(n int) string { return strconv.Itoa(n) }
