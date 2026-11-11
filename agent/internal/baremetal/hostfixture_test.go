package baremetal

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/cmdrun"
)

// A fixture tree must check out on every system: sysfs has names with a
// colon, which Windows refuses, and git keeps no empty directory. DirHost
// reads the stored form and shows the machine's.

func TestFixtureName(t *testing.T) {
	for name, want := range map[string]string{
		"pci0000:00":   "pci0000%3A00",
		"0000:00:17.0": "0000%3A00%3A17.0",
		"253:1":        "253%3A1",
		"etc":          "etc",
		"driver.link":  "driver.link",
		"100%":         "100%25",
		`a<b>c"d|e?f*`: "a%3Cb%3Ec%22d%7Ce%3Ff%2A",
		`back\slash`:   "back%5Cslash",
		"tab\tname":    "tab%09name",
		"dot.":         "dot%2E",
		"space ":       "space%20",
		"NUL":          "%4EUL",
		"com1.txt":     "%63om1.txt",
		"console":      "console",
		".":            ".",
		"..":           "..",
		"a b":          "a b",
		"Boot0001-8be4df61-93ca-11d2-aa0d-00e098032b8c": "Boot0001-8be4df61-93ca-11d2-aa0d-00e098032b8c",
	} {
		got := FixtureName(name)
		if got != want {
			t.Errorf("FixtureName(%q) = %q, want %q", name, got, want)
		}
		if back := fixtureDecode(got); back != name {
			t.Errorf("fixtureDecode(%q) = %q, want %q", got, back, name)
		}
		for _, c := range `:<>"|?*\` {
			if strings.ContainsRune(got, c) {
				t.Errorf("FixtureName(%q) = %q still holds %q", name, got, c)
			}
		}
	}
	// A percent sign that starts no written character stays.
	for _, name := range []string{"50%", "%", "%zz", "%4"} {
		if got := fixtureDecode(name); got != name {
			t.Errorf("fixtureDecode(%q) = %q", name, got)
		}
	}
}

func TestDirHostReadsFixtureNames(t *testing.T) {
	root := filepath.Join(t.TempDir(), "root")
	put := func(p, content string) {
		t.Helper()
		full := FixturePath(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	put("/sys/devices/pci0000:00/0000:00:17.0/modalias", "pci:v00008086\n")
	put("/sys/devices/pci0000:00/0000:00:17.0/driver.link", "/sys/bus/pci/drivers/ahci\n")
	put("/sys/devices/pci0000:00/0000:00:1d.0/modalias", "pci:v0000144D\n")
	put("/sys/dev/block/253:1/dm/name", "vg0-root\n")
	put("/home/"+FixtureKeep, "")
	// Nothing on disk has a name Windows refuses.
	err := filepath.WalkDir(root, func(p string, _ os.DirEntry, err error) error {
		if strings.ContainsAny(filepath.Base(p), `:<>"|?*`) {
			t.Errorf("stored name %s", p)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "sys", "devices", "pci0000%3A00", "0000%3A00%3A17.0", "modalias")); err != nil {
		t.Fatalf("the stored form: %v", err)
	}
	h := DirHost{Root: root}
	if b, err := h.ReadFile("/sys/devices/pci0000:00/0000:00:17.0/modalias", 0); err != nil || string(b) != "pci:v00008086\n" {
		t.Errorf("ReadFile by the machine's path: %q %v", b, err)
	}
	if _, err := h.Lstat("/sys/dev/block/253:1/dm/name"); err != nil {
		t.Errorf("Lstat: %v", err)
	}
	if target, err := h.Readlink("/sys/devices/pci0000:00/0000:00:17.0/driver"); err != nil || target != "/sys/bus/pci/drivers/ahci" {
		t.Errorf("Readlink of a stored link: %q %v", target, err)
	}
	names := func(p string) []string {
		ents, err := h.ReadDir(p)
		if err != nil {
			t.Fatalf("ReadDir %s: %v", p, err)
		}
		var out []string
		for _, e := range ents {
			out = append(out, e.Name())
		}
		return out
	}
	if got := names("/sys/devices/pci0000:00"); !reflect.DeepEqual(got, []string{"0000:00:17.0", "0000:00:1d.0"}) {
		t.Errorf("ReadDir shows %v, want the names of the machine", got)
	}
	if got := names("/sys/devices/pci0000:00/0000:00:17.0"); !reflect.DeepEqual(got, []string{"driver", "modalias"}) {
		t.Errorf("ReadDir shows %v", got)
	}
	if got := names("/sys/dev/block"); !reflect.DeepEqual(got, []string{"253:1"}) {
		t.Errorf("ReadDir shows %v", got)
	}
	// The kept directory exists and is empty.
	if st, err := h.Stat("/home"); err != nil || !st.IsDir() {
		t.Errorf("the kept directory: %v", err)
	}
	if got := names("/home"); len(got) != 0 {
		t.Errorf("the kept directory shows %v", got)
	}
	got, err := h.Glob("/sys/devices/pci0000:00/*/modalias")
	want := []string{"/sys/devices/pci0000:00/0000:00:17.0/modalias", "/sys/devices/pci0000:00/0000:00:1d.0/modalias"}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Errorf("Glob: %v %v, want %v", got, err, want)
	}
	if got, _ := h.Glob("/sys/dev/block/*:*/dm/name"); !reflect.DeepEqual(got, []string{"/sys/dev/block/253:1/dm/name"}) {
		t.Errorf("Glob with a colon in the pattern: %v", got)
	}
	if got, _ := h.Glob("/home/*"); len(got) != 0 {
		t.Errorf("Glob shows the keep file: %v", got)
	}
}

