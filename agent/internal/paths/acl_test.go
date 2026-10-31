package paths

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func loadSDDL(t *testing.T, name string) SecurityInfo {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	info, err := ParseSDDL(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return info
}

func TestACLRuleSetsOnStandardFolders(t *testing.T) {
	trusted := TrustedSIDs()
	cases := []struct {
		file string
		rule ACLRule
		ok   bool
	}{
		// C:\ lets Authenticated Users create folders: fine above, not as the object.
		{"c-root.sddl", RuleAncestor, true},
		{"c-root.sddl", RuleStrict, false},
		{"c-root.sddl", RuleRestoreParent, true},
		// C:\ProgramData lets Users add files and folders.
		{"programdata.sddl", RuleAncestor, true},
		{"programdata.sddl", RuleStrict, false},
		{"programdata.sddl", RuleRestoreParent, false},
		// C:\Program Files: only SYSTEM, Administrators and TrustedInstaller change it.
		{"programfiles.sddl", RuleAncestor, true},
		{"programfiles.sddl", RuleStrict, true},
		{"programfiles-restow-bin.sddl", RuleStrict, true},
		// C:\Windows\Temp: Users create files; never an object, fine above.
		{"windows-temp.sddl", RuleStrict, false},
		{"windows-temp.sddl", RuleAncestor, true},
		{"protected.sddl", RuleStrict, true},
		{"protected.sddl", RulePrivate, true},
		{"programfiles-restow-bin.sddl", RulePrivate, false},
		{"user-owned.sddl", RuleAncestor, false},
		{"users-modify.sddl", RuleAncestor, false},
		{"users-modify.sddl", RuleStrict, false},
	}
	for _, c := range cases {
		reason := EvaluateACL(loadSDDL(t, c.file), c.rule, trusted)
		if (reason == "") != c.ok {
			t.Errorf("%s with rule %d: reason %q, want trusted=%v", c.file, c.rule, reason, c.ok)
		}
	}
}

func TestACLDevUserIsTrusted(t *testing.T) {
	info := loadSDDL(t, "user-owned.sddl")
	if EvaluateACL(info, RuleStrict, TrustedSIDs()) == "" {
		t.Fatal("a user-owned folder must not be trusted")
	}
	if r := EvaluateACL(info, RuleStrict, TrustedSIDs("S-1-5-21-1004336348-1177238915-682003330-1001")); r != "" {
		t.Fatalf("the development user's own folder: %s", r)
	}
}

func TestACLDetails(t *testing.T) {
	trusted := TrustedSIDs()
	for _, c := range []struct {
		sddl string
		rule ACLRule
		ok   bool
	}{
		{"O:SYD:NO_ACCESS_CONTROL", RuleAncestor, false},         // NULL DACL
		{"O:SY", RuleAncestor, false},                            // DACL not read
		{"O:SYD:P", RuleStrict, true},                            // empty DACL grants nothing
		{"O:SYD:(A;;GW;;;BU)", RuleStrict, false},                // generic write maps to write data
		{"O:SYD:(A;;GW;;;BU)", RuleAncestor, false},              // generic write is refused under every rule set
		{"O:SYD:(A;OICIIO;GA;;;BU)", RuleStrict, true},           // inherit-only does not apply
		{"O:SYD:(D;;FA;;;BU)", RuleStrict, true},                 // deny entries never grant
		{"O:SYD:(A;;WD;;;BU)", RuleAncestor, false},              // change permissions
		{"O:SYD:(A;;WO;;;WD)", RuleAncestor, false},              // take ownership, Everyone
		{"O:SYD:(A;;SD;;;AU)", RuleAncestor, false},              // delete
		{"O:SYD:(A;;0x40;;;AU)", RuleAncestor, false},            // delete child
		{"O:SYD:(A;;0x116;;;BU)", RuleAncestor, true},            // add file/folder, attributes
		{"O:SYD:(A;;0x6;;;BU)", RuleRestoreParent, true},         // add file/folder only
		{"O:SYD:(A;;0x10;;;BU)", RuleRestoreParent, false},       // write extended attributes
		{"O:SYD:(A;;FR;;;BU)", RulePrivate, false},               // read
		{"O:SYD:(A;;FA;;;CO)", RuleStrict, false},                // CREATOR OWNER, effective
		{"O:BUD:(A;;FA;;;SY)", RuleAncestor, false},              // untrusted owner
		{"O:S-1-5-32-544D:(A;;FA;;;S-1-5-18)", RuleStrict, true}, // SIDs instead of aliases
		{"O:SYG:SYD:PAI(A;;FA;;;SY)S:AI(AU;FA;FA;;;WD)", RuleStrict, true},
	} {
		info, err := ParseSDDL(c.sddl)
		if err != nil {
			t.Fatalf("%s: %v", c.sddl, err)
		}
		if reason := EvaluateACL(info, c.rule, trusted); (reason == "") != c.ok {
			t.Errorf("%s rule %d: reason %q, want trusted=%v", c.sddl, c.rule, reason, c.ok)
		}
	}
}

func TestParseSDDLErrors(t *testing.T) {
	for _, s := range []string{"X:SY", "O:SYD:(A;;ZZ;;;BU)", "O:SYD:(A;;FA;;;BU", "O:SYD:(A;FA)"} {
		if _, err := ParseSDDL(s); err == nil {
			t.Errorf("%q: no error", s)
		}
	}
}
