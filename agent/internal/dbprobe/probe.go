package dbprobe

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

// Engines, sign-ins and codes of the contract (@restow/core databases/model.ts).
const (
	EnginePostgreSQL = "postgresql"
	EngineMySQL      = "mysql"
	EngineMariaDB    = "mariadb"
	EngineSQLServer  = "sqlserver"
	EngineSQLite     = "sqlite"

	AuthPassword = "password"
	AuthSocket   = "socket"

	LoginOK      = "ok"
	LoginFailed  = "failed"
	LoginSkipped = "skipped"

	CodeUnreachable       = "db_unreachable"
	CodeLoginFailed       = "db_login_failed"
	CodeEngineChanged     = "db_engine_changed"
	CodeTLSMissing        = "db_tls_missing"
	CodeNotADatabase      = "db_not_a_database"
	CodeEngineUnsupported = "db_engine_unsupported"
	CodeAuthUnsupported   = "db_auth_unsupported"
	CodeProbeFailed       = "db_probe_failed"
	CodeTLSChanged        = "db_tls_changed"
)

// maxDatabases bounds the databases read from one instance.
const maxDatabases = 1000

// randReader is the source of the RSA padding (a variable for tests).
var randReader = rand.Reader

var defaultPorts = map[string]int{EnginePostgreSQL: 5432, EngineMySQL: 3306, EngineMariaDB: 3306, EngineSQLServer: 1433}

// detectionPorts is the order of the ports without a port (3.1).
var detectionPorts = []int{5432, 3306, 1433}

// Options tune a probe; the zero value is right for production.
type Options struct {
	// Step is how long one step may wait (default 5 s).
	Step time.Duration
	// GreetingWait is how long to wait for the MySQL greeting before asking
	// PostgreSQL (default 400 ms).
	GreetingWait time.Duration
	// Dial opens network connections (tests).
	Dial func(ctx context.Context, network, address string) (net.Conn, error)
	// Peer runs the PostgreSQL socket sign-in as another system user (the
	// `peer` method signs in the OS user of the process). The agent sets it
	// to a run of its own binary as that user; nil: not available.
	Peer func(ctx context.Context, osUser string, spec api.DBProbeSpec) (*api.DBProbeResult, error)
	// Sockets are the places of the local sockets (tests).
	PostgresSocketDirs []string
	MySQLSockets       []string
}

func (o Options) step() time.Duration {
	if o.Step > 0 {
		return o.Step
	}
	return 5 * time.Second
}

func (o Options) greetingWait() time.Duration {
	if o.GreetingWait > 0 {
		return o.GreetingWait
	}
	return 400 * time.Millisecond
}

func (o Options) dial() dialer {
	if o.Dial != nil {
		return o.Dial
	}
	return defaultDial
}

// The places of the local sockets the sign-in over the socket uses: only
// directories that belong to the database's packages, never a directory every
// user may write to (such as /tmp), where another user could put a socket of
// their own.
var defaultPostgresSocketDirs = []string{"/var/run/postgresql", "/run/postgresql"}
var defaultMySQLSockets = []string{"/run/mysqld/mysqld.sock", "/var/run/mysqld/mysqld.sock", "/var/lib/mysql/mysql.sock"}

type failure struct {
	code string
	msg  string
}

func (f *failure) Error() string { return f.msg }

func fail(code, format string, args ...any) *failure {
	return &failure{code: code, msg: fmt.Sprintf(format, args...)}
}

func str(s string) *string { return &s }

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// classify turns an error into the failure it is.
func classify(err error) *failure {
	var f *failure
	var pe *pgError
	var me *mysqlError
	var ne net.Error
	switch {
	case errors.As(err, &f):
		return f
	case errors.Is(err, errProbeTimeout):
		return fail(CodeUnreachable, "%s", err.Error())
	case errors.Is(err, errTooLarge):
		return fail(CodeProbeFailed, "%s", err.Error())
	case errors.As(err, &pe) && pe.isLogin(), errors.As(err, &me) && me.isLogin():
		return fail(CodeLoginFailed, "%s", err.Error())
	case errors.As(err, &pe), errors.As(err, &me):
		return fail(CodeProbeFailed, "%s", err.Error())
	case errors.Is(err, errClosed), errors.As(err, &ne):
		return fail(CodeUnreachable, "%s", err.Error())
	}
	var oe *net.OpError
	if errors.As(err, &oe) {
		return fail(CodeUnreachable, "%s", err.Error())
	}
	return fail(CodeProbeFailed, "%s", err.Error())
}

