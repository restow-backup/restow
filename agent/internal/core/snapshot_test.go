package core

import (
	"reflect"
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
	f := snapshotFailedErrors(out, false)
	if len(f) != 1 || f[0].Code != "snapshot_failed" || f[0].Path != `C:\` || !strings.Contains(f[0].Message, "live file system") {
		t.Fatalf("%+v", f)
	}
	if s := snapshotFailedErrors(out, true); !strings.Contains(s[0].Message, "stopped") {
		t.Fatalf("%+v", s)
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
