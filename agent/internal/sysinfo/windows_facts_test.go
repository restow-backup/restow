package sysinfo

import (
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
)

var updateGolden = flag.Bool("update", false, "rewrite the golden files")

// recorded is a machine as testdata/windows records it: registry values by
// key, service accounts by service, the answer of the fixed WMI query.
type recorded struct {
	Description string                    `json:"description"`
	Registry    map[string]map[string]any `json:"registry"`
	Services    map[string]string         `json:"services"`
	WMI         *string                   `json:"wmi"`
	WMIError    string                    `json:"wmiError"`
}

// fakeRegistry answers from the recording; keys and names compare without
// case, as in the registry.
type fakeRegistry struct{ keys map[string]map[string]any }

func newFakeRegistry(r map[string]map[string]any) fakeRegistry {
	f := fakeRegistry{keys: map[string]map[string]any{}}
	for k, vals := range r {
		f.keys[strings.ToLower(k)] = vals
	}
	return f
}

func (f fakeRegistry) value(path, name string) (any, bool) {
	vals, ok := f.keys[strings.ToLower(path)]
	if !ok {
		return nil, false
	}
	for n, v := range vals {
		if strings.EqualFold(n, name) {
			return v, true
		}
	}
	return nil, false
}

func (f fakeRegistry) String(path, name string) (string, bool) {
	v, ok := f.value(path, name)
	s, isString := v.(string)
	return s, ok && isString
}

func (f fakeRegistry) Integer(path, name string) (uint64, bool) {
	v, ok := f.value(path, name)
	n, isNumber := v.(float64)
	return uint64(n), ok && isNumber
}

func (f fakeRegistry) SubKeys(path string) []string {
	prefix := strings.ToLower(path) + `\`
	seen := map[string]bool{}
	var out []string
	for k := range f.keys {
		if rest, ok := strings.CutPrefix(k, prefix); ok {
			first, _, _ := strings.Cut(rest, `\`)
			if !seen[first] {
				seen[first] = true
				out = append(out, first)
			}
		}
	}
	sort.Strings(out)
	return out
}

func (f fakeRegistry) ValueNames(path string) []string {
	var out []string
	for n := range f.keys[strings.ToLower(path)] {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

type fakeServices map[string]string

func (s fakeServices) Account(name string) (string, bool) {
	for n, a := range s {
		if strings.EqualFold(n, name) {
			return a, true
		}
	}
	return "", false
}

// golden is what a recorded machine yields.
type golden struct {
	Description    string `json:"description"`
	OSVersion      string `json:"osVersion"`
	Virtualization string `json:"virtualization"`
	Technology     string `json:"technology"`
	Desktop        bool   `json:"desktop"`
	Windows        any    `json:"windows"`
}

func TestWindowsFactsGolden(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("testdata", "windows", "*.json"))
	if err != nil || len(files) < 6 {
		t.Fatalf("recordings: %v %v", files, err)
	}
	for _, file := range files {
		if strings.HasSuffix(file, ".golden.json") {
			continue
		}
		name := strings.TrimSuffix(filepath.Base(file), ".json")
		t.Run(name, func(t *testing.T) {
			b, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			var rec recorded
			if err := json.Unmarshal(b, &rec); err != nil {
				t.Fatal(err)
			}
			var wmi func() ([]byte, error)
			switch {
			case rec.WMIError != "":
				wmi = func() ([]byte, error) { return nil, errors.New(rec.WMIError) }
			case rec.WMI != nil:
				wmi = func() ([]byte, error) { return []byte(*rec.WMI), nil }
			}
			m := MachineFromWindows(newFakeRegistry(rec.Registry), fakeServices(rec.Services), wmi)
			// The wire form, as the server gets it.
			var wire any
			raw, _ := json.Marshal(m.Windows)
			_ = json.Unmarshal(raw, &wire)
			got, _ := json.MarshalIndent(golden{Description: rec.Description, OSVersion: OSVersionText(m.Windows),
				Virtualization: m.Virtualization, Technology: m.Technology, Desktop: m.Desktop, Windows: wire}, "", "  ")
			path := filepath.Join("testdata", "windows", name+".golden.json")
			if *updateGolden {
				if err := os.WriteFile(path, append(got, '\n'), 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("%v (run with -update)", err)
			}
			if strings.TrimSpace(string(want)) != strings.TrimSpace(string(got)) {
				t.Fatalf("differs from %s\n%s", path, got)
			}
		})
	}
}

func TestWindowsFactsRules(t *testing.T) {
	reg := newFakeRegistry(map[string]map[string]any{
		regCurrentVersion: {"ProductName": "Windows 10 Enterprise\x07", "CurrentBuildNumber": "22631", "InstallationType": "Client", "UBR": float64(1 << 40)},
	})
	f := DetectWindows(reg, fakeServices{}, nil)
	if f.ProductName != "Windows 11 Enterprise" || f.UBR != 0 || f.BitLocker != nil || f.Roles.SQLServer {
		t.Fatalf("%+v", f)
	}
	// Windows 10 stays Windows 10.
	reg = newFakeRegistry(map[string]map[string]any{regCurrentVersion: {"ProductName": "Windows 10 Pro", "CurrentBuildNumber": "19045", "InstallationType": "Client"}})
	if f := DetectWindows(reg, fakeServices{}, nil); f.ProductName != "Windows 10 Pro" {
		t.Fatalf("%+v", f)
	}
	// A WMI answer that is no JSON is an error, not a crash.
	if f := DetectWindows(reg, fakeServices{}, func() ([]byte, error) { return []byte("Zugriff verweigert"), nil }); f.BitLocker.State != "error" {
		t.Fatalf("%+v", f.BitLocker)
	}
	if OSVersionText(&apiWindowsEmpty) != "Windows" {
		t.Fatal(OSVersionText(&apiWindowsEmpty))
	}
	for name, ok := range map[string]bool{"SQLEXPRESS": true, "MSSQLSERVER": true, "_A1$#": true, "1ABC": false, "": false, "a b": false,
		"TOOLONGNAMEFORANINSTANCE": false, `A\B`: false} {
		if ValidSQLInstanceName(name) != ok {
			t.Errorf("ValidSQLInstanceName(%q) != %v", name, ok)
		}
	}
}

var apiWindowsEmpty = api.WindowsFacts{}