// engineMatches: the spec's engine is a hint; a mysql URL may reach MariaDB.
func engineMatches(hint *string, engine string) bool {
	return hint == nil || *hint == engine || (*hint == EngineMySQL && engine == EngineMariaDB)
}

// plaintextAllowed: without TLS only when the connection allows it. The agent
// is in the customer's own network; the rule of the Restow server about
// public addresses (4.2) does not apply to it.
func plaintextAllowed(spec api.DBProbeSpec) bool { return spec.AllowUnencrypted }

type detected struct {
	engine     string
	port       int
	c          *conn
	tlsOffered bool
	greeting   *greeting
	version    string
	encryption string
}

func addressOf(host string, port int) string { return net.JoinHostPort(host, strconv.Itoa(port)) }

func detectOn(ctx context.Context, o Options, spec api.DBProbeSpec, host string, port int) (*detected, error) {
	dial := o.dial()
	open := func() (*conn, error) { return openConn(ctx, dial, "tcp", addressOf(host, port), o.step()) }
	hint := deref(spec.Engine)
	tdsFirst := hint == EngineSQLServer || (hint == "" && port == 1433)
	if !tdsFirst {
		c, err := open()
		if err != nil {
			return nil, err
		}
		wait := o.greetingWait()
		switch hint {
		case EngineMySQL, EngineMariaDB:
			wait = o.step()
		case EnginePostgreSQL:
			wait = 0
		}
		var early []byte
		if wait > 0 {
			early = c.peek(wait)
		}
		if len(early) == 0 {
			if err := c.write(pgSSLRequest); err != nil {
				c.close()
				return nil, err
			}
			early = c.peek(o.step())
			if len(early) == 1 && (early[0] == 'S' || early[0] == 'N') {
				_, _ = c.readFull(1)
				return &detected{engine: EnginePostgreSQL, port: port, c: c, tlsOffered: early[0] == 'S'}, nil
			}
		}
		if _, payload, ok := splitPacket(early); ok && len(payload) > 0 && (parseGreeting(payload) != nil || payload[0] == mysqlErr) {
			c.close()
			fresh, err := open()
			if err != nil {
				return nil, err
			}
			g, err := fresh.mysqlGreeting()
			if err != nil {
				fresh.close()
				return nil, err
			}
			engine := EngineMySQL
			if g.mariadb {
				engine = EngineMariaDB
			}
			return &detected{engine: engine, port: port, c: fresh, greeting: g}, nil
		}
		c.close()
		if hint == EnginePostgreSQL || hint == EngineMySQL || hint == EngineMariaDB {
			return nil, nil
		}
	}
	c, err := open()
	if err != nil {
		return nil, err
	}
	defer c.close()
	if err := c.write(tdsPreloginPacket()); err != nil {
		return nil, nil
	}
	head, err := c.readFull(8)
	if err != nil || head[0] != tdsTabularResult {
		return nil, nil
	}
	n := int(head[2])<<8 | int(head[3])
	if n < 9 || n > 4096 {
		return nil, nil
	}
	body, err := c.readFull(n - 8)
	if err != nil {
		return nil, nil
	}
	version, encryption, ok := parseTDSPrelogin(append(head, body...))
	if !ok {
		return nil, nil
	}
	return &detected{engine: EngineSQLServer, port: port, version: version, encryption: encryption}, nil
}

func emptyTLS(offered *bool) api.DBTLSFacts { return api.DBTLSFacts{Offered: offered} }

func boolp(b bool) *bool { return &b }

func tlsFacts(c *conn) api.DBTLSFacts {
	t := api.DBTLSFacts{Offered: boolp(true), Used: c.tlsUsed}
	if c.cert != nil {
		t.FingerprintSHA256 = str(c.cert.fingerprint)
		t.Subject = str(clip(c.cert.subject, 512))
		t.Issuer = str(clip(c.cert.issuer, 512))
		t.NotAfter = str(c.cert.notAfter.UTC().Format(time.RFC3339))
	}
	return t
}

func fingerprintOf(c *conn) string {
	if c.cert == nil {
		return ""
	}
	return c.cert.fingerprint
}

// assertPinned stops before the sign-in when the connection has a confirmed
// certificate and the server shows another one, or no TLS (3.2).
func assertPinned(c *conn, spec api.DBProbeSpec) error {
	pin := deref(spec.PinnedFingerprintSHA256)
	if pin == "" {
		return nil
	}
	if !c.tlsUsed {
		return fail(CodeTLSMissing, "the server no longer offers TLS; the connection has a confirmed certificate")
	}
	if c.cert == nil || c.cert.fingerprint != pin {
		return fail(CodeTLSChanged, "the server shows another TLS certificate than the one confirmed")
	}
	return nil
}

