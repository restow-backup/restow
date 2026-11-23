package recovery

import (
	"bytes"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/redact"
)

// OneshotFormat is the format of the session data a oneshot restore hands
// from the command on the fresh machine to recover in the recovery
// environment (docs/BAREMETAL-ONESHOT.md 9.2).
const OneshotFormat = "restow-oneshot-v1"

// OneshotDir and OneshotPath are where the ISO's init-bottom script puts the
// data (0700 and 0600, root): /run moves into the live system.
const (
	OneshotDir  = "/run/restow-oneshot"
	OneshotPath = OneshotDir + "/oneshot.json"
	// MaxOneshotBytes bounds the data (payload.MaxDataBytes).
	MaxOneshotBytes = 256 << 10
)

// OneshotData is the session data of a oneshot restore. It is a source of
// answers of its own (docs/BAREMETAL-ONESHOT.md 9.2): who can put it there
// started the recovery kernel (kexec needs CAP_SYS_BOOT), the same power as
// over fw_cfg. So it may carry the LUKS passphrase the operator typed on the
// fresh machine's console; it never carries a code: the session was
// exchanged before the switch, and its secret comes along.
type OneshotData struct {
	Format      string `json:"format"`
	InstanceURL string `json:"instanceUrl"`
	Language    string `json:"lang,omitempty"`
	// SPKISHA256 is the hex SHA-256 of the public key of the instance's
	// certificate, as the command saw it on a connection with a valid
	// certificate (5.1); CAPEM the CA file the command was given, if any.
	SPKISHA256 string `json:"spkiSha256,omitempty"`
	CAPEM      string `json:"caPem,omitempty"`
	Session    struct {
		ID     string `json:"id"`
		Secret string `json:"secret"`
	} `json:"session"`
	// ConfirmErase are the identities of the disks the operator confirmed on
	// the console of the fresh machine.
	ConfirmErase []string `json:"confirmErase"`
	Passphrase   string   `json:"passphrase,omitempty"`
	// SSHKeys are the public keys of the fresh machine's root; recover uses
	// them only when the approval allowed remote access.
	SSHKeys []string `json:"sshKeys,omitempty"`
	// Consoles are the console= values of the fresh machine's kernel.
	Consoles []string `json:"consoles,omitempty"`
	// Network is the network the command measured (docs/BAREMETAL-ONESHOT.md
	// 10.1), kept as it is for the recovery environment's network.
	Network json.RawMessage `json:"network,omitempty"`
}

var (
	reSessionID    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	reSecretHex    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	reConsoleValue = regexp.MustCompile(`^(tty[0-9]{1,2}|ttyS[0-3](,[0-9]{3,7}(n8)?)?)$`)
)

