package core

import (
	"errors"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/restic"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

func TestConsistencyOf(t *testing.T) {
	vss := snapshotPlan{method: api.SnapshotMethodVSS, requested: true, volumes: []string{`C:\`, `D:\`}, excluded: []string{`E:\`}}
	cases := []struct {
		name        string
		plan        snapshotPlan
		out         restic.SnapshotOutcome
		unavailable bool
		want        api.Consistency
	}{
		{"no snapshot on this system", snapshotPlan{}, restic.SnapshotOutcome{}, false, api.Consistency{State: "off"}},
		{"switched off on Windows", snapshotPlan{method: "vss"}, restic.SnapshotOutcome{}, false, api.Consistency{Method: "vss", State: "off"}},
		{"used; an excluded and an unsupported volume do not count", vss,
			restic.SnapshotOutcome{Requested: true, SkippedVolumes: []string{`F:\`}}, false,
			api.Consistency{Method: "vss", State: "used", LiveFilesystems: []string{`F:\`, `E:\`}}},
		{"one volume failed", vss,
			restic.SnapshotOutcome{Requested: true, FailedVolumes: []restic.VolumeFailure{{Volume: `D:\`}}}, false,
			api.Consistency{Method: "vss", State: "partial", LiveFilesystems: []string{`D:\`, `E:\`}}},
		{"every volume failed", vss,
			restic.SnapshotOutcome{Requested: true, FailedVolumes: []restic.VolumeFailure{{Volume: `c:\`}, {Volume: `D:\`}}}, false,
			api.Consistency{Method: "vss", State: "unavailable", LiveFilesystems: []string{`c:\`, `D:\`, `E:\`}}},
		{"volumes unknown: partial", snapshotPlan{method: "vss", requested: true},
			restic.SnapshotOutcome{Requested: true, FailedVolumes: []restic.VolumeFailure{{Volume: `C:\`}}}, false,
			api.Consistency{Method: "vss", State: "partial", LiveFilesystems: []string{`C:\`}}},
		{"only an excluded volume (exFAT disk): no shadow copy at all",
			snapshotPlan{method: "vss", requested: true, excluded: []string{`E:\`}},
			restic.SnapshotOutcome{Requested: true}, false,
			api.Consistency{Method: "vss", State: "unavailable", LiveFilesystems: []string{`E:\`}}},
		{"every volume not supported by the provider", snapshotPlan{method: "vss", requested: true, volumes: []string{`D:\`}},
			restic.SnapshotOutcome{Requested: true, SkippedVolumes: []string{`d:\`}}, false,
			api.Consistency{Method: "vss", State: "unavailable", LiveFilesystems: []string{`d:\`}}},
		{"C: from a shadow copy, E: (exFAT) live", snapshotPlan{method: "vss", requested: true, volumes: []string{`C:\`}, excluded: []string{`E:\`}},
			restic.SnapshotOutcome{Requested: true}, false,
			api.Consistency{Method: "vss", State: "used", LiveFilesystems: []string{`E:\`}}},
		{"one volume failed, the other skipped: none from a shadow copy", vss,
			restic.SnapshotOutcome{Requested: true, FailedVolumes: []restic.VolumeFailure{{Volume: `C:\`}}, SkippedVolumes: []string{`D:\`}}, false,
			api.Consistency{Method: "vss", State: "unavailable", LiveFilesystems: []string{`C:\`, `D:\`, `E:\`}}},
		{"excluded volume and a source of unknown volume: may be snapshotted",
			snapshotPlan{method: "vss", requested: true, excluded: []string{`E:\`}, volumesUnknown: true},
			restic.SnapshotOutcome{Requested: true}, false,
			api.Consistency{Method: "vss", State: "used", LiveFilesystems: []string{`E:\`}}},
		{"unusable", vss, restic.SnapshotOutcome{}, true, api.Consistency{Method: "vss", State: "unavailable"}},
		{"no rights", snapshotPlan{method: "vss", unavailable: "no rights"}, restic.SnapshotOutcome{}, false,
			api.Consistency{Method: "vss", State: "unavailable"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := consistencyOf(tc.plan, tc.out, tc.unavailable)
			if !reflect.DeepEqual(*got, tc.want) {
				t.Fatalf("got %+v, want %+v", *got, tc.want)
			}
		})
	}
	// The list is bounded.
	many := restic.SnapshotOutcome{Requested: true}
	for i := 0; i < 40; i++ {
		many.SkippedVolumes = append(many.SkippedVolumes, `\\?\Volume{`+strings.Repeat("a", i+1)+`}\`)
	}
	if got := consistencyOf(vss, many, false); len(got.LiveFilesystems) != api.MaxLiveFilesystems {
		t.Fatalf("%d", len(got.LiveFilesystems))
	}
}

func TestSnapshotRunErrors(t *testing.T) {
	out := restic.SnapshotOutcome{
		FailedVolumes: []restic.VolumeFailure{{Volume: `C:\`, Message: "failed to create snapshot for [c:\\]: timeout"}},
		CleanupFailed: []restic.VolumeFailure{{Volume: `D:\`, Message: "failed to delete VSS snapshot: busy"}},
	}
	f, mw := snapshotFailedErrors(out, false)
	if mw || len(f) != 1 || f[0].Code != "snapshot_failed" || f[0].Path != `C:\` || !strings.Contains(f[0].Message, "live file system") {
		t.Fatalf("%+v", f)
	}
	if s, _ := snapshotFailedErrors(out, true); !strings.Contains(s[0].Message, "stopped") {
		t.Fatalf("%+v", s)
	}
	// The service is disabled: one permanent snapshot_unavailable for both
	// volumes, not two transient snapshot_failed (K103).
	disabled := restic.SnapshotOutcome{FailedVolumes: []restic.VolumeFailure{
		{Volume: `C:\`, Message: "failed to create snapshot for [c:\\]: VSS error: InitializeForBackup() failed: UNKNOWN (0x80070422)"},
		{Volume: `D:\`, Message: "failed to create snapshot for [d:\\]: VSS error: InitializeForBackup() failed: UNKNOWN (0x80070422)"},
	}}
	for _, stopped := range []bool{false, true} {
		f, mw = snapshotFailedErrors(disabled, stopped)
		if !mw || len(f) != 1 || f[0].Code != "snapshot_unavailable" || f[0].Path != "" ||
			!strings.Contains(f[0].Message, "service (VSS) is disabled") || !strings.Contains(f[0].Message, `C:\, D:\`) ||
			!strings.Contains(f[0].Message, map[bool]string{false: "ran without it", true: "stopped"}[stopped]) {
			t.Fatalf("stopped %v: %+v", stopped, f)
		}
	}
	c := snapshotCleanupErrors(out)
	if len(c) != 1 || c[0].Code != "snapshot_cleanup_failed" || c[0].Path != `D:\` {
		t.Fatalf("%+v", c)
	}
	u := snapshotUnavailableError("VSS error: E_ACCESSDENIED", true)
	if u.Code != "snapshot_unavailable" || !strings.Contains(u.Message, "ran without it") {
		t.Fatalf("%+v", u)
	}
}

func TestVSSExcludeReason(t *testing.T) {
	cases := []struct {
		drive uint32
		fs    string
		want  string
	}{
		{winapi.DriveFixed, "NTFS", ""},
		{winapi.DriveFixed, "ReFS", ""},
		{winapi.DriveFixed, "", ""},
		{winapi.DriveFixed, "FAT32", "file system FAT32"},
		{winapi.DriveFixed, "exFAT", "file system exFAT"},
		{winapi.DriveRemovable, "NTFS", "removable drive"},
		{winapi.DriveCDROM, "CDFS", "optical drive"},
		{winapi.DriveRemote, "NTFS", "network drive"},
	}
	for _, tc := range cases {
		if got := vssExcludeReason(tc.drive, tc.fs); got != tc.want {
			t.Errorf("%d %s: %q, want %q", tc.drive, tc.fs, got, tc.want)
		}
	}
}

func TestOwnFormSources(t *testing.T) {
	paths := []string{"/etc", `C:\Users`, "d:/data", `\\nas\share`, "/home", "relative"}
	own, foreign := ownFormSources(paths, true)
	if !reflect.DeepEqual(own, []string{`C:\Users`, "d:/data", `\\nas\share`, "relative"}) || !reflect.DeepEqual(foreign, []string{"/etc", "/home"}) {
		t.Fatalf("windows: %q %q", own, foreign)
	}
	own, foreign = ownFormSources(paths, false)
	if !reflect.DeepEqual(own, []string{"/etc", "/home", "relative"}) || !reflect.DeepEqual(foreign, []string{`C:\Users`, "d:/data", `\\nas\share`}) {
		t.Fatalf("unix: %q %q", own, foreign)
	}
}

func TestSnapshotPathOf(t *testing.T) {
	for in, want := range map[string]string{`C:\Users`: "/C/Users", `c:\Users\anna`: "/C/Users/anna", `D:\`: "/D/", `C:`: "/C"} {
		if got := snapshotPathOf(in, true); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
	if got := snapshotPathOf("/srv/data", false); got != "/srv/data" {
		t.Fatal(got)
	}
	// The ransomware signals compare snapshot paths with the sources.
	within := underSourcesFor([]string{`c:\Users`}, true)
	if !within("/C/Users/anna/a.txt") || within("/C/Windows/x") {
		t.Fatal("underSources does not match Windows snapshot paths")
	}
}

// The samples for restore tests and the entropy of the ransomware signals
// read the files a snapshot names on the machine: on Windows /C/Users/... has
// to become C:\Users\... again, else every file is "missing" there.
func TestSnapshotToLocalPathIsTheInverseOfSnapshotPathOf(t *testing.T) {
	for _, local := range []string{
		`C:\Users\bob\a.docx`, `D:\`, `E:\Daten\Größe & Preis\Ünïcødé 名前.txt`, `C:\Program Files (x86)\x y\z`, `\\nas\share\a.txt`,
	} {
		snap := snapshotPathOf(local, true)
		if got := snapshotToLocalPathFor(snap, true); got != local {
			t.Errorf("%q -> %q -> %q", local, snap, got)
		}
	}
	for snap, want := range map[string]string{
		"/C":                  `C:\`,
		"/c/users/x":          `C:\users\x`,
		"/CD/x":               `\CD\x`, // not a drive letter
		`//nas/share/a.txt`:   `\\nas\share\a.txt`,
		"/1/x":                `\1\x`,
		"/C/Users/bob/a.docx": `C:\Users\bob\a.docx`,
	} {
		if got := snapshotToLocalPathFor(snap, true); got != want {
			t.Errorf("%q: %q, want %q", snap, got, want)
		}
	}
	if got := snapshotToLocalPathFor("/srv/data/a.txt", false); got != filepath.FromSlash("/srv/data/a.txt") {
		t.Fatal(got)
	}
	if runtime.GOOS == "windows" && snapshotToLocalPath("/C/Users/a.txt") != `C:\Users\a.txt` {
		t.Fatal("snapshotToLocalPath does not use the Windows form on Windows")
	}
}

// fakeVolumes is a machine's volumes for planVolumes.
type fakeVolumes struct {
	volumeOf map[string]string   // source -> its volume's mount point
	mounts   map[string][]string // drive root -> folders other volumes are mounted at
	ids      map[string]string   // mount point -> volume GUID path
	fs       map[string]string   // mount point or GUID path -> file system
	drive    map[string]uint32   // mount point or GUID path -> drive type
	asked    []string            // drive roots whose mount points were listed
	mountErr error
}

func (f *fakeVolumes) VolumePathName(p string) (string, error) {
	if v, ok := f.volumeOf[p]; ok {
		return v, nil
	}
	return "", errors.New("no such path")
}
func (f *fakeVolumes) DriveType(root string) uint32 {
	if d, ok := f.drive[root]; ok {
		return d
	}
	return winapi.DriveFixed
}
func (f *fakeVolumes) FileSystem(root string) (string, error) {
	if s, ok := f.fs[root]; ok {
		return s, nil
	}
	return "NTFS", nil
}
func (f *fakeVolumes) VolumeName(mp string) (string, error) {
	if id, ok := f.ids[mp]; ok {
		return id, nil
	}
	return "", errors.New("not a mount point")
}
func (f *fakeVolumes) MountPoints(root string) ([]string, error) {
	f.asked = append(f.asked, root)
	if f.mountErr != nil {
		return nil, f.mountErr
	}
	return f.mounts[root], nil
}

// A volume VSS cannot snapshot, mounted in a folder below a source, is read
// live by restic without a word: the plan excludes it by its volume and
// names it among the volumes read live (K102).
func TestPlanVolumesMountedFolders(t *testing.T) {
	const archive, projects, usb = `\\?\Volume{aaaa}\`, `\\?\Volume{bbbb}\`, `\\?\Volume{cccc}\`
	sys := &fakeVolumes{
		volumeOf: map[string]string{`C:\Data`: `C:\`, `c:/Users`: `C:\`, `E:\Stick`: `E:\`},
		mounts: map[string][]string{
			`C:\`: {`Data\Archive\`, `Data\Projects\`, `Other\Usb\`, `Data\Card\`},
			`E:\`: {`x\`},
		},
		ids: map[string]string{`C:\Data\Archive\`: archive, `C:\Data\Projects\`: projects, `C:\Other\Usb\`: usb},
		fs:  map[string]string{archive: "exFAT", usb: "FAT32"},
		// No volume GUID path known: the folder itself is asked and excluded.
		drive: map[string]uint32{`E:\`: winapi.DriveRemovable, `C:\Data\Card\`: winapi.DriveRemovable},
	}
	p := snapshotPlan{method: api.SnapshotMethodVSS, requested: true}
	planVolumes(&p, sys, []string{`C:\Data`, `c:/Users`, `E:\Stick`})
	if !reflect.DeepEqual(p.volumes, []string{`C:\`}) {
		t.Fatalf("volumes %q", p.volumes)
	}
	if want := []string{`E:\`, `C:\Data\Archive\`, `C:\Data\Card\`}; !reflect.DeepEqual(p.excluded, want) {
		t.Fatalf("excluded %q, want %q", p.excluded, want)
	}
	// restic gets the mounted folder's volume GUID path, not its name.
	if want := []string{`E:\`, archive, `C:\Data\Card\`}; !reflect.DeepEqual(p.vssExclude, want) {
		t.Fatalf("vssExclude %q, want %q", p.vssExclude, want)
	}
	// E:\ is read live as a whole: its folders are not looked at; C:\ once.
	if !reflect.DeepEqual(sys.asked, []string{`C:\`}) {
		t.Fatalf("mount points listed for %q", sys.asked)
	}
	notes := strings.Join(p.notes, "\n")
	if !strings.Contains(notes, `C:\Data\Archive\ (a volume mounted in a folder) is read without a shadow copy: file system exFAT`) || strings.Contains(notes, "Usb") || strings.Contains(notes, "Projects") {
		t.Fatalf("notes:\n%s", notes)
	}
	// The report: C:\ from a shadow copy, the mounted exFAT folder live.
	c := consistencyOf(p, restic.SnapshotOutcome{Requested: true}, false)
	if c.State != api.ConsistencyUsed || !reflect.DeepEqual(c.LiveFilesystems, []string{`E:\`, `C:\Data\Archive\`, `C:\Data\Card\`}) {
		t.Fatalf("consistency %+v", c)
	}
	// The whole drive as a source: every mounted folder on it counts.
	p = snapshotPlan{method: api.SnapshotMethodVSS, requested: true}
	sys.volumeOf[`C:\`] = `C:\`
	planVolumes(&p, sys, []string{`C:\`})
	if want := []string{`C:\Data\Archive\`, `C:\Other\Usb\`, `C:\Data\Card\`}; !reflect.DeepEqual(p.excluded, want) {
		t.Fatalf("whole drive: excluded %q, want %q", p.excluded, want)
	}
	// Mount points that cannot be listed: a note, nothing else changes.
	sys.mountErr = errors.New("access denied")
	p = snapshotPlan{method: api.SnapshotMethodVSS, requested: true}
	planVolumes(&p, sys, []string{`C:\Data`})
	if !reflect.DeepEqual(p.volumes, []string{`C:\`}) || len(p.excluded) != 0 || !strings.Contains(strings.Join(p.notes, "\n"), "could not be listed (access denied)") {
		t.Fatalf("listing failed: %+v", p)
	}
}
