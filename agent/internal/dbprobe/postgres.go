package dbprobe

import (
	"bytes"
	"crypto/hmac"
	"crypto/md5" // #nosec G501 -- PostgreSQL's md5 authentication method requires it.
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/restow-backup/restow/agent/internal/api"
)

// pgSSLRequest asks a PostgreSQL server for TLS; it answers one byte, S or N.
var pgSSLRequest = []byte{0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f}

// pgError is an ErrorResponse of the server.
type pgError struct {
	SQLState string
	Message  string
}

func (e *pgError) Error() string { return e.Message }

// isLogin: wrong password, pg_hba.conf, no permission to connect.
func (e *pgError) isLogin() bool {
	return e.SQLState == "28P01" || e.SQLState == "28000" || e.SQLState == "42501"
}

func pgMessage(typ byte, body []byte) []byte {
	out := make([]byte, 5+len(body))
	out[0] = typ
	binary.BigEndian.PutUint32(out[1:5], uint32(len(body)+4))
	copy(out[5:], body)
	return out
}

func cstr(s string) []byte { return append([]byte(s), 0) }

func (c *conn) pgRead() (byte, []byte, error) {
	head, err := c.readFull(5)
	if err != nil {
		return 0, nil, err
	}
	n := int(binary.BigEndian.Uint32(head[1:5]))
	if n < 4 || n > 64<<20 {
		return 0, nil, errors.New("invalid message length from the server")
	}
	body, err := c.readFull(n - 4)
	return head[0], body, err
}

func pgErrorOf(body []byte) *pgError {
	e := &pgError{SQLState: "XX000", Message: "server error"}
	for len(body) > 1 {
		code := body[0]
		end := bytes.IndexByte(body[1:], 0)
		if end < 0 {
			break
		}
		value := string(body[1 : 1+end])
		switch code {
		case 'C':
			e.SQLState = value
		case 'M':
			e.Message = value
		}
		body = body[2+end:]
	}
	return e
}

func pgStartup(user, database string) []byte {
	var body bytes.Buffer
	body.Write([]byte{0x00, 0x03, 0x00, 0x00})
	for _, kv := range [][2]string{{"user", user}, {"database", database}, {"application_name", "restow"}} {
		body.Write(cstr(kv[0]))
		body.Write(cstr(kv[1]))
	}
	body.WriteByte(0)
	out := make([]byte, 4+body.Len())
	binary.BigEndian.PutUint32(out[:4], uint32(4+body.Len()))
	copy(out[4:], body.Bytes())
	return out
}

// pgMD5 is "md5" + md5(md5(password + user) + salt).
func pgMD5(user, password string, salt []byte) string {
	inner := md5.Sum([]byte(password + user)) // #nosec G401 -- the protocol's own hash
	h := md5.New()                            // #nosec G401
	h.Write([]byte(hex.EncodeToString(inner[:])))
	h.Write(salt)
	return "md5" + hex.EncodeToString(h.Sum(nil))
}

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

// scram is SCRAM-SHA-256 without channel binding (RFC 5802, 7677).
type scram struct {
	password    string
	clientNonce string
	salted      []byte
	authMessage string
}

func newScram(password string) (*scram, error) {
	nonce := make([]byte, 18)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return &scram{password: password, clientNonce: base64.StdEncoding.EncodeToString(nonce)}, nil
}

func (s *scram) clientFirstBare() string { return "n=,r=" + s.clientNonce }

func (s *scram) clientFinal(serverFirst string) (string, error) {
	attrs := map[string]string{}
	for _, part := range strings.Split(serverFirst, ",") {
		if len(part) > 2 && part[1] == '=' {
			attrs[part[:1]] = part[2:]
		}
	}
	nonce := attrs["r"]
	salt, err := base64.StdEncoding.DecodeString(attrs["s"])
	iterations, _ := strconv.Atoi(attrs["i"])
	if err != nil || !strings.HasPrefix(nonce, s.clientNonce) || iterations < 1 || iterations > 10_000_000 {
		return "", &pgError{SQLState: "28000", Message: "the server's SCRAM answer is not valid"}
	}
	s.salted, err = pbkdf2.Key(sha256.New, s.password, salt, iterations, 32)
	if err != nil {
		return "", err
	}
	without := "c=biws,r=" + nonce
	s.authMessage = s.clientFirstBare() + "," + serverFirst + "," + without
	clientKey := hmacSHA256(s.salted, "Client Key")
	stored := sha256.Sum256(clientKey)
	sig := hmacSHA256(stored[:], s.authMessage)
	proof := make([]byte, len(clientKey))
	for i := range clientKey {
		proof[i] = clientKey[i] ^ sig[i]
	}
	return without + ",p=" + base64.StdEncoding.EncodeToString(proof), nil
}

