package dbrun

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/restow-backup/restow/agent/internal/dbprobe"
)

// The relay of MySQL and MariaDB (16 "D4" M1), like packages/core
// databases/relay.ts openMysqlRelay: the program gets the original greeting
// without the TLS and compression flags; its login decides the SSLRequest
// (the server keeps those capabilities), then TLS and the certificate check,
// then the login with a new sequence number. Until the server's OK or error
// every packet gets a new sequence number either way; without TLS upstream
// the relay does caching_sha2_password's RSA step itself and ends before any
// method that would send the password readable (db_auth_unsupported).

// MysqlRelaySocket is the socket's file in the relay's folder.
const MysqlRelaySocket = "mysqld.sock"

const (
	myClientConnectWithDB = 0x8
	myClientCompress      = 0x20
	myClientSSL           = 0x800
	myClientSecure        = 0x8000
	myClientPluginAuth    = 0x80000
	myClientLenencData    = 0x200000
	myClientZstd          = 0x4000000
)

var mysqlPlainSafe = map[string]bool{"mysql_native_password": true, "caching_sha2_password": true, "client_ed25519": true, "parsec": true}

type mysqlFilter struct {
	mu            sync.Mutex
	greeting      []byte
	upstreamTLS   bool
	scramble      []byte
	plugin        string
	clientPending []byte
	serverPending []byte
	serverSeq     byte
	clientSeq     byte
	finished      bool
	rsa           int // 0 none, 1 waiting for the password, 2 waiting for the key
	rsaPassword   []byte
}

func takeMysqlPacket(b []byte) (seq byte, payload, rest []byte, ok bool, tooLarge bool) {
	if len(b) < 4 {
		return 0, nil, b, false, false
	}
	n := int(b[0]) | int(b[1])<<8 | int(b[2])<<16
	if n > signInMessageMax {
		return 0, nil, b, false, true
	}
	if len(b) < 4+n {
		return 0, nil, b, false, false
	}
	return b[3], b[4 : 4+n], b[4+n:], true, false
}

func (f *mysqlFilter) greetingForClient() []byte {
	p := append([]byte(nil), f.greeting...)
	end := bytes.IndexByte(p[1:], 0)
	if end >= 0 {
		lower := 1 + end + 1 + 4 + 8 + 1
		if len(p) >= lower+2 {
			caps := binary.LittleEndian.Uint16(p[lower:]) &^ uint16(myClientSSL|myClientCompress)
			binary.LittleEndian.PutUint16(p[lower:], caps)
			upper := lower + 2 + 1 + 2
			if len(p) >= upper+2 {
				high := binary.LittleEndian.Uint16(p[upper:]) &^ uint16(myClientZstd>>16)
				binary.LittleEndian.PutUint16(p[upper:], high)
			}
		}
	}
	return dbprobe.MysqlPacket(0, p)
}

func loginPluginOf(p []byte) string {
	if len(p) < 32 {
		return ""
	}
	caps := binary.LittleEndian.Uint32(p)
	off := 32
	i := bytes.IndexByte(p[off:], 0)
	if i < 0 {
		return ""
	}
	off += i + 1
	switch {
	case caps&myClientLenencData != 0:
		if off >= len(p) {
			return ""
		}
		switch first := p[off]; {
		case first < 0xfb:
			off += 1 + int(first)
		case first == 0xfc && off+3 <= len(p):
			off += 3 + int(binary.LittleEndian.Uint16(p[off+1:]))
		default:
			return ""
		}
	case caps&myClientSecure != 0:
		if off >= len(p) {
			return ""
		}
		off += 1 + int(p[off])
	default:
		j := bytes.IndexByte(p[off:], 0)
		if j < 0 {
			return ""
		}
		off += j + 1
	}
	if caps&myClientConnectWithDB != 0 {
		if off > len(p) {
			return ""
		}
		j := bytes.IndexByte(p[off:], 0)
		if j < 0 {
			return ""
		}
		off += j + 1
	}
	if caps&myClientPluginAuth == 0 || off >= len(p) {
		return ""
	}
	rest := p[off:]
	if j := bytes.IndexByte(rest, 0); j >= 0 {
		rest = rest[:j]
	}
	return string(rest)
}

