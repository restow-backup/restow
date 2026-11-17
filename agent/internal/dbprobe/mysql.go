package dbprobe

import (
	"bytes"
	"crypto/rsa"
	"crypto/sha1" // #nosec G505 -- mysql_native_password and RSA-OAEP of MySQL require SHA-1.
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/restow-backup/restow/agent/internal/api"
)

// MySQL and MariaDB: the server speaks first with a greeting (protocol 10)
// that names its version; MariaDB names itself in it.

const (
	clientLongPassword          = 0x1
	clientLongFlag              = 0x4
	clientConnectWithDB         = 0x8
	clientProtocol41            = 0x200
	clientSSL                   = 0x800
	clientTransactions          = 0x2000
	clientSecureConnection      = 0x8000
	clientPluginAuth            = 0x80000
	clientPluginAuthLenencData  = 0x200000
	charsetUTF8MB4GeneralCI     = 45
	mysqlMaxPacket              = 16 << 20
	mysqlAuthNative             = "mysql_native_password"
	mysqlAuthCachingSHA2        = "caching_sha2_password"
	mysqlAuthClear              = "mysql_clear_password"
	mysqlFastAuthSuccess        = 0x03
	mysqlPerformFullAuth        = 0x04
	mysqlRequestPublicKey       = 0x02
	mysqlAuthMoreData           = 0x01
	mysqlAuthSwitch             = 0xfe
	mysqlOK                     = 0x00
	mysqlErr                    = 0xff
	mysqlEOFMaxLength           = 9
	mysqlGreetingMaxVersionSize = 128
)

// mysqlError is an ERR packet.
type mysqlError struct {
	Number  int
	Message string
}

func (e *mysqlError) Error() string { return e.Message }

// isLogin: access denied, host not allowed, plugin refused.
func (e *mysqlError) isLogin() bool {
	switch e.Number {
	case 1044, 1045, 1130, 1251, 1524, 1698:
		return true
	}
	return false
}

type greeting struct {
	version      string
	scramble     []byte
	capabilities uint32
	plugin       string
	mariadb      bool
}

// splitPacket reads one packet (3 bytes length, 1 byte sequence) from b.
func splitPacket(b []byte) (seq byte, payload []byte, ok bool) {
	if len(b) < 4 {
		return 0, nil, false
	}
	n := int(b[0]) | int(b[1])<<8 | int(b[2])<<16
	if len(b) < 4+n {
		return 0, nil, false
	}
	return b[3], b[4 : 4+n], true
}

var versionStart = regexp.MustCompile(`^\d+\.\d+`)

// parseGreeting reads a protocol-10 greeting; nil when it is none.
func parseGreeting(p []byte) *greeting {
	if len(p) < 1 || p[0] != 10 {
		return nil
	}
	end := bytes.IndexByte(p[1:], 0)
	if end < 0 || end > mysqlGreetingMaxVersionSize {
		return nil
	}
	version := string(p[1 : 1+end])
	if !versionStart.MatchString(version) {
		return nil
	}
	off := 1 + end + 1
	if len(p) < off+4+8+1+2 {
		return nil
	}
	off += 4 // connection id
	part1 := p[off : off+8]
	off += 8 + 1
	caps := uint32(binary.LittleEndian.Uint16(p[off : off+2]))
	off += 2
	g := &greeting{version: version, scramble: append([]byte(nil), part1...), plugin: mysqlAuthNative,
		mariadb: strings.Contains(strings.ToLower(version), "mariadb")}
	if len(p) >= off+1+2+2+1+10 {
		off += 1 + 2 // charset, status
		caps |= uint32(binary.LittleEndian.Uint16(p[off:off+2])) << 16
		off += 2
		authLen := int(p[off])
		off += 1 + 10
		if caps&clientSecureConnection != 0 {
			n := max(13, authLen-8)
			if off+n <= len(p) {
				g.scramble = append(g.scramble, p[off:off+n-1]...)
			}
			off += n
		}
		if caps&clientPluginAuth != 0 && off <= len(p) {
			rest := p[off:]
			if i := bytes.IndexByte(rest, 0); i >= 0 {
				rest = rest[:i]
			}
			g.plugin = string(rest)
		}
	}
	if len(g.scramble) > 20 {
		g.scramble = g.scramble[:20]
	}
	g.capabilities = caps
	return g
}

// mysqlShortVersion drops MariaDB's replication prefix and the build suffix.
func mysqlShortVersion(v string) string {
	v = strings.TrimPrefix(v, "5.5.5-")
	if i := strings.IndexByte(v, '-'); i >= 0 {
		return v[:i]
	}
	return v
}

