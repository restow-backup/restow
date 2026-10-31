package paths

// ACL evaluation for the Windows trust check (docs/WINDOWS-AGENT.md, section
// 6). Windows hands the owner and the DACL of a file or folder over as SDDL
// text (ConvertSecurityDescriptorToStringSecurityDescriptorW, see
// trust_windows.go); everything from there on is plain Go without a build tag,
// so the same functions judge the test data from real machines
// (testdata/*.sddl) on any system and the real folders on Windows.

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/restow-backup/restow/agent/internal/winapi"
)

// ACLRule says which rights an untrusted principal may not have.
type ACLRule int

const (
	// RuleStrict applies to the checked file or folder and its direct parent:
	// nobody untrusted may write, append, change attributes, delete, change
	// the permissions or take ownership.
	RuleStrict ACLRule = iota
	// RuleAncestor applies to the folders above the parent: only rights that
	// remove, rename or re-permission an existing entry are forbidden (C:\
	// lets every user create folders, C:\ProgramData lets users add files).
	RuleAncestor
	// RuleRestoreParent applies to the parent of a restore target: like
	// RuleStrict, but untrusted users may add files and folders (C:\ itself is
	// a valid parent of C:\Restow-Restore-...).
	RuleRestoreParent
	// RulePrivate applies to the state file: untrusted principals may have no
	// access at all (not even read).
	RulePrivate
)

const (
	strictForbidden = winapi.FileWriteData | winapi.FileAppendData | winapi.FileWriteEA | winapi.FileWriteAttributes |
		winapi.FileDeleteChild | winapi.Delete | winapi.WriteDAC | winapi.WriteOwner
	ancestorForbidden      = winapi.Delete | winapi.FileDeleteChild | winapi.WriteDAC | winapi.WriteOwner
	restoreParentForbidden = strictForbidden &^ (winapi.FileWriteData | winapi.FileAppendData)
	privateForbidden       = strictForbidden | winapi.FileReadData | winapi.FileReadEA | winapi.FileReadAttributes |
		winapi.FileExecute | winapi.ReadControl
)

func (r ACLRule) forbidden() uint32 {
	switch r {
	case RuleAncestor:
		return ancestorForbidden
	case RuleRestoreParent:
		return restoreParentForbidden
	case RulePrivate:
		return privateForbidden
	}
	return strictForbidden
}

// ACE is one access control entry of a DACL.
type ACE struct {
	Type  string // "A" allow, "D" deny, others are ignored
	Flags string // SDDL flag letters, e.g. "OICIIO"
	Mask  uint32
	SID   string // S-1-... form
}

// InheritOnly reports whether the entry only serves inheritance and does not
// apply to the object itself.
func (a ACE) InheritOnly() bool { return hasFlag(a.Flags, "IO") }

func hasFlag(flags, f string) bool {
	for i := 0; i+1 < len(flags); i += 2 {
		if flags[i:i+2] == f {
			return true
		}
	}
	return false
}

// SecurityInfo is the parsed owner and DACL of an object.
type SecurityInfo struct {
	Owner string
	// NullDACL: no DACL at all, which grants everyone everything.
	NullDACL bool
	DACL     []ACE
}

// sddlAliases maps the two-letter SID aliases of SDDL to SIDs. Unknown aliases
// stay as they are and count as untrusted.
var sddlAliases = map[string]string{
	"SY": winapi.SIDLocalSystem, "BA": winapi.SIDAdministrators, "BU": winapi.SIDBuiltinUsers,
	"AU": winapi.SIDAuthenticatedUser, "WD": winapi.SIDEveryone, "CO": winapi.SIDCreatorOwner,
	"CG": "S-1-3-1", "OW": "S-1-3-4", "BG": "S-1-5-32-546", "PU": "S-1-5-32-547", "IU": "S-1-5-4",
	"NU": "S-1-5-2", "SU": "S-1-5-6", "LS": "S-1-5-19", "NS": "S-1-5-20", "AC": "S-1-15-2-1",
	"BO": "S-1-5-32-551", "SO": "S-1-5-32-549", "PS": "S-1-5-10", "RC": "S-1-5-12", "AN": "S-1-5-7",
	"RD": "S-1-5-32-555", "RU": "S-1-5-32-554", "ER": "S-1-5-32-573", "IS": "S-1-5-32-568",
	"CY": "S-1-5-32-569", "MU": "S-1-5-32-558", "LU": "S-1-5-32-559", "HA": "S-1-5-32-578",
	"AA": "S-1-5-32-579", "RM": "S-1-5-32-580", "WR": "S-1-5-33", "UD": "S-1-5-84-0-0-0-0-0",
	"LW": "S-1-16-4096", "ME": "S-1-16-8192", "HI": "S-1-16-12288", "SI": "S-1-16-16384",
}

