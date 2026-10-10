package share

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestParseMountInfo(t *testing.T) {
	data := `22 1 0:21 / / rw,relatime - overlay overlay rw,lowerdir=/x
101 22 0:55 / /share ro,relatime - cifs //fs1/Data ro,vers=3.1.1,addr=10.0.0.5,password=SECRET
102 22 0:56 / /my\040share rw,relatime shared:5 - nfs4 10.0.0.6:/export rw,vers=4.2
broken line
`
	entries := ParseMountInfo([]byte(data))
	if len(entries) != 3 {
		t.Fatalf("entries: %+v", entries)
	}
	share, ok := FindMount(entries, "/share")
	if !ok || share.FSType != "cifs" || !hasOption(share.Options, "ro") || share.Super[0] != "ro" {
		t.Fatalf("share: %+v", share)
	}
	spaced, ok := FindMount(entries, "/my share")
	if !ok || spaced.FSType != "nfs4" || !hasOption(spaced.Options, "rw") {
		t.Fatalf("escaped mount point: %+v", spaced)
	}
}

func TestCheckMount(t *testing.T) {
	cases := []struct {
		name     string
		magic    int64
		fstype   string
		ro       bool
		protocol string
		wantRO   bool
		code     string
	}{
		{"smb ro", MagicCIFS, "cifs", true, ProtocolSMB, true, ""},
		{"smb2 magic", MagicSMB2, "smb3", true, ProtocolSMB, true, ""},
		{"nfs4", MagicNFS, "nfs4", true, ProtocolNFS, true, ""},
		{"restore rw", MagicNFS, "nfs", false, ProtocolNFS, false, ""},
		{"not mounted: overlay magic", 0x794c7630, "cifs", true, ProtocolSMB, true, CodeWrongFilesystem},
		{"nfs where smb expected", MagicNFS, "nfs", true, ProtocolSMB, true, CodeWrongFilesystem},
		{"type mismatch in mountinfo", MagicCIFS, "nfs", true, ProtocolSMB, true, CodeWrongFilesystem},
		{"rw where ro asked", MagicCIFS, "cifs", false, ProtocolSMB, true, CodeWrongFilesystem},
		{"ro where rw asked", MagicCIFS, "cifs", true, ProtocolSMB, false, CodeWrongFilesystem},
		{"unknown protocol", MagicCIFS, "cifs", true, "ftp", true, CodeWrongFilesystem},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sys := newFakeSys(c.magic).mount("/share", c.fstype, c.ro)
			_, err := CheckMount(sys, "/share", c.protocol, c.wantRO)
			var ge *GuardError
			if c.code == "" {
				mustNoErr(t, err)
			} else if !errors.As(err, &ge) || ge.Code != c.code {
				t.Fatalf("want %s, got %v", c.code, err)
			}
		})
	}
	// Not a mount point at all.
	sys := newFakeSys(MagicCIFS)
	if _, err := CheckMount(sys, "/share", ProtocolSMB, true); err == nil || !strings.Contains(err.Error(), "not a mount point") {
		t.Fatalf("missing mount: %v", err)
	}
}

func TestCheckSources(t *testing.T) {
	root := t.TempDir()
	var ge *GuardError
	// Empty root, previous restore point had files: refused.
	if err := CheckSources(root, nil, 10, false); !errors.As(err, &ge) || ge.Code != CodeEmptySource {
		t.Fatalf("empty: %v", err)
	}
	// ... unless allowed once, or there was nothing before.
	mustNoErr(t, CheckSources(root, nil, 10, true))
	mustNoErr(t, CheckSources(root, nil, 0, false))

	mustNoErr(t, os.MkdirAll(filepath.Join(root, "A"), 0o755))
	mustNoErr(t, os.MkdirAll(filepath.Join(root, "B"), 0o755))
	mustNoErr(t, CheckSources(root, nil, 10, false))
	// Every include folder empty: refused.
	if err := CheckSources(root, []string{"A", "B"}, 10, false); !errors.As(err, &ge) || ge.Code != CodeEmptySource {
		t.Fatalf("empty includes: %v", err)
	}
	mustNoErr(t, os.WriteFile(filepath.Join(root, "B", "f"), []byte("x"), 0o644))
	mustNoErr(t, CheckSources(root, []string{"A", "B"}, 10, false))
	// A missing include folder.
	if err := CheckSources(root, []string{"A", "C"}, 0, false); !errors.As(err, &ge) || ge.Code != CodeIncludeMissing ||
		!strings.Contains(ge.Detail, "C") {
		t.Fatalf("missing include: %v", err)
	}
	if err := CheckSources(root, []string{"../etc"}, 0, false); !errors.As(err, &ge) || ge.Code != CodeIncludeMissing {
		t.Fatalf("bad include: %v", err)
	}
	// An unreadable root.
	if err := CheckSources(filepath.Join(root, "nope"), nil, 0, false); !errors.As(err, &ge) || ge.Code != CodeNotFound {
		t.Fatalf("missing root: %v", err)
	}
}

func TestClassifyReadError(t *testing.T) {
	cases := map[error]string{
		&os.PathError{Err: syscall.EACCES}:    CodePermissionDenied,
		&os.PathError{Err: syscall.EIO}:       CodeUnreachable,
		&os.PathError{Err: syscall.ETIMEDOUT}: CodeUnreachable,
		&os.PathError{Err: syscall.ENOENT}:    CodeNotFound,
		errors.New("other"):                   CodeInternal,
	}
	for err, want := range cases {
		if got := classifyReadError(err); got != want {
			t.Errorf("%v: got %s want %s", err, got, want)
		}
	}
	if errnoName(&os.PathError{Err: syscall.EACCES}) != "EACCES" || errnoName(errors.New("x")) != "" ||
		errnoName(errNoData) != "ENODATA" || errnoName(syscall.EOPNOTSUPP) != "EOPNOTSUPP" {
		t.Fatal("errno names")
	}
}

func TestValidRelative(t *testing.T) {
	for _, ok := range []string{"", "a", "a/b c/d", "Ünï/x"} {
		if !ValidRelative(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"/a", "a/", "a//b", "../a", "a/./b", `a\b`, "a\x01b", "a\x00"} {
		if ValidRelative(bad) {
			t.Errorf("%q should be invalid", bad)
		}
	}
}