// login takes the program's first packet: the SSLRequest (with TLS) and the
// login for the server.
func (f *mysqlFilter) login(payload []byte) (sslRequest, toServer []byte, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.clientSeq = 1
	if len(payload) <= 32 {
		return nil, nil, failf("db_probe_failed", "the program asked for TLS on the relay's local socket")
	}
	l := append([]byte(nil), payload...)
	caps := binary.LittleEndian.Uint32(l) &^ uint32(myClientCompress|myClientZstd)
	if f.upstreamTLS {
		caps |= myClientSSL
	} else {
		caps &^= myClientSSL
	}
	binary.LittleEndian.PutUint32(l, caps)
	if p := loginPluginOf(l); p != "" {
		f.plugin = p
	}
	if !f.upstreamTLS && !mysqlPlainSafe[f.plugin] {
		return nil, nil, failf("db_auth_unsupported", "the sign-in method %s sends the password readable; the connection has no TLS", f.plugin)
	}
	toServer = dbprobe.MysqlPacket(f.serverSeq, l)
	f.serverSeq++
	return dbprobe.MysqlPacket(1, l[:32]), toServer, nil
}

func (f *mysqlFilter) fromClient(chunk []byte) (toServer []byte, done bool, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.finished {
		return chunk, true, nil
	}
	f.clientPending = append(f.clientPending, chunk...)
	for {
		seq, payload, rest, ok, tooLarge := takeMysqlPacket(f.clientPending)
		if tooLarge {
			return nil, false, failf("db_probe_failed", "the program sent a packet too large for a sign-in")
		}
		if !ok {
			break
		}
		f.clientPending = rest
		f.clientSeq = seq
		if f.rsa == 1 {
			// The program's password for the full caching_sha2 step: never sent on readable.
			f.rsaPassword = append([]byte(nil), payload...)
			f.rsa = 2
			toServer = append(toServer, dbprobe.MysqlPacket(f.serverSeq, []byte{0x02})...)
			f.serverSeq++
			continue
		}
		toServer = append(toServer, dbprobe.MysqlPacket(f.serverSeq, payload)...)
		f.serverSeq++
	}
	return toServer, false, nil
}

func (f *mysqlFilter) fromServer(chunk []byte) (toServer, toClient []byte, done bool, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.finished {
		return nil, chunk, true, nil
	}
	f.serverPending = append(f.serverPending, chunk...)
	for {
		seq, payload, rest, ok, tooLarge := takeMysqlPacket(f.serverPending)
		if tooLarge {
			return nil, nil, false, failf("db_probe_failed", "the server sent a packet too large for a sign-in")
		}
		if !ok {
			break
		}
		f.serverPending = rest
		f.serverSeq = seq + 1
		head := -1
		if len(payload) > 0 {
			head = int(payload[0])
		}
		if f.rsa == 2 {
			if head != 0x01 {
				return nil, nil, false, failf("db_login_failed", "the server did not send its RSA key")
			}
			key := payload[1:]
			if len(key) > 16<<10 {
				key = key[:16<<10]
			}
			sealed, serr := dbprobe.MysqlRSAPassword(key, f.rsaPassword, f.scramble)
			for i := range f.rsaPassword {
				f.rsaPassword[i] = 0
			}
			f.rsaPassword = nil
			if serr != nil {
				return nil, nil, false, failf("db_login_failed", "the server's RSA key could not be used")
			}
			toServer = append(toServer, dbprobe.MysqlPacket(f.serverSeq, sealed)...)
			f.serverSeq++
			f.rsa = 0
			continue
		}
		switch {
		case head == 0xfe && len(payload) > 1:
			rest := payload[1:]
			end := bytes.IndexByte(rest, 0)
			if end < 0 {
				end = len(rest)
			}
			f.plugin = string(rest[:end])
			data := []byte{}
			if end < len(rest) {
				data = rest[end+1:]
			}
			if len(data) > 20 {
				data = data[:20]
			}
			f.scramble = append([]byte(nil), data...)
			if !f.upstreamTLS && !mysqlPlainSafe[f.plugin] {
				return nil, nil, false, failf("db_auth_unsupported", "the server asks for the sign-in method %s, which sends the password readable; the connection has no TLS", f.plugin)
			}
		case head == 0x01 && len(payload) >= 2 && f.plugin == "caching_sha2_password" && payload[1] == 0x04 && !f.upstreamTLS:
			f.rsa = 1
		}
		f.clientSeq++
		toClient = append(toClient, dbprobe.MysqlPacket(f.clientSeq, payload)...)
		if head == 0x00 || head == 0xff {
			f.finished = true
			toClient = append(toClient, f.serverPending...)
			f.serverPending = nil
			break
		}
	}
	return toServer, toClient, f.finished, nil
}