func serverName(host string) string {
	if net.ParseIP(host) != nil {
		return ""
	}
	return host
}

// probeTimeout is the deadline of one probe (the spec's, 30 s by default).
func probeTimeout(spec api.DBProbeSpec) time.Duration {
	timeout := time.Duration(spec.TimeoutSeconds) * time.Second
	if timeout <= 0 || timeout > 2*time.Minute {
		timeout = 30 * time.Second
	}
	return timeout
}

// Run tests one connection. It never fails: every problem is part of the
// result, with a message cleaned of the credentials.
func Run(ctx context.Context, spec api.DBProbeSpec, o Options) api.DBProbeResult {
	started := time.Now()
	// One deadline and one read budget for the whole probe; its end closes
	// every connection it opened.
	ctx, cancel := context.WithTimeout(withReadBudget(ctx, readBudgetBytes), probeTimeout(spec))
	defer cancel()
	res := api.DBProbeResult{TLS: emptyTLS(nil), Login: LoginSkipped}
	err := run(ctx, spec, o, &res)
	if err != nil {
		f := classify(err)
		res.Error = &api.DBProbeError{Code: f.code, Message: Sanitize(f.msg, deref(spec.User), deref(spec.Password))}
		if f.code == CodeLoginFailed {
			res.Login = LoginFailed
		}
	}
	res.DurationMs = time.Since(started).Milliseconds()
	return res
}

func run(ctx context.Context, spec api.DBProbeSpec, o Options, res *api.DBProbeResult) error {
	if deref(spec.Engine) == EngineSQLite || spec.Path != nil {
		res.Engine = str(EngineSQLite)
		facts, err := probeSQLite(deref(spec.Path))
		if err != nil {
			if errors.Is(err, errNotSQLite) || errors.Is(err, errNotRegular) {
				res.Engine = nil
				return fail(CodeNotADatabase, "%s", err.Error())
			}
			if os.IsNotExist(err) || os.IsPermission(err) {
				return fail(CodeUnreachable, "%s", err.Error())
			}
			return err
		}
		res.SQLite = facts
		return nil
	}
	if spec.AuthMethod == AuthSocket {
		return runSocket(ctx, spec, o, res)
	}
	host := deref(spec.Host)
	if host == "" {
		return fail(CodeProbeFailed, "the connection has no address")
	}
	ports := detectionPorts
	switch {
	case spec.Port != nil:
		ports = []int{*spec.Port}
	case spec.Engine != nil && defaultPorts[*spec.Engine] != 0:
		ports = []int{defaultPorts[*spec.Engine]}
	}
	var d *detected
	var last error
	for _, port := range ports {
		got, err := detectOn(ctx, o, spec, host, port)
		if err != nil {
			last = err
			continue
		}
		if got != nil {
			d = got
			break
		}
		last = fail(CodeNotADatabase, "port %d answers, but not as PostgreSQL, MySQL, MariaDB or SQL Server", port)
	}
	if d == nil {
		if last == nil {
			last = fail(CodeUnreachable, "nothing answered")
		}
		return last
	}
	res.Engine = str(d.engine)
	res.Port = &d.port
	if !engineMatches(spec.Engine, d.engine) {
		if d.c != nil {
			d.c.close()
		}
		return fail(CodeEngineChanged, "under the address answers %s, not %s", d.engine, deref(spec.Engine))
	}
	switch d.engine {
	case EngineSQLServer:
		if d.version != "" {
			res.ServerVersion = str(d.version)
		}
		res.TLS = emptyTLS(boolp(d.encryption == "on" || d.encryption == "required"))
		res.SQLServer = &api.DBSQLServerFacts{}
		if d.version != "" {
			res.SQLServer.Version = str(d.version)
		}
		if d.encryption != "" {
			res.SQLServer.Encryption = str(d.encryption)
		}
		// The sign-in to SQL Server stays with the native backup on its machine
		// until it moves into the module (D5): no error, the server explains it.
		return nil
	case EnginePostgreSQL:
		defer d.c.close()
		return postgresSession(d.c, d.tlsOffered, host, spec, res, func() (*conn, byte, error) {
			c, err := openConn(ctx, o.dial(), "tcp", addressOf(host, d.port), o.step())
			if err != nil {
				return nil, 0, err
			}
			if err := c.write(pgSSLRequest); err != nil {
				c.close()
				return nil, 0, err
			}
			answer, err := c.readFull(1)
			if err != nil {
				c.close()
				return nil, 0, err
			}
			return c, answer[0], nil
		})
	default:
		defer d.c.close()
		return mysqlSession(d.c, d.greeting, host, spec, res)
	}
}