// LoadOneshotData parses and checks the session data. isQEMU allows an
// http:// instance (the CI cases), like fw_cfg.
func LoadOneshotData(b []byte, isQEMU bool) (*OneshotData, error) {
	if len(b) > MaxOneshotBytes {
		return nil, errors.New("oneshot data: too large")
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var d OneshotData
	if err := dec.Decode(&d); err != nil {
		return nil, fmt.Errorf("oneshot data: %v", err)
	}
	if dec.More() {
		return nil, errors.New("oneshot data: trailing data")
	}
	if d.Format != OneshotFormat {
		return nil, fmt.Errorf("oneshot data: format %q, want %q", d.Format, OneshotFormat)
	}
	u, err := url.Parse(d.InstanceURL)
	switch {
	case err != nil || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "":
		return nil, fmt.Errorf("oneshot data: instanceUrl %q is not an origin", d.InstanceURL)
	case u.Scheme == "http" && !isQEMU:
		return nil, errors.New("oneshot data: an http:// instance is allowed only in a QEMU machine")
	case u.Scheme != "https" && u.Scheme != "http":
		return nil, fmt.Errorf("oneshot data: instanceUrl %q is not https", d.InstanceURL)
	}
	if d.Language != "" && d.Language != LangDE && d.Language != LangEN {
		return nil, fmt.Errorf("oneshot data: lang %q", d.Language)
	}
	if d.SPKISHA256 != "" && !reSecretHex.MatchString(d.SPKISHA256) {
		return nil, errors.New("oneshot data: spkiSha256 is not a SHA-256")
	}
	if d.CAPEM != "" {
		if err := checkCAPEM(d.CAPEM); err != nil {
			return nil, fmt.Errorf("oneshot data: caPem: %v", err)
		}
	}
	if !reSessionID.MatchString(d.Session.ID) {
		return nil, errors.New("oneshot data: session.id is not a session id")
	}
	if !reSecretHex.MatchString(d.Session.Secret) {
		return nil, errors.New("oneshot data: session.secret is not a session secret")
	}
	if len(d.ConfirmErase) == 0 {
		return nil, errors.New("oneshot data: confirmErase is empty (the console of the fresh machine confirms the disks)")
	}
	seen := map[string]bool{}
	for _, id := range d.ConfirmErase {
		if !ValidIdentity(id) {
			return nil, fmt.Errorf("oneshot data: confirmErase %q is not a disk identity", id)
		}
		if seen[id] {
			return nil, fmt.Errorf("oneshot data: confirmErase names %q twice", id)
		}
		seen[id] = true
	}
	if len(d.Passphrase) > 512 {
		return nil, errors.New("oneshot data: passphrase too long")
	}
	if len(d.SSHKeys) > MaxOneshotSSHKeys {
		return nil, fmt.Errorf("oneshot data: more than %d SSH keys", MaxOneshotSSHKeys)
	}
	for _, k := range d.SSHKeys {
		if _, err := ParseAuthorizedKey(k); err != nil {
			return nil, fmt.Errorf("oneshot data: sshKeys: %v", err)
		}
	}
	if len(d.Consoles) > 8 {
		return nil, errors.New("oneshot data: more than 8 consoles")
	}
	for _, c := range d.Consoles {
		if !reConsoleValue.MatchString(c) {
			return nil, fmt.Errorf("oneshot data: console %q", c)
		}
	}
	if n := bytes.TrimSpace(d.Network); len(n) > 0 && (n[0] != '{' || !json.Valid(n)) {
		return nil, errors.New("oneshot data: network is not a JSON object")
	}
	return &d, nil
}

// Answers are the answers of a oneshot restore (docs/BAREMETAL-ONESHOT.md
// 9.3): the keyboard is us, the language the issuer's, the disks are mapped
// automatically, the disks to erase are the ones the console of the fresh
// machine confirmed, and the machine restarts after a success. What the
// release decides (shrinking, Secure Boot) comes with ApplyDecided.
func (d *OneshotData) Answers() *Answers {
	a := &Answers{Format: AnswersFormat, InstanceURL: d.InstanceURL, Keymap: "us", Language: d.Language,
		DiskMapping: DiskMapping{Auto: true}, Passphrase: d.Passphrase, ConfirmErase: append([]string(nil), d.ConfirmErase...),
		AfterSuccess: "reboot", Shrink: "none", Source: SourceOneshot}
	if d.SPKISHA256 != "" {
		a.SPKICheck = d.SPKISHA256
	}
	if d.CAPEM != "" {
		a.CAPEM = []byte(d.CAPEM)
	}
	return a
}

// ApplyDecided takes the admin's decisions of the release into the answers.
func (a *Answers) ApplyDecided(dec *api.OneshotDecided) {
	a.Shrink = "none"
	if dec.ConfirmShrink {
		a.Shrink = "auto"
	}
	a.SecureBootOff = dec.SecureBootWarningsOnly
}

// ApprovedKeys returns the keys of the session data whose fingerprints are
// exactly the ones the admin saw with the release (docs/BAREMETAL-ONESHOT.md
// 8.4): every key's fingerprint is among them and every fingerprint has its
// key. Anything else is an error: remote access then stays off.
func (d *OneshotData) ApprovedKeys(approved []string) ([]string, error) {
	if len(d.SSHKeys) == 0 || len(approved) == 0 {
		return nil, errors.New("no SSH keys to allow")
	}
	want := map[string]bool{}
	for _, fp := range approved {
		want[fp] = true
	}
	have := map[string]bool{}
	var keys []string
	for _, line := range d.SSHKeys {
		k, err := ParseAuthorizedKey(line)
		if err != nil {
			return nil, err
		}
		fp := k.Fingerprint()
		if !want[fp] {
			return nil, fmt.Errorf("the key %s was not shown with the release", fp)
		}
		have[fp] = true
		keys = append(keys, k.Line())
	}
	for fp := range want {
		if !have[fp] {
			return nil, fmt.Errorf("the release names the key %s, which the session data lacks", fp)
		}
	}
	return keys, nil
}

// RegisterSecrets hands the session secret and the passphrase to the
// redactor, so neither shows up in a log.
func (d *OneshotData) RegisterSecrets() {
	for _, s := range []string{d.Session.Secret, d.Passphrase} {
		if s != "" {
			redact.Add(s)
		}
	}
}

func checkCAPEM(s string) error {
	rest := []byte(s)
	n := 0
	for {
		var blk *pem.Block
		blk, rest = pem.Decode(rest)
		if blk == nil {
			break
		}
		if blk.Type != "CERTIFICATE" {
			return fmt.Errorf("a %s block", blk.Type)
		}
		if _, err := x509.ParseCertificate(blk.Bytes); err != nil {
			return err
		}
		n++
	}
	if n == 0 || strings.TrimSpace(string(rest)) != "" {
		return errors.New("not a list of PEM certificates")
	}
	return nil
}

// MaxOneshotSSHKeys bounds the public keys taken from authorized_keys.
const MaxOneshotSSHKeys = 16

// sshKeyTypes are the public key types taken over from authorized_keys.
var sshKeyTypes = map[string]bool{
	"ssh-ed25519": true, "ssh-rsa": true, "ecdsa-sha2-nistp256": true, "ecdsa-sha2-nistp384": true,
	"ecdsa-sha2-nistp521": true, "sk-ssh-ed25519@openssh.com": true, "sk-ecdsa-sha2-nistp256@openssh.com": true,
}

// AuthorizedKey is one public key line of authorized_keys.
type AuthorizedKey struct {
	Type    string
	Blob    []byte
	Comment string
}

// Fingerprint is the key's SHA256 fingerprint as ssh-keygen -l shows it.
func (k AuthorizedKey) Fingerprint() string {
	h := sha256.Sum256(k.Blob)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(h[:])
}

// Line is the key as one line without its comment.
func (k AuthorizedKey) Line() string {
	return k.Type + " " + base64.StdEncoding.EncodeToString(k.Blob)
}

// ParseAuthorizedKey accepts one public key line of authorized_keys without
// options ("ssh-ed25519 AAAA... comment"). A line with options (command=,
// from=, ...) is refused: recover would not honour them. The blob must name
// the same key type as the line.
func ParseAuthorizedKey(line string) (AuthorizedKey, error) {
	line = strings.TrimSpace(line)
	if line == "" || strings.ContainsAny(line, "\n\r\x00") || len(line) > 16<<10 {
		return AuthorizedKey{}, errors.New("not a public key line")
	}
	f := strings.Fields(line)
	if len(f) < 2 || !sshKeyTypes[f[0]] {
		return AuthorizedKey{}, errors.New("not a public key line of a known type (a line with options is not taken over)")
	}
	blob, err := base64.StdEncoding.DecodeString(f[1])
	if err != nil || len(blob) < 4 {
		return AuthorizedKey{}, errors.New("the key is not base64")
	}
	n := binary.BigEndian.Uint32(blob[:4])
	if int(n) > len(blob)-4 || string(blob[4:4+n]) != f[0] {
		return AuthorizedKey{}, errors.New("the key does not match its type")
	}
	return AuthorizedKey{Type: f[0], Blob: blob, Comment: strings.Join(f[2:], " ")}, nil
}
