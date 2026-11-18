package dbprobe

import (
	"context"
	"errors"
	"net"
	"time"
)

// A pinned MySQL or MariaDB connection of a backup or restore run
// (docs/DATABASES.md 16 "D4" M1): the same connect as OpenPinned, then the
// greeting. TLS waits: the server keeps the capabilities of the SSLRequest
// for the whole session, so the relay sends it with those of the program's
// login (StartTLS); the agent's own statements sign in with SignIn. Either
// way the confirmed certificate is compared before the login is sent.

// PinnedMysql is a MySQL or MariaDB connection after the greeting.
type PinnedMysql struct {
	c      *conn
	g      *greeting
	target PinnedTarget
	// TLSOffered: the server offers TLS (it is then always used).
	TLSOffered bool
	// RemoteAddress is the IP address reached.
	RemoteAddress string
	// Fingerprint is the certificate the server showed (after TLS).
	Fingerprint string
}

// OpenPinnedMysql connects to a server of engine ("mysql" or "mariadb").
func OpenPinnedMysql(ctx context.Context, target PinnedTarget, engine string, timeout time.Duration, dial func(ctx context.Context, network, address string) (net.Conn, error)) (*PinnedMysql, error) {
	c, reached, err := connectPinned(ctx, target, timeout, dial)
	if err != nil {
		return nil, err
	}
	refuse := func(code, message string) (*PinnedMysql, error) {
		c.close()
		return nil, &PinnedError{Code: code, Message: message}
	}
	g, err := c.mysqlGreeting()
	if err != nil {
		var me *mysqlError
		if errors.As(err, &me) {
			return refuse(CodeUnreachable, me.Message)
		}
		return refuse(CodeEngineChanged, "The address does not answer as MySQL.")
	}
	if g.mariadb != (engine == EngineMariaDB) {
		name := "MySQL"
		if g.mariadb {
			name = "MariaDB"
		}
		return refuse(CodeEngineChanged, "The address answers as "+name+" now.")
	}
	offered := g.capabilities&clientSSL != 0
	if !offered {
		if !target.AllowUnencrypted {
			return refuse(CodeTLSMissing, "The server offers no TLS and the connection does not allow it unencrypted.")
		}
		if target.Fingerprint != "" {
			return refuse(CodeTLSMissing, "The server no longer offers TLS; the connection has a confirmed certificate.")
		}
	}
	return &PinnedMysql{c: c, g: g, target: target, TLSOffered: offered, RemoteAddress: reached}, nil
}

// Greeting is the server's greeting as it sent it.
func (p *PinnedMysql) Greeting() []byte { return p.g.raw }

// Plugin is the greeting's sign-in method.
func (p *PinnedMysql) Plugin() string { return p.g.plugin }

// Version is the server's version text.
func (p *PinnedMysql) Version() string { return p.g.version }

func (p *PinnedMysql) pin() error {
	fp := ""
	if p.c.cert != nil {
		fp = p.c.cert.fingerprint
	}
	p.Fingerprint = fp
	if p.target.Fingerprint != "" && fp != p.target.Fingerprint {
		return &PinnedError{Code: CodeTLSChanged, Message: "The server shows another TLS certificate than the one confirmed."}
	}
	return nil
}

// StartTLS sends sslRequest (a whole packet, sequence 1) and negotiates TLS,
// then compares the certificate.
func (p *PinnedMysql) StartTLS(sslRequest []byte) error {
	if err := p.c.write(sslRequest); err != nil {
		return &PinnedError{Code: CodeUnreachable, Message: err.Error()}
	}
	if err := p.c.startTLS(p.target.Host); err != nil {
		return &PinnedError{Code: CodeUnreachable, Message: err.Error()}
	}
	return p.pin()
}

// Detach hands the connection on (the relay).
func (p *PinnedMysql) Detach() (net.Conn, error) {
	pc := &PinnedConn{c: p.c}
	return pc.Detach()
}

// Close ends the connection.
func (p *PinnedMysql) Close() { p.c.close() }

// MysqlSession is the agent's own signed-in session.
type MysqlSession struct {
	p *packets
	c *conn
}

// SignIn signs in as user with Restow's client (no database: the server
// keeps the SSLRequest's capabilities).
func (p *PinnedMysql) SignIn(user string, password *string) (*MysqlSession, error) {
	var startTLS func() error
	if p.TLSOffered {
		startTLS = func() error {
			if err := p.c.startTLS(p.target.Host); err != nil {
				return err
			}
			return p.pin()
		}
	}
	pk, err := p.c.mysqlSignIn(p.g, user, password, "", startTLS)
	if err != nil {
		var pe *PinnedError
		if errors.As(err, &pe) {
			return nil, pe
		}
		var me *mysqlError
		if errors.As(err, &me) && me.isLogin() {
			return nil, &PinnedError{Code: CodeLoginFailed, Message: me.Message}
		}
		return nil, err
	}
	return &MysqlSession{p: pk, c: p.c}, nil
}

// Query runs one statement: values up to 1 MiB, up to 100000 rows.
func (s *MysqlSession) Query(sql string) ([][]*string, error) {
	rows, _, err := s.p.queryRows(sql, 1<<20, 100000)
	return rows, err
}

// Close ends the session.
func (s *MysqlSession) Close() {
	s.p.quit()
	s.c.close()
}

// MysqlPacket is one packet with its sequence number.
func MysqlPacket(seq byte, payload []byte) []byte {
	out := make([]byte, 4+len(payload))
	n := len(payload)
	out[0], out[1], out[2], out[3] = byte(n), byte(n>>8), byte(n>>16), seq
	copy(out[4:], payload)
	return out
}
