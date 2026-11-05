package recovery

import (
	"strings"
	"testing"
)

const fullAnswers = `{
  "format": "restow-answers-v1",
  "instanceUrl": "https://restow.example.com",
  "code": "RC-0A1B2-C3D4E-F5G6H-J7K8M-N9P0Q",
  "caFile": "/run/restow-recovery/media/ca.pem",
  "spkiCheck": "ABCD-EFGH-JKMN-PQRS",
  "snapshotId": "4f2a9c1d",
  "keymap": "de",
  "language": "de",
  "network": { "mode": "static", "interface": "enp1s0", "address": "192.0.2.10/24",
               "gateway": "192.0.2.1", "dns": ["192.0.2.53"], "proxy": "http://192.0.2.5:3128" },
  "diskMapping": { "d0": "serial.restow-e2e-target0" },
  "adopt": ["md1"],
  "shrink": "none",
  "passphrase": "correct-horse-battery",
  "keyFiles": "regenerate",
  "confirmErase": ["serial.restow-e2e-target0"],
  "renameNics": true,
  "rawLvs": "skip",
  "secureBootOff": false,
  "rebindToken": "rset_abc",
  "afterSuccess": "poweroff"
}`

func TestAnswersFromFWCfg(t *testing.T) {
	a, err := LoadAnswers(SourceFWCfg, []byte(fullAnswers), true)
	if err != nil {
		t.Fatal(err)
	}
	if a.DiskMapping.Map["d0"] != "serial.restow-e2e-target0" || a.Network.Proxy == "" || a.Passphrase == "" || a.AfterSuccess != "poweroff" {
		t.Errorf("parsed: %+v", a)
	}
	// fw_cfg outside QEMU is never read.
	if _, err := LoadAnswers(SourceFWCfg, []byte(fullAnswers), false); err == nil {
		t.Error("fw_cfg accepted outside QEMU")
	}
}

func TestAnswersSourceRules(t *testing.T) {
	for _, src := range []Source{SourceMedia, SourceFile} {
		if _, err := LoadAnswers(src, []byte(fullAnswers), true); err == nil || !strings.Contains(err.Error(), "code") {
			t.Errorf("%s: code and passphrase accepted: %v", src, err)
		}
	}
	clean := strings.NewReplacer(`"code": "RC-0A1B2-C3D4E-F5G6H-J7K8M-N9P0Q",`, "", `"passphrase": "correct-horse-battery",`, "", `"rebindToken": "rset_abc",`, "").Replace(fullAnswers)
	if _, err := LoadAnswers(SourceMedia, []byte(clean), false); err != nil {
		t.Errorf("medium without secrets: %v", err)
	}
	httpURL := strings.Replace(clean, "https://restow.example.com", "http://192.0.2.1:3000", 1)
	if _, err := LoadAnswers(SourceFile, []byte(httpURL), true); err == nil {
		t.Error("http:// accepted from a file")
	}
	if _, err := LoadAnswers(SourceFWCfg, []byte(httpURL), true); err != nil {
		t.Errorf("http:// from fw_cfg in QEMU: %v", err)
	}
	probe := strings.Replace(clean, `"afterSuccess"`, `"probe": {"x": 1}, "afterSuccess"`, 1)
	if _, err := LoadAnswers(SourceFWCfg, []byte(probe), true); err == nil || !strings.Contains(err.Error(), "newer ISO") {
		t.Errorf("probe: %v", err)
	}
	unknown := strings.Replace(clean, `"afterSuccess"`, `"surprise": true, "afterSuccess"`, 1)
	if _, err := LoadAnswers(SourceFWCfg, []byte(unknown), true); err == nil {
		t.Error("an unknown key was accepted")
	}
	for name, bad := range map[string]string{
		"format":      strings.Replace(clean, "restow-answers-v1", "restow-answers-v2", 1),
		"mapping":     strings.Replace(clean, `"serial.restow-e2e-target0" }`, `"/dev/sda" }`, 1),
		"confirm":     strings.Replace(clean, `"confirmErase": ["serial.restow-e2e-target0"]`, `"confirmErase": ["sda"]`, 1),
		"keymap":      strings.Replace(clean, `"keymap": "de"`, `"keymap": "dvorak"`, 1),
		"proxy":       strings.Replace(clean, "http://192.0.2.5:3128", "http://user:pw@192.0.2.5:3128", 1),
		"dns":         strings.Replace(clean, `["192.0.2.53"]`, `["a","b","c","d"]`, 1),
		"after":       strings.Replace(clean, `"poweroff"`, `"halt"`, 1),
		"no mapping":  strings.Replace(clean, `"diskMapping": { "d0": "serial.restow-e2e-target0" },`, "", 1),
		"bad mapping": strings.Replace(clean, `"diskMapping": { "d0": "serial.restow-e2e-target0" }`, `"diskMapping": "manual"`, 1),
	} {
		if _, err := LoadAnswers(SourceFWCfg, []byte(bad), true); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	auto := strings.Replace(clean, `"diskMapping": { "d0": "serial.restow-e2e-target0" }`, `"diskMapping": "auto"`, 1)
	a, err := LoadAnswers(SourceFile, []byte(auto), false)
	if err != nil || !a.DiskMapping.Auto {
		t.Errorf("auto mapping: %v", err)
	}
	if _, err := LoadAnswers(SourceFile, []byte(strings.Repeat(" ", MaxAnswersBytes+1)), false); err == nil {
		t.Error("an oversized file was accepted")
	}
}

func TestIdentityForms(t *testing.T) {
	for id, ok := range map[string]bool{"wwn.5000c500a1b2c3d4": true, "eui.0025385b71b0e1a2": true, "nguid.abcdef": true,
		"serial.S4EVNX0N-1": true, "path.pci-0000:00:05.0": true, "sda": false, "path./etc": false, "serial.": false} {
		if ValidIdentity(id) != ok {
			t.Errorf("%s: %v", id, !ok)
		}
	}
}

func TestCmdline(t *testing.T) {
	o := ParseCmdline("BOOT_IMAGE=/live/vmlinuz boot=live restow.console=ttyS1 restow.keymap=ch restow.answers=media quiet")
	if o.Console != "/dev/ttyS1" || o.Keymap != "ch" || !o.AnswersMedia {
		t.Errorf("%+v", o)
	}
	o = ParseCmdline("restow.console=tty0 restow.keymap=xx restow.answers=net")
	if o.Console != "" || o.Keymap != "" || o.AnswersMedia {
		t.Errorf("ignored values taken: %+v", o)
	}
}

func TestKeymaps(t *testing.T) {
	for name, want := range map[string][2]string{"de-latin1-nodeadkeys": {"de", "nodeadkeys"}, "sg": {"ch", ""}, "fr_CH": {"ch", "fr"}, "us": {"us", ""}, "uk": {"gb", ""}} {
		l, v, ok := XKBForConsole(name)
		if !ok || l != want[0] || v != want[1] {
			t.Errorf("%s: %s %s %v", name, l, v, ok)
		}
	}
	if _, _, ok := XKBForConsole("Weird-Map-1"); ok {
		t.Error("an unknown keymap was mapped")
	}
	if got := strings.Join(CkbcompArgs("de", "nodeadkeys"), " "); got != "ckbcomp de nodeadkeys" {
		t.Error(got)
	}
}
