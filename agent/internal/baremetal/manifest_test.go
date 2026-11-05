package baremetal

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the golden files in testdata")

const manifestDir = "testdata/manifests"

// validExamples are the hand-built manifests of the shared test data.
func validExamples() map[string]*Manifest {
	return map[string]*Manifest{
		"example-debian12-uefi-luks-lvm": exampleDebian(),
		"example-bios-mdadm-btrfs":       exampleBIOS(),
		"example-container":              exampleContainer(),
		"darwin-minimal":                 exampleDarwin(),
	}
}

// invalidExamples are manifests both languages must reject, as the bytes
// to write (not all of them can be encoded canonically).
func invalidExamples(t *testing.T) map[string][]byte {
	t.Helper()
	enc := func(m *Manifest) []byte {
		m.normalize()
		b, err := Canonical(m)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	replace := func(b []byte, old, new string) []byte {
		if !bytes.Contains(b, []byte(old)) {
			t.Fatalf("%q not in the example", old)
		}
		return bytes.Replace(b, []byte(old), []byte(new), 1)
	}
	base := enc(exampleDebian())
	out := map[string][]byte{}
	// A label with an escape sequence (written as \u001b, as JSON requires).
	out["invalid-control-char"] = replace(base, `"label":"home"`, `"label":"home\u001b[2K"`)
	// U+2028 is valid JSON but not a valid manifest string.
	out["invalid-u2028"] = replace(base, `"label":"home"`, "\"label\":\"ho me\"")
	// A Linux manifest with a darwin key.
	out["invalid-both-platforms"] = replace(base, `"md":[]`, `"macos":{"productVersion":"15.1"},"md":[]`)
	// "disks" is required.
	var tree map[string]any
	if err := json.Unmarshal(base, &tree); err != nil {
		t.Fatal(err)
	}
	delete(tree, "disks")
	if b, err := Canonical(tree); err == nil {
		out["invalid-missing-required"] = b
	} else {
		t.Fatal(err)
	}
	// The PV sits on c0 and c0 on the root LV of that VG: a cycle.
	out["invalid-blockref-cycle"] = replace(base, `"device":{"disk":"d0","kind":"partition","number":3}`, `"device":{"kind":"lv","lv":"root","vg":"vg0"}`)
	// A partition that does not exist.
	out["invalid-blockref-dangling"] = replace(base, `"device":{"disk":"d0","kind":"partition","number":3}`, `"device":{"disk":"d0","kind":"partition","number":9}`)
	out["invalid-negative-int"] = replace(base, `"sizeBytes":536870912,"type":"vfat"`, `"sizeBytes":-1,"type":"vfat"`)
	out["invalid-float"] = replace(base, `"sizeBytes":536870912,"type":"vfat"`, `"sizeBytes":536870912.5,"type":"vfat"`)
	out["invalid-too-large"] = enc(exampleTooLarge())
	return out
}

// capturedManifests are the expected manifests of the capture fixtures.
func capturedManifests(t *testing.T) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	dirs, _ := filepath.Glob("testdata/capture/*/expected.json")
	for _, p := range dirs {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		out[filepath.Base(filepath.Dir(p))] = bytes.TrimRight(b, "\n")
	}
	return out
}

