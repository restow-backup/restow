// Package dbrun runs the backup and restore runs of the module "Databases"
// on the agent (docs/DATABASES.md 4.1, 4.3, 5.1, 5.2, 7.1, 16 "D3"): the
// pinning relay, the choice of the PostgreSQL programs, db-stream and the
// runs themselves. Standard library only.
package dbrun

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// The pinning relay (O1): the agent opens the connection with the hardened
// client (dbprobe.OpenPinned: TLS and the confirmed certificate before any
// sign-in) and hands pg_dump or pg_restore a plain connection over a Unix
// socket of its own: a fresh directory with 0700 (in memory where the
// machine has one), exactly one client (the socket is removed the moment it
// connects), copying with fixed buffers (no unbounded buffering), ended by
// either side, by idleness, by its deadline, and without a client after the
// accept timeout; then both connections are closed and the directory removed.
// During the sign-in it offers the program SCRAM without channel binding:
// libpq refuses SCRAM-SHA-256-PLUS on a plain socket, and the certificate is
// pinned here.

// RelayPort is the port in the socket's name (libpq: <dir>/.s.PGSQL.<port>).
const RelayPort = 5432

// signInMessageMax bounds a server message during the sign-in.
const signInMessageMax = 64 << 10

// RelayOptions bound a relay.
type RelayOptions struct {
	// MaxDuration ends it at the latest.
	MaxDuration time.Duration
	// Idle ends it when no byte moved either way for this long (default 10 min).
	Idle time.Duration
	// Accept ends it when no client came within this (default 60 s).
	Accept time.Duration
	// BaseDir is where its directory is made (default RAMDir()).
	BaseDir string
}

// Relay is one relayed session.
type Relay struct {
	Dir  string
	Port int
	// Path is the socket's file (PostgreSQL .s.PGSQL.<port>, MySQL mysqld.sock).
	Path string

	mu       sync.Mutex
	upstream net.Conn
	// begin (MySQL) reads the program's login and makes the upstream ready.
	begin func(client net.Conn) (net.Conn, error)
	// mysql filters the sign-in both ways (MySQL); nil: PostgreSQL's filter.
	mysql    *mysqlFilter
	failure  error
	ln       *net.UnixListener
	once     sync.Once
	done     chan struct{}
	reason   atomic.Value
	toServer atomic.Int64
	toClient atomic.Int64
	last     atomic.Int64
}

// RAMDir is a directory in memory where the machine has one (/dev/shm,
// /run/user/<uid>), else the temporary directory.
func RAMDir() string {
	for _, dir := range []string{"/dev/shm"} {
		if st, err := os.Stat(dir); err == nil && st.IsDir() {
			return dir
		}
	}
	return os.TempDir()
}

// PrivateDir makes a fresh directory with 0700 below base.
func PrivateDir(base, prefix string) (string, error) {
	if base == "" {
		base = RAMDir()
	}
	dir, err := os.MkdirTemp(base, prefix)
	if err != nil {
		return "", err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		_ = os.RemoveAll(dir)
		return "", err
	}
	return dir, nil
}

// OpenRelay starts the relay over upstream (a pinned connection, Detach).
func OpenRelay(ctx context.Context, upstream net.Conn, o RelayOptions) (*Relay, error) {
	if o.Idle <= 0 {
		o.Idle = 10 * time.Minute
	}
	if o.Accept <= 0 {
		o.Accept = 60 * time.Second
	}
	dir, err := PrivateDir(o.BaseDir, "restow-pg-relay-")
	if err != nil {
		_ = upstream.Close()
		return nil, err
	}
	path := filepath.Join(dir, ".s.PGSQL."+strconv.Itoa(RelayPort))
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		_ = upstream.Close()
		_ = os.RemoveAll(dir)
		return nil, err
	}
	ln.SetUnlinkOnClose(true)
	if err := os.Chmod(path, 0o600); err != nil {
		_ = ln.Close()
		_ = upstream.Close()
		_ = os.RemoveAll(dir)
		return nil, err
	}
	r := &Relay{Dir: dir, Port: RelayPort, Path: path, upstream: upstream, ln: ln, done: make(chan struct{})}
	r.last.Store(time.Now().UnixNano())
	go r.serve(ctx, o)
	return r, nil
}

// listen makes the relay's folder and its socket name (one client, 0600).
func listen(base, name string) (string, string, *net.UnixListener, error) {
	dir, err := PrivateDir(base, "restow-pg-relay-")
	if err != nil {
		return "", "", nil, err
	}
	path := filepath.Join(dir, name)
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", "", nil, err
	}
	ln.SetUnlinkOnClose(true)
	if err := os.Chmod(path, 0o600); err != nil {
		_ = ln.Close()
		_ = os.RemoveAll(dir)
		return "", "", nil, err
	}
	return dir, path, ln, nil
}

// Failure is why the sign-in filter ended the relay, or nil.
func (r *Relay) Failure() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.failure
}

func (r *Relay) finish(reason string) {
	r.once.Do(func() {
		r.reason.Store(reason)
		_ = r.ln.Close()
		r.mu.Lock()
		up := r.upstream
		r.mu.Unlock()
		if up != nil {
			_ = up.Close()
		}
		_ = os.RemoveAll(r.Dir)
		close(r.done)
	})
}

// Close ends the relay now.
func (r *Relay) Close() { r.finish("closed") }