func (s *scram) verify(serverFinal string) bool {
	m := regexp.MustCompile(`(?:^|,)v=([^,]+)`).FindStringSubmatch(serverFinal)
	if m == nil || s.authMessage == "" {
		return false
	}
	want := hmacSHA256(hmacSHA256(s.salted, "Server Key"), s.authMessage)
	got, err := base64.StdEncoding.DecodeString(m[1])
	return err == nil && hmac.Equal(want, got)
}

// pgSignIn signs in after the SSLRequest (and TLS when the server offered it).
func (c *conn) pgSignIn(user string, password *string, database string) (map[string]string, error) {
	if err := c.write(pgStartup(user, database)); err != nil {
		return nil, err
	}
	params := map[string]string{}
	var sc *scram
	need := func() (string, error) {
		if password == nil {
			return "", &pgError{SQLState: "28P01", Message: "the server asks for a password and none was given"}
		}
		return *password, nil
	}
	for {
		typ, body, err := c.pgRead()
		if err != nil {
			return nil, err
		}
		switch typ {
		case 'E':
			return nil, pgErrorOf(body)
		case 'S':
			parts := bytes.SplitN(body, []byte{0}, 3)
			if len(parts) >= 2 {
				params[string(parts[0])] = string(parts[1])
			}
		case 'Z':
			return params, nil
		case 'R':
			if len(body) < 4 {
				return nil, errors.New("short authentication message")
			}
			code := binary.BigEndian.Uint32(body[:4])
			var reply []byte
			switch code {
			case 0:
				continue
			case 3:
				pw, err := need()
				if err != nil {
					return nil, err
				}
				reply = pgMessage('p', cstr(pw))
			case 5:
				pw, err := need()
				if err != nil {
					return nil, err
				}
				if len(body) < 8 {
					return nil, errors.New("short MD5 salt")
				}
				reply = pgMessage('p', cstr(pgMD5(user, pw, body[4:8])))
			case 10:
				mechanisms := strings.Split(string(body[4:]), "\x00")
				found := false
				for _, m := range mechanisms {
					found = found || m == "SCRAM-SHA-256"
				}
				if !found {
					return nil, &pgError{SQLState: "28000", Message: "unsupported SASL mechanisms: " + strings.Join(mechanisms, ", ")}
				}
				pw, err := need()
				if err != nil {
					return nil, err
				}
				if sc, err = newScram(pw); err != nil {
					return nil, err
				}
				first := []byte("n,," + sc.clientFirstBare())
				var b bytes.Buffer
				b.Write(cstr("SCRAM-SHA-256"))
				_ = binary.Write(&b, binary.BigEndian, int32(len(first)))
				b.Write(first)
				reply = pgMessage('p', b.Bytes())
			case 11:
				if sc == nil {
					return nil, errors.New("unexpected SCRAM message")
				}
				final, err := sc.clientFinal(string(body[4:]))
				if err != nil {
					return nil, err
				}
				reply = pgMessage('p', []byte(final))
			case 12:
				if sc == nil || !sc.verify(string(body[4:])) {
					return nil, &pgError{SQLState: "28000", Message: "the server's SCRAM signature does not match"}
				}
				continue
			default:
				return nil, &pgError{SQLState: "28000", Message: fmt.Sprintf("unsupported authentication method %d", code)}
			}
			if err := c.write(reply); err != nil {
				return nil, err
			}
		}
	}
}

