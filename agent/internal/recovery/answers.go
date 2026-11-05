package recovery

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
)

// AnswersFormat is the format of the answers file (C-M4-4).
const AnswersFormat = "restow-answers-v1"

// MaxAnswersBytes bounds the answers file.
const MaxAnswersBytes = 64 << 10

// Source is where the answers came from (10.20); the source decides what
// they may contain.
type Source int

const (
	// SourceFWCfg is QEMU's fw_cfg (opt/restow/answers): only in a VM whose
	// DMI sys_vendor is QEMU; who sets it controls the hypervisor.
	SourceFWCfg Source = iota + 1
	// SourceMedia is answers.json on a medium labelled RESTOWANS, read only
	// with restow.answers=media on the kernel command line.
	SourceMedia
	// SourceFile is a file given with --answers in the shell.
	SourceFile
)

func (s Source) String() string {
	switch s {
	case SourceFWCfg:
		return "fw_cfg"
	case SourceMedia:
		return "medium"
	case SourceFile:
		return "file"
	}
	return "unknown"
}

// Answers are the answers of an unattended recovery (C-M4-4). Secrets
// (code, passphrase, reconnect token) are accepted from fw_cfg only;
// recover asks for them when the answers come from elsewhere.
type Answers struct {
	Format        string          `json:"format"`
	InstanceURL   string          `json:"instanceUrl"`
	Code          string          `json:"code,omitempty"`
	CAFile        string          `json:"caFile,omitempty"`
	SPKICheck     string          `json:"spkiCheck,omitempty"`
	SnapshotID    string          `json:"snapshotId,omitempty"`
	Keymap        string          `json:"keymap,omitempty"`
	Language      string          `json:"language,omitempty"`
	Network       *AnswersNetwork `json:"network,omitempty"`
	DiskMapping   DiskMapping     `json:"diskMapping"`
	Adopt         []string        `json:"adopt,omitempty"`
	Shrink        string          `json:"shrink,omitempty"`
	Passphrase    string          `json:"passphrase,omitempty"`
	KeyFiles      string          `json:"keyFiles,omitempty"`
	ConfirmErase  []string        `json:"confirmErase,omitempty"`
	RenameNICs    bool            `json:"renameNics,omitempty"`
	RawLVs        string          `json:"rawLvs,omitempty"`
	SecureBootOff bool            `json:"secureBootOff,omitempty"`
	RebindToken   string          `json:"rebindToken,omitempty"`
	AfterSuccess  string          `json:"afterSuccess,omitempty"`
	Probe         json.RawMessage `json:"probe,omitempty"`

	// Source is where the answers came from (not part of the file).
	Source Source `json:"-"`
}

// AnswersNetwork is the network of the answers: dhcp (the default) or
// static.
type AnswersNetwork struct {
	Mode      string   `json:"mode"`
	Interface string   `json:"interface,omitempty"`
	Address   string   `json:"address,omitempty"`
	Gateway   string   `json:"gateway,omitempty"`
	DNS       []string `json:"dns,omitempty"`
	Proxy     string   `json:"proxy,omitempty"`
}

// DiskMapping is "auto" or a map from source disk id to target identity.
type DiskMapping struct {
	Auto bool
	Map  map[string]string
}

// UnmarshalJSON reads "auto" or an object.
func (d *DiskMapping) UnmarshalJSON(b []byte) error {
	var s string
	if json.Unmarshal(b, &s) == nil {
		if s != "auto" {
			return fmt.Errorf("diskMapping: %q (want \"auto\" or an object)", s)
		}
		*d = DiskMapping{Auto: true}
		return nil
	}
	m := map[string]string{}
	dec := json.NewDecoder(bytes.NewReader(b))
	if err := dec.Decode(&m); err != nil {
		return fmt.Errorf("diskMapping: %v", err)
	}
	*d = DiskMapping{Map: m}
	return nil
}