// sddlRights maps the right letters of SDDL to access mask bits. The
// directory-service names (CC, DC, ...) are what Windows prints for single
// file rights.
var sddlRights = map[string]uint32{
	"GA": winapi.GenericAll, "GR": winapi.GenericRead, "GW": winapi.GenericWrite, "GX": winapi.GenericExecute,
	"RC": winapi.ReadControl, "SD": winapi.Delete, "WD": winapi.WriteDAC, "WO": winapi.WriteOwner,
	"FA": winapi.FileAllAccess, "FR": winapi.FileGenericRead, "FW": winapi.FileGenericWrite, "FX": winapi.FileGenericExecute,
	"CC": 0x1, "DC": 0x2, "LC": 0x4, "SW": 0x8, "RP": 0x10, "WP": 0x20, "DT": 0x40, "LO": 0x80, "CR": 0x100,
	"KA": 0xF003F, "KR": 0x20019, "KW": 0x20006, "KX": 0x20019,
	"AS": winapi.AccessSystemSecure, "MA": winapi.MaximumAllowed,
}

// ParseSDDL reads the owner (O:) and the DACL (D:) of an SDDL string. The
// group (G:) and a SACL (S:) are skipped.
func ParseSDDL(sddl string) (SecurityInfo, error) {
	var info SecurityInfo
	s := strings.TrimSpace(sddl)
	sawDACL := false
	for s != "" {
		if len(s) < 2 || s[1] != ':' {
			return info, fmt.Errorf("unexpected SDDL at %q", s)
		}
		part := s[0]
		s = s[2:]
		end := nextSDDLPart(s)
		body := s[:end]
		s = s[end:]
		switch part {
		case 'O':
			info.Owner = sidOf(body)
		case 'G':
		case 'D':
			sawDACL = true
			aces, null, err := parseACL(body)
			if err != nil {
				return info, err
			}
			info.DACL, info.NullDACL = aces, null
		case 'S':
		default:
			return info, fmt.Errorf("unknown SDDL component %q", string(part))
		}
	}
	if !sawDACL {
		// Without D: the caller did not ask for the DACL; treat as absent (untrusted).
		info.NullDACL = true
	}
	return info, nil
}

// nextSDDLPart finds where the next "X:" component starts (outside parentheses).
func nextSDDLPart(s string) int {
	depth := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '(':
			depth++
		case ')':
			depth--
		case 'O', 'G', 'D', 'S':
			if depth == 0 && i+1 < len(s) && s[i+1] == ':' && i > 0 {
				return i
			}
		}
	}
	return len(s)
}

func parseACL(body string) ([]ACE, bool, error) {
	if strings.HasPrefix(body, "NO_ACCESS_CONTROL") {
		return nil, true, nil
	}
	i := strings.IndexByte(body, '(')
	if i < 0 {
		// Flags only, no entries: an empty DACL grants nothing.
		return nil, false, nil
	}
	var aces []ACE
	rest := body[i:]
	for rest != "" {
		if rest[0] != '(' {
			return nil, false, fmt.Errorf("unexpected ACL text %q", rest)
		}
		j := strings.IndexByte(rest, ')')
		if j < 0 {
			return nil, false, fmt.Errorf("unterminated ACE in %q", rest)
		}
		ace, err := parseACE(rest[1:j])
		if err != nil {
			return nil, false, err
		}
		aces = append(aces, ace)
		rest = rest[j+1:]
	}
	return aces, false, nil
}

func parseACE(text string) (ACE, error) {
	f := strings.Split(text, ";")
	if len(f) < 6 {
		return ACE{}, fmt.Errorf("malformed ACE %q", text)
	}
	mask, err := parseRights(f[2])
	if err != nil {
		return ACE{}, fmt.Errorf("ACE %q: %w", text, err)
	}
	return ACE{Type: f[0], Flags: f[1], Mask: mask, SID: sidOf(f[5])}, nil
}

func parseRights(r string) (uint32, error) {
	if strings.HasPrefix(r, "0x") || strings.HasPrefix(r, "0X") {
		v, err := strconv.ParseUint(r[2:], 16, 32)
		return uint32(v), err
	}
	if r != "" && r[0] >= '0' && r[0] <= '9' {
		v, err := strconv.ParseUint(r, 10, 32)
		return uint32(v), err
	}
	if len(r)%2 != 0 {
		return 0, fmt.Errorf("unknown rights %q", r)
	}
	var mask uint32
	for i := 0; i < len(r); i += 2 {
		bit, ok := sddlRights[r[i:i+2]]
		if !ok {
			return 0, fmt.Errorf("unknown right %q", r[i:i+2])
		}
		mask |= bit
	}
	return mask, nil
}

