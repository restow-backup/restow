package dbprobe

import (
	"context"
	"errors"
	"net"
	"strconv"
	"time"
)

// The pinned PostgreSQL connection of a backup or restore run
// (docs/DATABASES.md 16, "D3" O1): opened like the probe's (the SSLRequest,
// TLS whenever the server offers it, the confirmed certificate compared
// before anything of the sign-in is sent, no plain connection unless the
// connection allows it), then either signed in by the agent itself (its own
// statements) or handed to the relay (internal/dbrun) for pg_dump and
// pg_restore, which cannot hold a fingerprint.

// PinnedTarget is where a pinned connection goes.
type PinnedTarget struct {
	Host             string
	Port             int
	AllowUnencrypted bool
	// Fingerprint is the confirmed certificate (SHA-256, upper-case hex
	// pairs); empty only for a connection without TLS.
	Fingerprint string
}

// PinnedConn is a connection after TLS and the certificate check.
type PinnedConn struct {
	c *conn
	// TLS is whether the session is encrypted.
	TLS bool
	// Fingerprint is the certificate the server showed.
	Fingerprint string
}

// PinnedError is why a pinned connection was refused, with its code.
type PinnedError struct {
	Code    string
	Message string
}

func (e *PinnedError) Error() string { return e.Message }

// OpenPinned opens the connection within timeout. Nothing of the sign-in has
// been sent when it returns. dial nil: the system's.
func OpenPinned(ctx context.Context, target PinnedTarget, timeout time.Duration, dial func(ctx context.Context, network, address string) (net.Conn, error)) (*PinnedConn, error) {
	if dial == nil {
		dial = defaultDial
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	address := net.JoinHostPort(target.Host, strconv.Itoa(target.Port))
	// The connection outlives the connect's own deadline: its context is the
	// caller's, and only the steps here are bounded by cctx.
	c, err := openConn(ctx, dial, "tcp", address, timeout)
	if err != nil {
		return nil, &PinnedError{Code: CodeUnreachable, Message: err.Error()}
	}
	refuse := func(code, message string) (*PinnedConn, error) {
		c.close()
		return nil, &PinnedError{Code: code, Message: message}
	}
	stopAtConnect := context.AfterFunc(cctx, func() {
		if errors.Is(cctx.Err(), context.DeadlineExceeded) {
			_ = c.raw.Close()
		}
	})
	defer stopAtConnect()
	if err := c.write(pgSSLRequest); err != nil {
		return refuse(CodeUnreachable, err.Error())
	}
	answer, err := c.readFull(1)
	if err != nil {
		return refuse(CodeUnreachable, err.Error())
	}
	switch answer[0] {
	case 'S':
		if err := c.startTLS(target.Host); err != nil {
			return refuse(CodeUnreachable, err.Error())
		}
	case 'N':
		if !target.AllowUnencrypted {
			return refuse(CodeTLSMissing, "The server offers no TLS and the connection does not allow it unencrypted.")
		}
	default:
		return refuse(CodeEngineChanged, "The address does not answer as PostgreSQL.")
	}
	fingerprint := ""
	if c.cert != nil {
		fingerprint = c.cert.fingerprint
	}
	if target.Fingerprint != "" {
		if !c.tlsUsed {
			return refuse(CodeTLSMissing, "The server no longer offers TLS; the connection has a confirmed certificate.")
		}
		if fingerprint != target.Fingerprint {
			return refuse(CodeTLSChanged, "The server shows another TLS certificate than the one confirmed.")
		}
	}
	return &PinnedConn{c: c, TLS: c.tlsUsed, Fingerprint: fingerprint}, nil
}

// SignIn signs in as user to database (SCRAM, MD5 or none, as the probe).
func (p *PinnedConn) SignIn(user string, password *string, database string) error {
	_, err := p.c.pgSignIn(user, password, database)
	if err != nil {
		var pe *pgError
		if errors.As(err, &pe) && pe.isLogin() {
			return &PinnedError{Code: CodeLoginFailed, Message: pe.Message}
		}
		return err
	}
	return nil
}

// Query runs one statement; NULL is nil. The probe's limits apply (rows,
// values cut at 4096 bytes).
func (p *PinnedConn) Query(sql string) ([][]*string, error) {
	return p.c.pgQuery(sql)
}

// Detach hands the connection on (the relay): its context no longer closes
// it, its deadlines are cleared. Refused while bytes the client has not read
// are waiting.
func (p *PinnedConn) Detach() (net.Conn, error) {
	if p.c.r.Buffered() > 0 {
		return nil, errors.New("the connection cannot be handed on")
	}
	if p.c.stop != nil {
		p.c.stop()
		p.c.stop = nil
	}
	_ = p.c.raw.SetDeadline(time.Time{})
	return p.c.raw, nil
}

// Close ends the session (a Terminate when signed in) and the connection.
func (p *PinnedConn) Close() {
	p.c.pgTerminate()
	p.c.close()
}

// Cell is a query's value (empty for NULL or outside the rows).
func Cell(rows [][]*string, row, col int) string { return cell(rows, row, col) }