func writeGolden(t *testing.T, name string, b []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(manifestDir, name), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func regenerateManifests(t *testing.T) {
	t.Helper()
	if err := os.MkdirAll(manifestDir, 0o755); err != nil {
		t.Fatal(err)
	}
	old, _ := filepath.Glob(filepath.Join(manifestDir, "*"))
	for _, p := range old {
		_ = os.Remove(p)
	}
	valid := map[string][]byte{}
	for name, m := range validExamples() {
		b, err := m.Encode()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		valid[name] = b
	}
	for name, b := range capturedManifests(t) {
		valid[name] = b
	}
	for name, b := range valid {
		m, err := Decode(b)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		writeGolden(t, name+".json", b)
		writeGolden(t, name+".sha256", []byte(sha256Hex(b)+"\n"))
		if m.Platform == PlatformLinux {
			fp, err := LayoutFingerprint(m)
			if err != nil {
				t.Fatal(err)
			}
			writeGolden(t, name+".fingerprint", []byte(fp+"\n"))
		}
	}
	for name, b := range invalidExamples(t) {
		writeGolden(t, name+".json", b)
	}
}

func TestManifests(t *testing.T) {
	if *update {
		regenerateManifests(t)
	}
	files, _ := filepath.Glob(filepath.Join(manifestDir, "*.json"))
	sort.Strings(files)
	if len(files) < 10 {
		t.Fatalf("only %d manifests in %s (run with -update)", len(files), manifestDir)
	}
	valid := 0
	for _, p := range files {
		name := strings.TrimSuffix(filepath.Base(p), ".json")
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		t.Run(name, func(t *testing.T) {
			m, err := Decode(b)
			if strings.HasPrefix(name, "invalid-") {
				if err == nil {
					t.Fatalf("accepted")
				}
				if name == "invalid-too-large" && !errors.Is(err, ErrTooLarge) {
					t.Fatalf("too large: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("rejected: %v", err)
			}
			valid++
			again, err := m.Encode()
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			if !bytes.Equal(again, b) {
				t.Fatalf("encode(decode(file)) differs from the file:\n%s\n%s", again, b)
			}
			sum, err := os.ReadFile(strings.TrimSuffix(p, ".json") + ".sha256")
			if err != nil || strings.TrimSpace(string(sum)) != sha256Hex(b) {
				t.Fatalf("sha256 file: %q %v, want %s", sum, err, sha256Hex(b))
			}
			fpFile := strings.TrimSuffix(p, ".json") + ".fingerprint"
			if m.Platform != PlatformLinux {
				if _, err := LayoutFingerprint(m); err == nil {
					t.Fatalf("darwin fingerprint is M6")
				}
				return
			}
			fp, err := LayoutFingerprint(m)
			if err != nil {
				t.Fatal(err)
			}
			want, err := os.ReadFile(fpFile)
			if err != nil || strings.TrimSpace(string(want)) != fp {
				t.Fatalf("fingerprint file: %q %v, want %s", want, err, fp)
			}
			// The canonical bytes are byte-identical to a generic round trip.
			var generic any
			if err := json.Unmarshal(b, &generic); err != nil {
				t.Fatal(err)
			}
		})
	}
	if valid == 0 {
		t.Fatal("no valid manifests")
	}
}

func TestManifestEncodeTooLarge(t *testing.T) {
	b, err := exampleTooLarge().Encode()
	if !errors.Is(err, ErrTooLarge) || len(b) <= MaxLayoutBytes {
		t.Fatalf("%d bytes, %v", len(b), err)
	}
}

func TestValidateRejects(t *testing.T) {
	cases := map[string]func(m *Manifest){
		"bad disk id":     func(m *Manifest) { m.Linux.Disks[0].ID = "disk0" },
		"bad enum":        func(m *Manifest) { m.Linux.Firmware.Mode = "efi" },
		"two grow":        func(m *Manifest) { m.Linux.Disks[0].Table.Partitions[0].Grow = boolPtr(true) },
		"grow false":      func(m *Manifest) { m.Linux.Disks[0].Table.Partitions[2].Grow = boolPtr(false) },
		"dangling fs":     func(m *Manifest) { m.Linux.Mounts[0].FS = strPtr("f9") },
		"dangling esp":    func(m *Manifest) { m.Linux.Bootloader.ESPs = []string{"f7"} },
		"bad ref shape":   func(m *Manifest) { m.Linux.LUKS[0].Device = BlockRef{Kind: RefDisk, Disk: "d0", Number: 3} },
		"bad live reason": func(m *Manifest) { m.Linux.Backup.LiveReasons["/"] = "busy" },
		"bad priority":    func(m *Manifest) { m.Linux.Swap[0].Priority = "high" },
		"long string":     func(m *Manifest) { m.Linux.OS.Kernel = strings.Repeat("x", 4097) },
		"long sbat":       func(m *Manifest) { m.Linux.Firmware.SbatLevel = []string{strings.Repeat("x", 257)} },
		"control in key":  func(m *Manifest) { m.Linux.Backup.FSSnapshots["/a\rb"] = "live" },
		"del char":        func(m *Manifest) { m.Hostname = "a\x7fb" },
		"c1 char":         func(m *Manifest) { m.Hostname = "a\u0085b" },
		"u2029":           func(m *Manifest) { m.Hostname = "a b" },
		"bad utf8":        func(m *Manifest) { m.Hostname = "a\xffb" },
		"captured at":     func(m *Manifest) { m.CapturedAt = "2026-11-04T21:00:03.5Z" },
		"both":            func(m *Manifest) { m.Darwin = exampleDarwin().Darwin },
		"swap index":      func(m *Manifest) { m.Linux.Fstab[4].Resolved = &FstabResolved{Swap: intPtr(3)} },
		"resolved two":    func(m *Manifest) { m.Linux.Fstab[0].Resolved.Swap = intPtr(0) },
		"too many disks":  func(m *Manifest) { m.Linux.Network = make([]NetInterface, 65) },
		"negative size":   func(m *Manifest) { m.Linux.Disks[0].SizeBytes = -5 },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			m := exampleDebian()
			mutate(m)
			if _, err := m.Encode(); err == nil {
				t.Fatal("accepted")
			}
		})
	}
	if _, err := exampleDebian().Encode(); err != nil {
		t.Fatalf("the example itself: %v", err)
	}
}

func TestCanonical(t *testing.T) {
	got, err := Canonical(map[string]any{"b": 1, "a": []any{"x<y>&z", true, nil}, "é": "\"\\", "Z": map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"Z":{},"a":["x<y>&z",true,null],"b":1,"é":"\"\\"}`
	if string(got) != want {
		t.Fatalf("%s\nwant %s", got, want)
	}
	for _, bad := range []string{`1.5`, `-1`, `1e3`, `9007199254740992`, `"a\u0001"`, `" "`, `"\ud800"`} {
		if _, err := Canonical(json.RawMessage(bad)); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
	if _, err := Canonical(json.RawMessage(`9007199254740991`)); err != nil {
		t.Fatal(err)
	}
}

func TestDecodeRequiresFields(t *testing.T) {
	b, _ := exampleDebian().Encode()
	for _, mut := range []struct{ old, new string }{
		{`"kname":"nvme0n1"`, `"kname":null`},
		{`"hostname":"srv01",`, ``},
		{`,"zoned":"none"`, ``},
		{`"model":"Samsung SSD 980 PRO 512GB",`, ``},
	} {
		x := bytes.Replace(b, []byte(mut.old), []byte(mut.new), 1)
		if bytes.Equal(x, b) {
			t.Fatalf("%s not found", mut.old)
		}
		if _, err := Decode(x); err == nil {
			t.Errorf("%s -> %s accepted", mut.old, mut.new)
		}
	}
	// Unknown keys pass (later schema versions add fields).
	x := bytes.Replace(b, []byte(`"md":[]`), []byte(`"md":[],"zfuture":{"x":1}`), 1)
	if _, err := Decode(x); err != nil {
		t.Fatalf("unknown key: %v", err)
	}
}