// pumpMysql copies src to the other side through the MySQL filter until the
// sign-in is through, then as it is.
func (r *Relay) pumpMysql(src, upstream, client net.Conn, count *atomic.Int64, fromClient bool) {
	buf := make([]byte, 32<<10)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			r.last.Store(time.Now().UnixNano())
			count.Add(int64(n))
			var toServer, toClient []byte
			var ferr error
			if fromClient {
				toServer, _, ferr = r.mysql.fromClient(buf[:n])
			} else {
				toServer, toClient, _, ferr = r.mysql.fromServer(buf[:n])
			}
			if ferr != nil {
				r.mu.Lock()
				r.failure = ferr
				r.mu.Unlock()
				r.finish("error")
				return
			}
			if len(toServer) > 0 {
				if _, werr := upstream.Write(toServer); werr != nil {
					return
				}
			}
			if len(toClient) > 0 {
				if _, werr := client.Write(toClient); werr != nil {
					return
				}
			}
		}
		if err != nil {
			return
		}
	}
}

// OpenMysqlRelay starts the relay over a pinned MySQL connection (its TLS
// waits for the program's login).
func OpenMysqlRelay(ctx context.Context, pinned *dbprobe.PinnedMysql, o RelayOptions) (*Relay, error) {
	if o.Idle <= 0 {
		o.Idle = 10 * time.Minute
	}
	if o.Accept <= 0 {
		o.Accept = 60 * time.Second
	}
	dir, path, ln, err := listen(o.BaseDir, MysqlRelaySocket)
	if err != nil {
		pinned.Close()
		return nil, err
	}
	f := &mysqlFilter{greeting: pinned.Greeting(), upstreamTLS: pinned.TLSOffered, scramble: pinned.Scramble(), plugin: pinned.Plugin(), serverSeq: 1}
	if f.plugin == "" {
		f.plugin = "mysql_native_password"
	}
	if f.upstreamTLS {
		f.serverSeq = 2
	}
	r := &Relay{Dir: dir, Path: path, ln: ln, done: make(chan struct{}), mysql: f}
	r.begin = func(client net.Conn) (net.Conn, error) {
		if _, err := client.Write(f.greetingForClient()); err != nil {
			pinned.Close()
			return nil, err
		}
		_ = client.SetReadDeadline(time.Now().Add(o.Accept))
		var got []byte
		buf := make([]byte, 4096)
		for {
			n, err := client.Read(buf)
			got = append(got, buf[:n]...)
			_, payload, rest, ok, tooLarge := takeMysqlPacket(got)
			if tooLarge {
				pinned.Close()
				return nil, failf("db_probe_failed", "the program's login is too large")
			}
			if ok {
				_ = client.SetReadDeadline(time.Time{})
				ssl, toServer, lerr := f.login(payload)
				if lerr != nil {
					pinned.Close()
					return nil, lerr
				}
				if pinned.TLSOffered {
					if terr := pinned.StartTLS(ssl); terr != nil {
						pinned.Close()
						return nil, terr
					}
				}
				up, derr := pinned.Detach()
				if derr != nil {
					pinned.Close()
					return nil, derr
				}
				if _, werr := up.Write(toServer); werr != nil {
					_ = up.Close()
					return nil, werr
				}
				if len(rest) > 0 {
					more, _, ferr := f.fromClient(rest)
					if ferr != nil {
						_ = up.Close()
						return nil, ferr
					}
					_, _ = up.Write(more)
				}
				return up, nil
			}
			if err != nil {
				pinned.Close()
				return nil, fmt.Errorf("the program sent no login: %w", err)
			}
		}
	}
	r.last.Store(time.Now().UnixNano())
	go r.serve(ctx, o)
	return r, nil
}