func xorBytes(a, b []byte) []byte {
	out := make([]byte, len(a))
	for i := range a {
		out[i] = a[i] ^ b[i%len(b)]
	}
	return out
}

// nativePassword: SHA1(password) XOR SHA1(scramble + SHA1(SHA1(password))).
func nativePassword(password string, scramble []byte) []byte {
	if password == "" {
		return nil
	}
	s1 := sha1.Sum([]byte(password)) // #nosec G401 -- the protocol's own hash
	s2 := sha1.Sum(s1[:])            // #nosec G401
	h := sha1.New()                  // #nosec G401
	h.Write(scramble[:min(20, len(scramble))])
	h.Write(s2[:])
	return xorBytes(s1[:], h.Sum(nil))
}

// cachingSHA2Password: SHA256(password) XOR SHA256(SHA256(SHA256(password)) + scramble).
func cachingSHA2Password(password string, scramble []byte) []byte {
	if password == "" {
		return nil
	}
	s1 := sha256.Sum256([]byte(password))
	s2 := sha256.Sum256(s1[:])
	h := sha256.New()
	h.Write(s2[:])
	h.Write(scramble[:min(20, len(scramble))])
	return xorBytes(s1[:], h.Sum(nil))
}

func authResponse(plugin, password string, scramble []byte, tls bool) ([]byte, error) {
	switch plugin {
	case mysqlAuthNative:
		return nativePassword(password, scramble), nil
	case mysqlAuthCachingSHA2:
		return cachingSHA2Password(password, scramble), nil
	case "unix_socket", "auth_socket":
		// The server checks the peer of the local socket; the client sends nothing.
		return nil, nil
	case mysqlAuthClear:
		if !tls {
			return nil, &mysqlError{Number: 1251, Message: "the server asks for the password in clear text without TLS"}
		}
		return append([]byte(password), 0), nil
	}
	return nil, &mysqlError{Number: 1251, Message: "unsupported authentication plugin " + plugin}
}

type packets struct {
	c   *conn
	seq byte
}

func (p *packets) read() ([]byte, error) {
	head, err := p.c.readFull(4)
	if err != nil {
		return nil, err
	}
	n := int(head[0]) | int(head[1])<<8 | int(head[2])<<16
	if n == 0 || n > maxRead {
		return nil, fail(CodeProbeFailed, "the server sent a packet the probe does not read")
	}
	p.seq = head[3] + 1
	return p.c.readFull(n)
}

func (p *packets) write(payload []byte) error {
	head := []byte{byte(len(payload)), byte(len(payload) >> 8), byte(len(payload) >> 16), p.seq}
	p.seq++
	return p.c.write(append(head, payload...))
}

func mysqlErrorOf(p []byte) *mysqlError {
	e := &mysqlError{}
	if len(p) >= 3 {
		e.Number = int(binary.LittleEndian.Uint16(p[1:3]))
		msg := string(p[3:])
		if strings.HasPrefix(msg, "#") && len(msg) >= 6 {
			msg = msg[6:]
		}
		e.Message = msg
	}
	return e
}

func lenenc(n int) []byte {
	if n < 251 {
		return []byte{byte(n)}
	}
	return []byte{0xfc, byte(n), byte(n >> 8)}
}

func readLenenc(b []byte, off int) (value int, null bool, next int, err error) {
	if off >= len(b) {
		return 0, false, off, errors.New("short packet")
	}
	switch first := b[off]; {
	case first < 0xfb:
		return int(first), false, off + 1, nil
	case first == 0xfb:
		return 0, true, off + 1, nil
	case first == 0xfc && off+3 <= len(b):
		return int(binary.LittleEndian.Uint16(b[off+1 : off+3])), false, off + 3, nil
	case first == 0xfd && off+4 <= len(b):
		return int(b[off+1]) | int(b[off+2])<<8 | int(b[off+3])<<16, false, off + 4, nil
	case first == 0xfe && off+9 <= len(b):
		v := binary.LittleEndian.Uint64(b[off+1 : off+9])
		if v > maxRead {
			return 0, false, off, errors.New("a value larger than the packet")
		}
		return int(v), false, off + 9, nil
	}
	return 0, false, off, errors.New("short packet")
}

// readGreeting reads the greeting of a fresh connection.
func (c *conn) mysqlGreeting() (*greeting, error) {
	p := &packets{c: c}
	payload, err := p.read()
	if err != nil {
		return nil, err
	}
	if len(payload) > 0 && payload[0] == mysqlErr {
		return nil, mysqlErrorOf(payload)
	}
	g := parseGreeting(payload)
	if g == nil {
		return nil, errors.New("the server's greeting is not MySQL protocol 10")
	}
	return g, nil
}