func sidOf(s string) string {
	if sid, ok := sddlAliases[s]; ok {
		return sid
	}
	return s
}

// MapGenericFile resolves the generic rights of a mask with the file mapping.
func MapGenericFile(mask uint32) uint32 {
	if mask&winapi.GenericRead != 0 {
		mask |= winapi.FileGenericRead
	}
	if mask&winapi.GenericWrite != 0 {
		mask |= winapi.FileGenericWrite
	}
	if mask&winapi.GenericExecute != 0 {
		mask |= winapi.FileGenericExecute
	}
	if mask&winapi.GenericAll != 0 {
		mask |= winapi.FileAllAccess
	}
	return mask &^ (winapi.GenericRead | winapi.GenericWrite | winapi.GenericExecute | winapi.GenericAll)
}

// TrustedSIDs is the set of principals the agent trusts: SYSTEM,
// Administrators and TrustedInstaller, plus extra (the user of a development
// run without privileges).
func TrustedSIDs(extra ...string) map[string]bool {
	m := map[string]bool{winapi.SIDLocalSystem: true, winapi.SIDAdministrators: true, winapi.SIDTrustedInstaller: true}
	for _, s := range extra {
		if s != "" {
			m[strings.ToUpper(s)] = true
		}
	}
	return m
}

// EvaluateACL checks owner and DACL against a rule. It returns "" when the
// object is trusted, else the reason.
func EvaluateACL(info SecurityInfo, rule ACLRule, trusted map[string]bool) string {
	if !trusted[strings.ToUpper(info.Owner)] {
		return fmt.Sprintf("is owned by %s, not by SYSTEM, Administrators or TrustedInstaller", describeSID(info.Owner))
	}
	if info.NullDACL {
		return "has no access control list (everyone has full access)"
	}
	forbidden := rule.forbidden()
	for _, ace := range info.DACL {
		if ace.Type != "A" || ace.InheritOnly() || trusted[strings.ToUpper(ace.SID)] {
			continue
		}
		// GENERIC_WRITE and GENERIC_ALL are refused under every rule set, as the
		// design lists them; the other generic rights count as what they map to.
		if ace.Mask&(winapi.GenericWrite|winapi.GenericAll) != 0 {
			return fmt.Sprintf("grants %s generic write or full access", describeSID(ace.SID))
		}
		if bad := MapGenericFile(ace.Mask) & forbidden; bad != 0 {
			return fmt.Sprintf("grants %s rights it must not have (%s)", describeSID(ace.SID), describeRights(bad))
		}
	}
	return ""
}

var sidNames = map[string]string{
	winapi.SIDBuiltinUsers: "Users", winapi.SIDAuthenticatedUser: "Authenticated Users",
	winapi.SIDEveryone: "Everyone", winapi.SIDCreatorOwner: "CREATOR OWNER", "S-1-15-2-1": "ALL APPLICATION PACKAGES",
	winapi.SIDLocalSystem: "SYSTEM", winapi.SIDAdministrators: "Administrators", winapi.SIDTrustedInstaller: "TrustedInstaller",
}

func describeSID(sid string) string {
	if sid == "" {
		return "an unknown owner"
	}
	if n, ok := sidNames[sid]; ok {
		return n + " (" + sid + ")"
	}
	return sid
}

func describeRights(mask uint32) string {
	names := []struct {
		bit  uint32
		name string
	}{
		{winapi.FileReadData, "read"}, {winapi.FileWriteData, "write/add file"}, {winapi.FileAppendData, "append/add folder"},
		{winapi.FileWriteEA, "write extended attributes"}, {winapi.FileWriteAttributes, "write attributes"},
		{winapi.FileDeleteChild, "delete child"}, {winapi.Delete, "delete"}, {winapi.WriteDAC, "change permissions"},
		{winapi.WriteOwner, "take ownership"}, {winapi.ReadControl, "read permissions"},
	}
	var out []string
	for _, n := range names {
		if mask&n.bit != 0 {
			out = append(out, n.name)
		}
	}
	if len(out) == 0 {
		return fmt.Sprintf("0x%x", mask)
	}
	return strings.Join(out, ", ")
}

// ProtectedSDDL is the DACL of the agent's private folders: SYSTEM and
// Administrators only, nothing inherited from above.
const ProtectedSDDL = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"

// DataDirSDDL is the DACL of the data folder: like ProtectedSDDL, and Users
// may list this folder (only this folder) to read status.json.
const DataDirSDDL = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x1200a9;;;BU)"

// StatusFileSDDL is the DACL of status.json: readable by Users.
const StatusFileSDDL = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;BU)"
