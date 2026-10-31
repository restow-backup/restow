package restic

import (
	"strings"
	"testing"
	"time"
)

// The texts are restic 0.19.1's own formats (internal/fs/fs_local_vss.go and
// internal/fs/vss_windows.go), as restic --json writes them.
func TestClassifySnapshotError(t *testing.T) {
	cases := []struct {
		name, item, msg string
		kind            snapshotKind
		volume          string
	}{
		{"failed", `c:\`, `failed to create snapshot for [c:\]: VSS error: async operation pending`, snapFailed, `C:\`},
		{"failed, volume from the text", "", `failed to create snapshot for [d:\]: E_ACCESSDENIED`, snapFailed, `D:\`},
		{"unknown provider", `c:\`, `failed to create snapshot for [c:\]: invalid VSS provider "{00000000-0000-0000-0000-000000000001}"`, snapFailed, `C:\`},
		{"mount point by GUID", `\\?\Volume{1a2b}\`, `failed to create snapshot for [\\?\Volume{1a2b}\]: VSS_E_SNAPSHOT_SET_IN_PROGRESS`, snapFailed, `\\?\Volume{1a2b}\`},
		{"provider does not support the volume", `e:\`, `failed to create snapshot for [e:\]: VSS error: Snapshots are not supported for volume e:\`, snapUnsupported, `E:\`},
		{"cleanup", `c:\`, `failed to delete VSS snapshot: VSS error: object not found`, snapCleanup, `C:\`},
		{"mount point lookup", `c:\mnt\x`, `failed to get volume from mount point [c:\mnt\x]: access denied`, snapWarning, `c:\mnt\x`},
		{"bad exclude list", "", `failed to parse vss.exclude-volumes [x]: no such volume`, snapWarning, ""},
		{"an ordinary file error", `C:\Users\a\x.pst`, `open C:\Users\a\x.pst: The process cannot access the file`, snapNone, ""},
		{"a file whose error mentions snapshots", `C:\x`, `read C:\x: failed to create snapshot for [c:\] is a file name`, snapNone, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			kind, vol := classifySnapshotError(tc.item, tc.msg)
			if kind != tc.kind || (kind != snapNone && vol != tc.volume) {
				t.Fatalf("got %v %q, want %v %q", kind, vol, tc.kind, tc.volume)
			}
		})
	}
}

func TestSnapshotOutcomeRecord(t *testing.T) {
	var o SnapshotOutcome
	for _, e := range [][2]string{
		{`c:\`, `failed to create snapshot for [c:\]: VSS error: timeout`},
		{`e:\`, `failed to create snapshot for [e:\]: VSS error: Snapshots are not supported for volume e:\`},
		{`d:\`, `failed to delete VSS snapshot: VSS error: busy`},
		{`c:\m`, `failed to get volume from mount point [c:\m]: denied`},
	} {
		if _, ok := o.record(e[0], e[1]); !ok {
			t.Fatalf("%q not taken", e[1])
		}
	}
	if _, ok := o.record(`C:\a`, "open C:\\a: denied"); ok {
		t.Fatal("a file error was taken as a snapshot entry")
	}
	if len(o.FailedVolumes) != 1 || o.FailedVolumes[0].Volume != `C:\` ||
		len(o.SkippedVolumes) != 1 || o.SkippedVolumes[0] != `E:\` ||
		len(o.CleanupFailed) != 1 || o.CleanupFailed[0].Volume != `D:\` || len(o.Warnings) != 1 {
		t.Fatalf("%+v", o)
	}
}

func TestSnapshotFaultOf(t *testing.T) {
	cases := []struct {
		name     string
		exit     int
		progress bool
		fatal    string
		stderr   []string
		want     SnapshotFault
	}{
		{"COM security", 1, false, "Fatal: VSS error: CoInitializeSecurity failed: E_ACCESSDENIED", nil, SnapshotFaultCertain},
		{"DLL not loaded", 1, false, "", []string{"Failed to load VssApi.dll: The specified module could not be found."}, SnapshotFaultCertain},
		{"raw CoInitializeEx", 1, false, "Fatal: CoInitializeEx failed: 0x80010106", nil, SnapshotFaultCertain},
		{"a VSS_E_ code", 1, false, "Fatal: VSS_E_UNEXPECTED", nil, SnapshotFaultCertain},
		{"arm64", 1, false, "Fatal: executables compiled for arm64 can't use VSS", nil, SnapshotFaultCertain},
		{"unknown text", 1, false, "Fatal: something odd", nil, SnapshotFaultPossible},
		{"after progress", 1, true, "Fatal: VSS error: whatever", nil, SnapshotFaultNone},
		{"no repository", ExitNoRepository, false, "Fatal: repository does not exist", nil, SnapshotFaultNone},
		{"locked", ExitRepoLocked, false, "", nil, SnapshotFaultNone},
		{"wrong password", ExitWrongPassword, false, "", nil, SnapshotFaultNone},
		{"interrupted", ExitInterrupted, false, "", nil, SnapshotFaultNone},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := snapshotFaultOf(tc.exit, tc.progress, tc.fatal, tc.stderr); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestBackupArgsWindows(t *testing.T) {
	got := backupArgs(BackupOptions{
		Host: "pc01", UseFSSnapshot: true, VSSTimeout: 5 * time.Minute,
		VSSExcludeVolumes: []string{`e:\`, "F:", ""}, ExcludeCloudFiles: true, CaseInsensitive: true,
	}, `C:\t\paths.raw`, `C:\t\excludes.txt`)
	want := []string{"backup", "--json", "--files-from-raw", `C:\t\paths.raw`, "--exclude-caches", "--retry-lock", "15m",
		"--host", "pc01", "--iexclude-file", `C:\t\excludes.txt`, "--exclude-cloud-files",
		"--use-fs-snapshot", "-o", "vss.timeout=5m0s", "-o", `vss.exclude-volumes=E:\;F:\`}
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("args\n got: %q\nwant: %q", got, want)
	}
	// Without a timeout or excluded volumes only the switch itself.
	got = backupArgs(BackupOptions{UseFSSnapshot: true}, "p", "")
	if strings.Join(got[len(got)-1:], " ") != "--use-fs-snapshot" {
		t.Fatalf("args %q", got)
	}
}

func TestUpperDriveAndNormalizeVolume(t *testing.T) {
	for in, want := range map[string]string{`c:\Users`: `C:\Users`, `C:\Users`: `C:\Users`, `d:`: `D:`, `/etc`: `/etc`,
		`\\server\share`: `\\server\share`, `1:\x`: `1:\x`} {
		if got := UpperDrive(in); got != want {
			t.Errorf("UpperDrive(%q) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[string]string{`c:\`: `C:\`, `c:`: `C:\`, `E:/`: `E:\`, `\\?\Volume{x}\`: `\\?\Volume{x}\`, ` d:\ `: `D:\`, `c:\Users`: `c:\Users`} {
		if got := NormalizeVolume(in); got != want {
			t.Errorf("NormalizeVolume(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIncludeFor(t *testing.T) {
	opt, pat := includeFor("/C/Users/anna/Report [final].txt", true)
	if opt != "--iinclude" || pat != "/C/Users/anna/Report [[]final].txt" {
		t.Fatalf("%s %s", opt, pat)
	}
	opt, pat = includeFor("/home/a/Report [final].txt", false)
	if opt != "--include" || pat != `/home/a/Report \[final].txt` {
		t.Fatalf("%s %s", opt, pat)
	}
}