// reopenChecked opens a further connection to the same PostgreSQL with the
// same checks as the first one: the same answer to the SSLRequest, TLS when it
// was used, the confirmed certificate.
func reopenChecked(reopen func() (*conn, byte, error), first *conn, tlsOffered bool, host string, spec api.DBProbeSpec) (*conn, error) {
	next, answer, err := reopen()
	if err != nil {
		return nil, err
	}
	check := func() error {
		switch {
		case answer != 'S' && answer != 'N':
			return fail(CodeProbeFailed, "the server's answer to the SSLRequest changed")
		case tlsOffered && answer != 'S':
			return fail(CodeTLSMissing, "the server stopped offering TLS")
		case tlsOffered:
			if err := next.startTLS(serverName(host)); err != nil {
				return err
			}
		case answer == 'S':
			return fail(CodeProbeFailed, "the server's answer to the SSLRequest changed")
		case !plaintextAllowed(spec):
			return fail(CodeTLSMissing, "the server offers no TLS; connect without TLS only when the connection allows it")
		}
		if err := assertPinned(next, spec); err != nil {
			return err
		}
		// Without a confirmed certificate: the same certificate as on the first connection.
		if tlsOffered && fingerprintOf(next) != fingerprintOf(first) {
			return fail(CodeTLSChanged, "the server showed another TLS certificate on its second connection")
		}
		return nil
	}
	if err := check(); err != nil {
		next.close()
		return nil, err
	}
	return next, nil
}

// postgresSession signs in on a detected connection and reads the facts. A
// database that does not exist is retried with template1 on a fresh connection.
func postgresSession(c *conn, tlsOffered bool, host string, spec api.DBProbeSpec, res *api.DBProbeResult, reopen func() (*conn, byte, error)) error {
	res.TLS = emptyTLS(boolp(tlsOffered))
	if tlsOffered {
		if err := c.startTLS(serverName(host)); err != nil {
			return err
		}
		res.TLS = tlsFacts(c)
	} else if !plaintextAllowed(spec) {
		return fail(CodeTLSMissing, "the server offers no TLS; connect without TLS only when the connection allows it")
	}
	if err := assertPinned(c, spec); err != nil {
		return err
	}
	user := deref(spec.User)
	if user == "" {
		return fail(CodeLoginFailed, "no user was given")
	}
	databases := []string{"postgres", "template1"}
	if spec.Database != nil && *spec.Database != "" {
		databases[0] = *spec.Database
	}
	current := c
	for i, database := range databases {
		if i > 0 {
			next, err := reopenChecked(reopen, c, tlsOffered, host, spec)
			if err != nil {
				return err
			}
			defer next.close()
			current = next
		}
		params, err := current.pgSignIn(user, spec.Password, database)
		if err != nil {
			var pe *pgError
			if errors.As(err, &pe) && pe.SQLState == "3D000" {
				continue
			}
			return err
		}
		res.Login = LoginOK
		facts, err := current.pgFacts()
		if err != nil {
			return err
		}
		res.PostgreSQL = facts
		v := pgShortVersion(facts.Version)
		if v == "" {
			v = params["server_version"]
		}
		if v != "" {
			res.ServerVersion = str(v)
		}
		current.pgTerminate()
		return nil
	}
	return fail(CodeLoginFailed, "neither the named database nor template1 exists")
}

func mysqlSession(c *conn, g *greeting, host string, spec api.DBProbeSpec, res *api.DBProbeResult) error {
	res.ServerVersion = str(mysqlShortVersion(g.version))
	offered := g.capabilities&clientSSL != 0
	res.TLS = emptyTLS(boolp(offered))
	if !offered && !plaintextAllowed(spec) {
		return fail(CodeTLSMissing, "the server offers no TLS; connect without TLS only when the connection allows it")
	}
	if !offered {
		if err := assertPinned(c, spec); err != nil {
			return err
		}
	}
	user := deref(spec.User)
	if user == "" {
		return fail(CodeLoginFailed, "no user was given")
	}
	var startTLS func() error
	if offered {
		startTLS = func() error {
			if err := c.startTLS(serverName(host)); err != nil {
				return err
			}
			res.TLS = tlsFacts(c)
			// Before the sign-in packet: a server with another certificate learns nothing.
			return assertPinned(c, spec)
		}
	}
	p, err := c.mysqlSignIn(g, user, spec.Password, deref(spec.Database), startTLS)
	if c.tlsUsed {
		res.TLS = tlsFacts(c)
	}
	if err != nil {
		return err
	}
	res.Login = LoginOK
	facts, err := p.mysqlFacts()
	if err != nil {
		return err
	}
	res.MySQL = facts
	p.quit()
	return nil
}