// mysqlSignIn signs in after the greeting; startTLS is nil when no TLS is to be used.
func (c *conn) mysqlSignIn(g *greeting, user string, password *string, database string, startTLS func() error) (*packets, error) {
	p := &packets{c: c, seq: 1}
	caps := uint32(clientLongPassword | clientLongFlag | clientProtocol41 | clientTransactions |
		clientSecureConnection | clientPluginAuth | clientPluginAuthLenencData)
	if database != "" {
		caps |= clientConnectWithDB
	}
	tls := startTLS != nil
	if tls {
		caps |= clientSSL
	}
	caps &= g.capabilities | clientSSL | clientConnectWithDB
	fixed := make([]byte, 32)
	binary.LittleEndian.PutUint32(fixed[0:4], caps)
	binary.LittleEndian.PutUint32(fixed[4:8], mysqlMaxPacket)
	fixed[8] = charsetUTF8MB4GeneralCI
	if tls {
		if err := p.write(fixed); err != nil {
			return nil, err
		}
		if err := startTLS(); err != nil {
			return nil, err
		}
	}
	pw := ""
	if password != nil {
		pw = *password
	}
	plugin := g.plugin
	if plugin == "" {
		plugin = mysqlAuthNative
	}
	scramble := g.scramble
	resp, err := authResponse(plugin, pw, scramble, tls)
	if err != nil {
		return nil, err
	}
	var hs bytes.Buffer
	hs.Write(fixed)
	hs.Write(cstr(user))
	hs.Write(lenenc(len(resp)))
	hs.Write(resp)
	if database != "" {
		hs.Write(cstr(database))
	}
	hs.Write(cstr(plugin))
	if err := p.write(hs.Bytes()); err != nil {
		return nil, err
	}
	for round := 0; round < 6; round++ {
		payload, err := p.read()
		if err != nil {
			return nil, err
		}
		if len(payload) == 0 {
			return nil, errors.New("empty packet during the sign-in")
		}
		switch payload[0] {
		case mysqlOK:
			return p, nil
		case mysqlErr:
			return nil, mysqlErrorOf(payload)
		case mysqlAuthSwitch:
			rest := payload[1:]
			end := bytes.IndexByte(rest, 0)
			if end < 0 {
				end = len(rest)
			}
			plugin = string(rest[:end])
			data := []byte{}
			if end < len(rest) {
				data = rest[end+1:]
			}
			if len(data) > 20 {
				data = data[:20]
			}
			scramble = data
			resp, err := authResponse(plugin, pw, scramble, tls)
			if err != nil {
				return nil, err
			}
			if err := p.write(resp); err != nil {
				return nil, err
			}
		case mysqlAuthMoreData:
			if plugin != mysqlAuthCachingSHA2 || len(payload) < 2 {
				return nil, errors.New("unexpected data during the sign-in")
			}
			switch payload[1] {
			case mysqlFastAuthSuccess:
				continue
			case mysqlPerformFullAuth:
				if tls {
					if err := p.write(append([]byte(pw), 0)); err != nil {
						return nil, err
					}
					continue
				}
				if err := p.write([]byte{mysqlRequestPublicKey}); err != nil {
					return nil, err
				}
				key, err := p.read()
				if err != nil {
					return nil, err
				}
				if len(key) > 0 && key[0] == mysqlErr {
					return nil, mysqlErrorOf(key)
				}
				enc, err := encryptPassword(key[1:], pw, scramble)
				if err != nil {
					return nil, err
				}
				if err := p.write(enc); err != nil {
					return nil, err
				}
			default:
				return nil, errors.New("unexpected data during the sign-in")
			}
		default:
			return nil, fmt.Errorf("unexpected answer during the sign-in (0x%02x)", payload[0])
		}
	}
	return nil, errors.New("the sign-in did not finish")
}

// encryptPassword: RSA-OAEP (SHA-1) of (password + NUL) XOR scramble with the server's key.
func encryptPassword(pemBytes []byte, password string, scramble []byte) ([]byte, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("the server's public key is not PEM")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(*rsa.PublicKey)
	if !ok {
		return nil, errors.New("the server's public key is not RSA")
	}
	plain := xorBytes(append([]byte(password), 0), scramble)
	return rsa.EncryptOAEP(sha1.New(), randReader, key, plain, nil) // #nosec G401
}

