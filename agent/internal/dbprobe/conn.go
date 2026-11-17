// Package dbprobe tests a database connection for the server (docs/DATABASES.md
// 3, stage D1): it recognises the engine from the first exchange of its
// protocol, switches to TLS whenever the server offers it, signs in and reads
// the facts of the rights matrix and of the instance's identity. It reports
// facts only (api.DBProbeResult); the server judges them. The same work is done
// in TypeScript by the Restow server itself (@restow/core databases/probe), and
// both read the shared fixtures in internal/api/testdata/contract.
//
// It speaks the protocols itself (PostgreSQL 3.0 with SCRAM-SHA-256, MD5 and
// plain passwords; MySQL protocol 10 with mysql_native_password and
// caching_sha2_password; the TDS PRELOGIN of SQL Server), so the agent keeps
// to the standard library. Credentials stay in memory and never reach a log or
// a message: every message passes through Sanitize.
package dbprobe

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync/atomic"
	"time"
)

// conn is a connection with a read buffer, deadlines per step and the switch
// to TLS in the middle of a conversation. Every read and write is bounded by
// the step and by the probe's context: when the probe's deadline passes (or
// the probe ends), the connection is closed, whatever it waits for.
type conn struct {
	raw     net.Conn
	r       *bufio.Reader
	ctx     context.Context
	budget  *readBudget
	step    time.Duration
	tlsUsed bool
	cert    *certFacts
	stop    func() bool
}

// maxRead is the largest single read of the probe (a message or a packet).
const maxRead = 1 << 20

// readBudgetBytes is what one probe reads at most, over all its connections.
const readBudgetBytes = 8 << 20

// maxValueBytes: a value of a row is kept up to this many bytes.
const maxValueBytes = 4096

// readBudget counts what the connections of one probe read.
type readBudget struct{ left atomic.Int64 }

type budgetKey struct{}

// withReadBudget gives the probe's context a budget its connections share.
func withReadBudget(ctx context.Context, bytes int64) context.Context {
	b := &readBudget{}
	b.left.Store(bytes)
	return context.WithValue(ctx, budgetKey{}, b)
}

// errTooLarge: the server announced more data than the probe reads.
var errTooLarge = errors.New("the server sent more data than the probe reads")

type certFacts struct {
	fingerprint string
	subject     string
	issuer      string
	notAfter    time.Time
}

// errClosed: the server ended the connection.
var errClosed = errors.New("the server closed the connection")

// dialer opens a connection; tests replace it.
type dialer func(ctx context.Context, network, address string) (net.Conn, error)

func defaultDial(ctx context.Context, network, address string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, network, address)
}

func openConn(ctx context.Context, dial dialer, network, address string, step time.Duration) (*conn, error) {
	dctx, cancel := context.WithTimeout(ctx, step)
	defer cancel()
	raw, err := dial(dctx, network, address)
	if err != nil {
		return nil, err
	}
	c := &conn{raw: raw, r: bufio.NewReader(raw), ctx: ctx, step: step}
	c.budget, _ = ctx.Value(budgetKey{}).(*readBudget)
	// The probe's end or deadline closes the connection (and wakes every read).
	c.stop = context.AfterFunc(ctx, func() { _ = raw.Close() })
	return c, nil
}

// deadline is the end of one step, never later than the probe's deadline.
func (c *conn) deadline() {
	until := time.Now().Add(c.step)
	if d, ok := c.ctx.Deadline(); ok && d.Before(until) {
		until = d
	}
	_ = c.raw.SetDeadline(until)
}

// readFull reads exactly n bytes within one step.
func (c *conn) readFull(n int) ([]byte, error) {
	if n < 0 || n > maxRead {
		return nil, errTooLarge
	}
	if c.budget != nil && c.budget.left.Add(-int64(n)) < 0 {
		return nil, errTooLarge
	}
	if err := c.ctx.Err(); err != nil {
		return nil, errProbeTimeout
	}
	c.deadline()
	b := make([]byte, n)
	if _, err := io.ReadFull(c.r, b); err != nil {
		if c.expired() {
			return nil, errProbeTimeout
		}
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, errClosed
		}
		return nil, err
	}
	return b, nil
}

// expired: the probe's deadline passed (or the probe ended).
func (c *conn) expired() bool {
	if c.ctx.Err() != nil {
		return true
	}
	d, ok := c.ctx.Deadline()
	return ok && !time.Now().Before(d)
}

// errProbeTimeout: the probe's deadline passed.
var errProbeTimeout = errors.New("the probe did not finish in time")

// peek returns what the server sends on its own within d, or nothing.
func (c *conn) peek(d time.Duration) []byte {
	until := time.Now().Add(d)
	if dl, ok := c.ctx.Deadline(); ok && dl.Before(until) {
		until = dl
	}
	_ = c.raw.SetReadDeadline(until)
	b, _ := c.r.Peek(1)
	if len(b) == 0 {
		return nil
	}
	n := c.r.Buffered()
	out, _ := c.r.Peek(n)
	return append([]byte(nil), out...)
}

func (c *conn) write(b []byte) error {
	if err := c.ctx.Err(); err != nil {
		return errProbeTimeout
	}
	c.deadline()
	_, err := c.raw.Write(b)
	return err
}

// startTLS switches to TLS. The certificate is pinned by its fingerprint
// (the server stores it and turns red on another one), not checked against a
// CA: self-signed certificates are the rule for databases.
func (c *conn) startTLS(serverName string) error {
	if c.r.Buffered() > 0 {
		return errors.New("the server sent data before the TLS handshake")
	}
	cfg := &tls.Config{
		MinVersion: tls.VersionTLS12,
		// #nosec G402 -- pinned by fingerprint below (docs/DATABASES.md 3.2).
		InsecureSkipVerify: true, //nolint:gosec
		ServerName:         serverName,
	}
	tc := tls.Client(c.raw, cfg)
	c.deadline()
	if err := tc.HandshakeContext(c.ctx); err != nil {
		if c.expired() {
			return errProbeTimeout
		}
		return fmt.Errorf("TLS: %w", err)
	}
	state := tc.ConnectionState()
	if len(state.PeerCertificates) > 0 {
		leaf := state.PeerCertificates[0]
		sum := sha256.Sum256(leaf.Raw)
		hexes := make([]string, len(sum))
		for i, b := range sum {
			hexes[i] = fmt.Sprintf("%02X", b)
		}
		c.cert = &certFacts{
			fingerprint: strings.Join(hexes, ":"),
			subject:     leaf.Subject.String(),
			issuer:      leaf.Issuer.String(),
			notAfter:    leaf.NotAfter,
		}
	}
	c.raw = tc
	c.r = bufio.NewReader(tc)
	c.tlsUsed = true
	if c.stop != nil {
		c.stop()
	}
	c.stop = context.AfterFunc(c.ctx, func() { _ = tc.Close() })
	return nil
}

func (c *conn) close() {
	if c.stop != nil {
		c.stop()
	}
	_ = c.raw.Close()
}