// runSocket signs in over the local socket (docs/DATABASES.md 3.2): MariaDB
// and MySQL as root (unix_socket, auth_socket), PostgreSQL as `postgres`
// through `peer`, which needs the process to run as that user.
func runSocket(ctx context.Context, spec api.DBProbeSpec, o Options, res *api.DBProbeResult) error {
	engine := deref(spec.Engine)
	port := 0
	if spec.Port != nil {
		port = *spec.Port
	}
	if engine == EnginePostgreSQL || (engine == "" && (port == 0 || port == 5432)) {
		if port == 0 {
			port = 5432
		}
		if o.Peer == nil {
			return fail(CodeAuthUnsupported, "the sign-in over the PostgreSQL socket is not available on this system")
		}
		got, err := o.Peer(ctx, "postgres", spec)
		if err != nil {
			return fail(CodeAuthUnsupported, "the sign-in as postgres failed: %s", err.Error())
		}
		*res = *got
		return nil
	}
	sockets := o.MySQLSockets
	if len(sockets) == 0 {
		sockets = defaultMySQLSockets
	}
	for _, path := range sockets {
		if _, err := os.Stat(path); err != nil {
			continue
		}
		c, err := openConn(ctx, o.dial(), "unix", path, o.step())
		if err != nil {
			continue
		}
		defer c.close()
		g, err := c.mysqlGreeting()
		if err != nil {
			return err
		}
		res.Engine = str(EngineMySQL)
		if g.mariadb {
			res.Engine = str(EngineMariaDB)
		}
		if spec.Port != nil {
			res.Port = spec.Port
		}
		res.ServerVersion = str(mysqlShortVersion(g.version))
		// A local socket never leaves the machine: no TLS needed (and none offered).
		res.TLS = emptyTLS(boolp(false))
		p, err := c.mysqlSignIn(g, "root", nil, "", nil)
		if err != nil {
			return err
		}
		res.Login = LoginOK
		facts, err := p.mysqlFacts()
		if err != nil {
			return err
		}
		res.MySQL = facts
		p.quit()
		return nil
	}
	return fail(CodeUnreachable, "no MySQL or MariaDB socket on this machine")
}

// RunPostgresPeer is the PostgreSQL socket sign-in itself, run by a process of
// the database's system user (restow-agent db-probe-peer): it connects to the
// socket of the spec's port and signs in as that user without a password.
func RunPostgresPeer(ctx context.Context, spec api.DBProbeSpec, o Options, osUser string) api.DBProbeResult {
	started := time.Now()
	ctx, cancel := context.WithTimeout(withReadBudget(ctx, readBudgetBytes), probeTimeout(spec))
	defer cancel()
	res := api.DBProbeResult{TLS: emptyTLS(boolp(false)), Login: LoginSkipped, Engine: str(EnginePostgreSQL)}
	port := 5432
	if spec.Port != nil {
		port = *spec.Port
	}
	res.Port = &port
	dirs := o.PostgresSocketDirs
	if len(dirs) == 0 {
		dirs = defaultPostgresSocketDirs
	}
	var err error = fail(CodeUnreachable, "no PostgreSQL socket for port %d on this machine", port)
	for _, dir := range dirs {
		path := dir + "/.s.PGSQL." + strconv.Itoa(port)
		if _, serr := os.Stat(path); serr != nil {
			continue
		}
		c, cerr := openConn(ctx, o.dial(), "unix", path, o.step())
		if cerr != nil {
			continue
		}
		spec.User = str(osUser)
		spec.Password = nil
		err = func() error {
			defer c.close()
			return postgresSession(c, false, "", api.DBProbeSpec{User: spec.User, Database: spec.Database, AllowUnencrypted: true}, &res, func() (*conn, byte, error) {
				// A socket has no SSLRequest: the connection is as the first one.
				next, err := openConn(ctx, o.dial(), "unix", path, o.step())
				return next, 'N', err
			})
		}()
		break
	}
	if err != nil {
		f := classify(err)
		res.Error = &api.DBProbeError{Code: f.code, Message: Sanitize(f.msg, "", "")}
		if f.code == CodeLoginFailed {
			res.Login = LoginFailed
		}
	}
	res.TLS = emptyTLS(boolp(false))
	res.DurationMs = time.Since(started).Milliseconds()
	return res
}