// mysqlQuery runs one text query; NULL is nil.
func (p *packets) query(sql string) ([][]*string, error) {
	p.seq = 0
	if err := p.write(append([]byte{0x03}, sql...)); err != nil {
		return nil, err
	}
	first, err := p.read()
	if err != nil {
		return nil, err
	}
	if len(first) == 0 {
		return nil, errors.New("empty answer")
	}
	switch first[0] {
	case mysqlErr:
		return nil, mysqlErrorOf(first)
	case mysqlOK:
		return nil, nil
	}
	columns, _, _, err := readLenenc(first, 0)
	if err != nil {
		return nil, err
	}
	if columns < 1 || columns > mysqlMaxColumns {
		return nil, errors.New("more columns than the probe asked for")
	}
	for i := 0; i < columns+1; i++ { // column definitions, then EOF
		if _, err := p.read(); err != nil {
			return nil, err
		}
	}
	var rows [][]*string
	// The probe's queries return at most maxDatabases rows; a server that
	// sends more is cut off.
	for count := 0; count <= maxDatabases+1; count++ {
		payload, err := p.read()
		if err != nil {
			return nil, err
		}
		if len(payload) > 0 && payload[0] == 0xfe && len(payload) < mysqlEOFMaxLength {
			return rows, nil
		}
		if len(payload) > 0 && payload[0] == mysqlErr {
			return nil, mysqlErrorOf(payload)
		}
		row := make([]*string, 0, columns)
		off := 0
		for col := 0; col < columns; col++ {
			n, null, next, err := readLenenc(payload, off)
			if err != nil {
				return nil, err
			}
			if null {
				row = append(row, nil)
				off = next
				continue
			}
			if next+n > len(payload) {
				return nil, errors.New("short row")
			}
			// Only the beginning of a long value is kept, while the row is read.
			v := string(payload[next : next+min(n, maxValueBytes)])
			row = append(row, &v)
			off = next + n
		}
		if len(rows) <= maxDatabases {
			rows = append(rows, row)
		}
	}
	return nil, errors.New("the query did not finish")
}

// mysqlMaxColumns bounds the columns of a result.
const mysqlMaxColumns = 64

func (p *packets) quit() {
	p.seq = 0
	_ = p.write([]byte{0x01})
}

func (p *packets) optional(sql string) *string {
	rows, err := p.query(sql)
	if err != nil {
		return nil
	}
	if len(rows) > 0 && len(rows[0]) > 0 {
		return rows[0][0]
	}
	return nil
}

// mysqlFacts reads the facts of the rights matrix and the identity, read-only.
func (p *packets) mysqlFacts() (*api.DBMysqlFacts, error) {
	head, err := p.query("SELECT VERSION(), @@version_comment, CURRENT_USER(), @@server_id, @@datadir")
	if err != nil {
		return nil, err
	}
	f := &api.DBMysqlFacts{
		Version:     clip(cell(head, 0, 0), 256),
		CurrentUser: clip(cell(head, 0, 2), 300),
		Grants:      []string{},
		Databases:   []api.DBMysqlDatabase{},
	}
	if v := cell(head, 0, 1); v != "" {
		v = clip(v, 256)
		f.VersionComment = &v
	}
	if id, err := strconv.ParseInt(cell(head, 0, 3), 10, 64); err == nil && id >= 0 {
		f.ServerID = &id
	}
	if d := cell(head, 0, 4); d != "" {
		d = clip(d, 1024)
		f.Datadir = &d
	}
	if u := p.optional("SELECT @@server_uuid"); u != nil && len(*u) <= 64 {
		f.ServerUUID = u
	}
	if b := p.optional("SELECT @@log_bin"); b != nil {
		on := *b == "1" || strings.EqualFold(*b, "ON")
		f.LogBin = &on
	}
	if b := p.optional("SELECT @@binlog_format"); b != nil {
		v := clip(*b, 32)
		f.BinlogFormat = &v
	}
	grants, err := p.query("SHOW GRANTS")
	if err != nil {
		return nil, err
	}
	for i := range grants {
		if g := redactIdentifiedBy(cell(grants, i, 0)); g != "" && len(f.Grants) < 200 {
			f.Grants = append(f.Grants, clip(g, 4096))
		}
	}
	schemas, err := p.query(fmt.Sprintf("SELECT s.SCHEMA_NAME, (SELECT SUM(t.DATA_LENGTH + t.INDEX_LENGTH) FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = s.SCHEMA_NAME) FROM information_schema.SCHEMATA s ORDER BY s.SCHEMA_NAME LIMIT %d", maxDatabases))
	if err != nil {
		return nil, err
	}
	for i := range schemas {
		d := api.DBMysqlDatabase{Name: clip(cell(schemas, i, 0), 128)}
		if n, err := strconv.ParseInt(cell(schemas, i, 1), 10, 64); err == nil {
			d.SizeBytes = &n
		}
		f.Databases = append(f.Databases, d)
	}
	return f, nil
}