// TestCaptureFixturesAreSelfContained: the tracked fixture trees need
// nothing git does not keep. Every directory of a fixture holds a file
// (an empty one would be missing in a fresh checkout, and the capture
// would then call a tool for a mount point that is not there), and every
// name is in the stored form.
func TestCaptureFixturesAreSelfContained(t *testing.T) {
	dirs, files := 0, 0
	err := filepath.WalkDir(captureDir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if FixtureName(fixtureDecode(d.Name())) != d.Name() {
			t.Errorf("%s: the name is not in the stored form (run the capture test with -update)", p)
		}
		if !d.IsDir() {
			files++
			return nil
		}
		dirs++
		ents, err := os.ReadDir(p)
		if err != nil {
			return err
		}
		if len(ents) == 0 {
			t.Errorf("%s is an empty directory: git does not keep it (run the capture test with -update)", p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if dirs < 100 || files < 1000 {
		t.Fatalf("%d directories and %d files below %s", dirs, files, captureDir)
	}
}

// withoutUdevType is the lsblk recording of a fixture as lsblk prints it
// for devices udev has not seen yet (a file system made a moment ago) or on
// a system without udev: no type, UUID or label.
func withoutUdevType(t *testing.T, f *cmdrun.FakeRunner, dir string, knames ...string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "cmd", "001.out"))
	if err != nil {
		t.Fatal(err)
	}
	var tree map[string]any
	if err := json.Unmarshal(b, &tree); err != nil {
		t.Fatal(err)
	}
	strip := map[string]bool{}
	for _, k := range knames {
		strip[k] = true
	}
	var walk func(nodes []any)
	walk = func(nodes []any) {
		for _, x := range nodes {
			n := x.(map[string]any)
			if strip[n["kname"].(string)] {
				n["fstype"], n["uuid"], n["label"] = nil, nil, nil
			}
			if kids, ok := n["children"].([]any); ok {
				walk(kids)
			}
		}
	}
	walk(tree["blockdevices"].([]any))
	out, _ := json.Marshal(tree)
	f.Add([]string{"lsblk", "-J", "-b", "-O"}, string(out), 0)
}

// TestCaptureMountedWithoutUdevType: lsblk takes the type of a file system
// from the udev database, which lags behind mkfs and is empty without
// udev. A mounted device is then probed with blkid; before, its file system
// was missing from the manifest while its mount stayed, and nothing said
// so (the CI job agent-root: "btrfs subvolume @data/nested missing").
func TestCaptureMountedWithoutUdevType(t *testing.T) {
	const name = "fedora-btrfs-nested-zstd"
	dir := filepath.Join(captureDir, name)
	f, err := cmdrun.LoadDir(t, filepath.Join(dir, "cmd"))
	if err != nil {
		t.Fatal(err)
	}
	withoutUdevType(t, f, dir, "nvme0n1p2", "nvme0n1p3")
	host := ""
	for _, s := range simSystems() {
		if s.Name == name {
			host = s.Hostname
		}
	}
	m, _, err := Capture(context.Background(), captureOptions(f, filepath.Join(dir, "root"), host))
	if err != nil {
		t.Fatal(err)
	}
	// The same manifest as with the udev types; only the raw lsblk output
	// (and so its checksum) differs.
	b, err := os.ReadFile(filepath.Join(dir, "expected.json"))
	if err != nil {
		t.Fatal(err)
	}
	want, err := Decode(bytes.TrimRight(b, "\n"))
	if err != nil {
		t.Fatal(err)
	}
	for _, mm := range []*Manifest{m, want} {
		for i := range mm.Linux.Raw {
			if mm.Linux.Raw[i].Name == "lsblk.json" {
				mm.Linux.Raw[i].SHA256 = ""
			}
		}
	}
	got, _ := m.Encode()
	exp, _ := want.Encode()
	if !bytes.Equal(got, exp) {
		t.Fatalf("the capture without the udev types differs from expected.json:\n%s", got)
	}

	// blkid does not know it either: the capture says so instead of
	// dropping the file system without a word.
	f, err = cmdrun.LoadDir(t, filepath.Join(dir, "cmd"))
	if err != nil {
		t.Fatal(err)
	}
	withoutUdevType(t, f, dir, "nvme0n1p2")
	f.Add([]string{"blkid", "-p", "-o", "export", "/dev/nvme0n1p2"}, "", 2)
	m, _, err = Capture(context.Background(), captureOptions(f, filepath.Join(dir, "root"), host))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, u := range m.Linux.Unsupported {
		if u.Code == CodeCaptureFailed && deref(u.Ref) == "/dev/nvme0n1p2" && strings.Contains(u.Message, "/boot") {
			found = true
		}
	}
	if !found || m.Linux.Verdict == VerdictSupported {
		t.Errorf("a mounted device without a known file system: verdict %s, findings %+v", m.Linux.Verdict, m.Linux.Unsupported)
	}
}