// pgQuery runs one simple query; NULL is nil.
func (c *conn) pgQuery(sql string) ([][]*string, error) {
	if err := c.write(pgMessage('Q', cstr(sql))); err != nil {
		return nil, err
	}
	var rows [][]*string
	var failure *pgError
	for {
		typ, body, err := c.pgRead()
		if err != nil {
			return nil, err
		}
		switch typ {
		case 'D':
			if len(body) < 2 {
				return nil, errors.New("short data row")
			}
			n := int(binary.BigEndian.Uint16(body[:2]))
			off := 2
			row := make([]*string, 0, n)
			for i := 0; i < n; i++ {
				if off+4 > len(body) {
					return nil, errors.New("short data row")
				}
				l := int(int32(binary.BigEndian.Uint32(body[off : off+4])))
				off += 4
				if l < 0 {
					row = append(row, nil)
					continue
				}
				if off+l > len(body) {
					return nil, errors.New("short data row")
				}
				v := string(body[off : off+l])
				off += l
				row = append(row, &v)
			}
			if len(rows) <= maxDatabases {
				rows = append(rows, row)
			}
		case 'E':
			failure = pgErrorOf(body)
		case 'Z':
			if failure != nil {
				return nil, failure
			}
			return rows, nil
		}
	}
}

func (c *conn) pgTerminate() { _ = c.write(pgMessage('X', nil)) }

func cell(rows [][]*string, r, col int) string {
	if r < len(rows) && col < len(rows[r]) && rows[r][col] != nil {
		return *rows[r][col]
	}
	return ""
}

func truthy(s string) bool { return s == "t" || s == "true" }

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

var digits = regexp.MustCompile(`^\d{1,20}$`)

// pgFacts reads the facts of the rights matrix and the identity, read-only.
func (c *conn) pgFacts() (*api.DBPostgresFacts, error) {
	head, err := c.pgQuery("SELECT current_setting('server_version_num'), version(), current_user, r.rolsuper, r.rolcreatedb, r.rolreplication, (SELECT system_identifier::text FROM pg_control_system()) FROM pg_roles r WHERE r.rolname = current_user")
	if err != nil {
		return nil, err
	}
	num, _ := strconv.Atoi(cell(head, 0, 0))
	f := &api.DBPostgresFacts{
		VersionNum:  num,
		Version:     clip(cell(head, 0, 1), 512),
		CurrentUser: clip(cell(head, 0, 2), 128),
		Superuser:   truthy(cell(head, 0, 3)),
		CreateDB:    truthy(cell(head, 0, 4)),
		Replication: truthy(cell(head, 0, 5)),
		Databases:   []api.DBPostgresDatabase{},
	}
	if id := cell(head, 0, 6); digits.MatchString(id) {
		f.SystemIdentifier = &id
	}
	if num >= 140000 {
		rows, err := c.pgQuery("SELECT pg_has_role(current_user, 'pg_read_all_data', 'USAGE')")
		if err != nil {
			return nil, err
		}
		v := truthy(cell(rows, 0, 0))
		f.ReadAllData = &v
	}
	dbs, err := c.pgQuery(fmt.Sprintf("SELECT d.oid::text, d.datname, d.datallowconn, has_database_privilege(d.oid, 'CONNECT'), CASE WHEN has_database_privilege(d.oid, 'CONNECT') THEN pg_database_size(d.oid)::text END FROM pg_database d WHERE NOT d.datistemplate ORDER BY d.datname LIMIT %d", maxDatabases))
	if err != nil {
		return nil, err
	}
	for i := range dbs {
		d := api.DBPostgresDatabase{
			OID:              cell(dbs, i, 0),
			Name:             clip(cell(dbs, i, 1), 128),
			AllowConnections: truthy(cell(dbs, i, 2)),
			CanConnect:       truthy(cell(dbs, i, 3)),
		}
		if s := cell(dbs, i, 4); s != "" {
			if n, err := strconv.ParseInt(s, 10, 64); err == nil {
				d.SizeBytes = &n
			}
		}
		f.Databases = append(f.Databases, d)
	}
	return f, nil
}

var pgVersionRe = regexp.MustCompile(`PostgreSQL\s+([0-9][0-9.]*\w*)`)

func pgShortVersion(version string) string {
	if m := pgVersionRe.FindStringSubmatch(version); m != nil {
		return m[1]
	}
	return ""
}