// MarshalJSON writes "auto" or the object.
func (d DiskMapping) MarshalJSON() ([]byte, error) {
	if d.Auto || d.Map == nil {
		return []byte(`"auto"`), nil
	}
	return json.Marshal(d.Map)
}

var (
	reIdentity  = regexp.MustCompile(`^(wwn\.[0-9a-fx]{1,64}|eui\.[0-9a-f]{1,64}|nguid\.[0-9a-f]{1,64}|serial\.[\x21-\x7e]{1,128}|path\.[A-Za-z0-9:._+-]{1,200})$`)
	reDiskID    = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
	reIfName    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,14}$`)
	reSnapshot  = regexp.MustCompile(`^[0-9a-f]{8,64}$`)
	reUnitID    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$`)
	reSPKICheck = regexp.MustCompile(`^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$`)
)

// ValidIdentity reports whether s is a disk identity (10.6).
func ValidIdentity(s string) bool { return reIdentity.MatchString(s) }

// LoadAnswers parses and checks an answers file from src. isQEMU is true
// when /sys/class/dmi/id/sys_vendor is QEMU.
func LoadAnswers(src Source, b []byte, isQEMU bool) (*Answers, error) {
	if len(b) > MaxAnswersBytes {
		return nil, errors.New("answers: file too large")
	}
	if src == SourceFWCfg && !isQEMU {
		return nil, errors.New("answers: fw_cfg is read only in a QEMU virtual machine")
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var a Answers
	if err := dec.Decode(&a); err != nil {
		return nil, fmt.Errorf("answers: %v", err)
	}
	if dec.More() {
		return nil, errors.New("answers: trailing data")
	}
	a.Source = src
	if a.Format != AnswersFormat {
		return nil, fmt.Errorf("answers: format %q, want %q", a.Format, AnswersFormat)
	}
	if len(a.Probe) > 0 {
		return nil, errors.New("answers: probe answers need a newer ISO")
	}
	fwcfg := src == SourceFWCfg && isQEMU
	if !fwcfg {
		var plain []string
		if a.Code != "" {
			plain = append(plain, "code")
		}
		if a.Passphrase != "" {
			plain = append(plain, "passphrase")
		}
		if a.RebindToken != "" {
			plain = append(plain, "rebindToken")
		}
		if len(plain) > 0 {
			return nil, fmt.Errorf("answers from the %s must not contain %s (recover asks for it); only fw_cfg may carry secrets", src, strings.Join(plain, ", "))
		}
	}
	u, err := url.Parse(a.InstanceURL)
	switch {
	case a.InstanceURL == "":
		return nil, errors.New("answers: instanceUrl is required")
	case err != nil || u.Host == "" || u.User != nil:
		return nil, fmt.Errorf("answers: instanceUrl %q is not valid", a.InstanceURL)
	case u.Scheme == "http" && !fwcfg:
		return nil, errors.New("answers: an http:// instance is allowed only from fw_cfg in a QEMU machine")
	case u.Scheme != "https" && u.Scheme != "http":
		return nil, fmt.Errorf("answers: instanceUrl %q is not https", a.InstanceURL)
	}
	if a.Code != "" {
		if _, err := NormalizeCode(a.Code); err != nil {
			return nil, fmt.Errorf("answers: code: %v", err)
		}
	}
	if a.SPKICheck != "" && !reSPKICheck.MatchString(strings.ToUpper(a.SPKICheck)) {
		return nil, errors.New("answers: spkiCheck must be XXXX-XXXX-XXXX-XXXX")
	}
	if a.CAFile != "" && (!strings.HasPrefix(a.CAFile, "/") || strings.Contains(a.CAFile, "..")) {
		return nil, errors.New("answers: caFile must be an absolute path")
	}
	if a.SnapshotID != "" && !reSnapshot.MatchString(a.SnapshotID) {
		return nil, errors.New("answers: snapshotId is not a snapshot id")
	}
	if a.Keymap != "" && !oneOfStr(a.Keymap, ISOKeymaps...) {
		return nil, fmt.Errorf("answers: keymap %q (one of %s)", a.Keymap, strings.Join(ISOKeymaps, ", "))
	}
	if a.Language != "" && a.Language != LangDE && a.Language != LangEN {
		return nil, fmt.Errorf("answers: language %q", a.Language)
	}
	if err := a.Network.check(); err != nil {
		return nil, err
	}
	if !a.DiskMapping.Auto && a.DiskMapping.Map == nil {
		return nil, errors.New("answers: diskMapping is required (\"auto\" or an object)")
	}
	for k, v := range a.DiskMapping.Map {
		if !reDiskID.MatchString(k) || !ValidIdentity(v) {
			return nil, fmt.Errorf("answers: diskMapping %q: %q is not a disk identity", k, v)
		}
	}
	for _, id := range a.Adopt {
		if !reUnitID.MatchString(id) {
			return nil, fmt.Errorf("answers: adopt %q", id)
		}
	}
	for _, id := range a.ConfirmErase {
		if !ValidIdentity(id) {
			return nil, fmt.Errorf("answers: confirmErase %q is not a disk identity", id)
		}
	}
	for _, c := range []struct {
		name, v string
		allowed []string
	}{
		{"shrink", a.Shrink, []string{"none", "auto"}},
		{"keyFiles", a.KeyFiles, []string{"regenerate", "keep"}},
		{"rawLvs", a.RawLVs, []string{"skip", "create"}},
		{"afterSuccess", a.AfterSuccess, []string{"reboot", "poweroff"}},
	} {
		if c.v != "" && !oneOfStr(c.v, c.allowed...) {
			return nil, fmt.Errorf("answers: %s %q (one of %s)", c.name, c.v, strings.Join(c.allowed, ", "))
		}
	}
	if a.RebindToken != "" && !strings.HasPrefix(a.RebindToken, "rset_") {
		return nil, errors.New("answers: rebindToken is not a reconnect token")
	}
	if a.Passphrase != "" && len(a.Passphrase) > 512 {
		return nil, errors.New("answers: passphrase too long")
	}
	return &a, nil
}

func (n *AnswersNetwork) check() error {
	if n == nil {
		return nil
	}
	if n.Proxy != "" {
		if err := CheckProxy(n.Proxy); err != nil {
			return fmt.Errorf("answers: network.proxy: %v", err)
		}
	}
	switch n.Mode {
	case "dhcp":
		if n.Interface != "" || n.Address != "" || n.Gateway != "" || len(n.DNS) > 0 {
			return errors.New("answers: network: dhcp takes no interface, address, gateway or dns")
		}
		return nil
	case "static":
	default:
		return fmt.Errorf("answers: network.mode %q (dhcp or static)", n.Mode)
	}
	if !reIfName.MatchString(n.Interface) {
		return fmt.Errorf("answers: network.interface %q", n.Interface)
	}
	if _, _, err := net.ParseCIDR(n.Address); err != nil {
		return fmt.Errorf("answers: network.address %q is not address/prefix", n.Address)
	}
	if n.Gateway != "" && net.ParseIP(n.Gateway) == nil {
		return fmt.Errorf("answers: network.gateway %q", n.Gateway)
	}
	if len(n.DNS) > 3 {
		return errors.New("answers: network.dns: at most three servers")
	}
	for _, d := range n.DNS {
		if net.ParseIP(d) == nil {
			return fmt.Errorf("answers: network.dns %q", d)
		}
	}
	return nil
}

// CheckProxy accepts http://host:port without credentials, path or query
// (docs/BAREMETAL.md 10.3).
func CheckProxy(p string) error {
	u, err := url.Parse(p)
	if err != nil || u.Scheme != "http" || u.Host == "" || u.Port() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("%q is not http://host:port", p)
	}
	return nil
}

func oneOfStr(v string, allowed ...string) bool {
	for _, a := range allowed {
		if v == a {
			return true
		}
	}
	return false
}