// Wait blocks until the relay ended and says why.
func (r *Relay) Wait() string {
	<-r.done
	reason, _ := r.reason.Load().(string)
	return reason
}

// Bytes are what went to the server and to the client.
func (r *Relay) Bytes() (toServer, toClient int64) { return r.toServer.Load(), r.toClient.Load() }

func (r *Relay) serve(ctx context.Context, o RelayOptions) {
	deadline := time.NewTimer(o.MaxDuration)
	defer deadline.Stop()
	accepted := make(chan net.Conn, 1)
	go func() {
		_ = r.ln.SetDeadline(time.Now().Add(o.Accept))
		c, err := r.ln.AcceptUnix()
		if err != nil {
			accepted <- nil
			return
		}
		// One client: no one else reaches the socket from now on.
		_ = r.ln.Close()
		accepted <- c
		// A second connection that raced the close is refused.
	}()
	var client net.Conn
	select {
	case client = <-accepted:
		if client == nil {
			r.finish("accept_timeout")
			return
		}
	case <-deadline.C:
		r.finish("deadline")
		return
	case <-ctx.Done():
		r.finish("closed")
		return
	case <-r.done:
		return
	}
	defer client.Close()
	if r.begin != nil {
		up, err := r.begin(client)
		if err != nil {
			r.mu.Lock()
			r.failure = err
			r.mu.Unlock()
			r.finish("error")
			return
		}
		r.mu.Lock()
		r.upstream = up
		r.mu.Unlock()
		select {
		case <-r.done:
			_ = up.Close()
			return
		default:
		}
	}
	upstream := r.upstream
	var copies sync.WaitGroup
	copies.Add(2)
	if r.mysql != nil {
		go func() {
			defer copies.Done()
			r.pumpMysql(client, upstream, client, &r.toServer, true)
			r.finish("client_closed")
		}()
		go func() {
			defer copies.Done()
			r.pumpMysql(upstream, upstream, client, &r.toClient, false)
			r.finish("server_closed")
		}()
	} else {
		go func() {
			defer copies.Done()
			r.pump(client, upstream, &r.toServer, nil)
			r.finish("client_closed")
		}()
		go func() {
			defer copies.Done()
			r.pump(upstream, client, &r.toClient, &signInFilter{})
			r.finish("server_closed")
		}()
	}
	idle := time.NewTicker(o.Idle / 4)
	defer idle.Stop()
	for {
		select {
		case <-r.done:
			_ = client.Close()
			copies.Wait()
			return
		case <-deadline.C:
			r.finish("deadline")
		case <-ctx.Done():
			r.finish("closed")
		case <-idle.C:
			if time.Since(time.Unix(0, r.last.Load())) >= o.Idle {
				r.finish("idle")
			}
		}
	}
}

// pump copies from src to dst with one fixed buffer; filter (server to
// client only) rewrites the sign-in.
func (r *Relay) pump(src, dst net.Conn, count *atomic.Int64, filter *signInFilter) {
	buf := make([]byte, 32<<10)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			r.last.Store(time.Now().UnixNano())
			count.Add(int64(n))
			out := buf[:n]
			if filter != nil && !filter.done {
				var ferr error
				out, ferr = filter.push(out)
				if ferr != nil {
					return
				}
			}
			if len(out) > 0 {
				if _, werr := dst.Write(out); werr != nil {
					return
				}
			}
		}
		if err != nil {
			return
		}
	}
}

// signInFilter reads the server's messages until the sign-in is through and
// drops -PLUS mechanisms from an AuthenticationSASL list.
type signInFilter struct {
	pending []byte
	done    bool
}

var errSignInMessage = errors.New("a sign-in message is too large")

func (f *signInFilter) push(chunk []byte) ([]byte, error) {
	if f.done {
		return chunk, nil
	}
	f.pending = append(f.pending, chunk...)
	var out []byte
	for len(f.pending) >= 5 {
		typ := f.pending[0]
		length := int(binary.BigEndian.Uint32(f.pending[1:5]))
		if length < 4 || length > signInMessageMax {
			return nil, errSignInMessage
		}
		if len(f.pending) < 1+length {
			break
		}
		msg := f.pending[:1+length]
		rest := f.pending[1+length:]
		if typ == 'R' && length >= 8 {
			code := binary.BigEndian.Uint32(msg[5:9])
			if code == 10 {
				msg = withoutPlus(msg)
			}
			if code == 0 {
				f.done = true
			}
		}
		if typ == 'E' {
			f.done = true
		}
		out = append(out, msg...)
		f.pending = rest
		if f.done {
			out = append(out, f.pending...)
			f.pending = nil
			break
		}
	}
	return out, nil
}

func withoutPlus(msg []byte) []byte {
	var names []string
	for _, name := range strings.Split(string(msg[9:]), "\x00") {
		if name != "" && !strings.HasSuffix(name, "-PLUS") {
			names = append(names, name)
		}
	}
	body := []byte{}
	for _, name := range names {
		body = append(append(body, name...), 0)
	}
	body = append(body, 0)
	out := make([]byte, 9, 9+len(body))
	out[0] = 'R'
	binary.BigEndian.PutUint32(out[1:5], uint32(8+len(body)))
	binary.BigEndian.PutUint32(out[5:9], 10)
	return append(out, body...)
}
