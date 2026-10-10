package share

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/redact"
)

func newTestRedactor() *redact.Redactor { return &redact.Redactor{} }

func TestProbe(t *testing.T) {
	env := newTestEnv(t, "restic", MagicCIFS, "cifs")
	writeTree(t, env.root, map[string]string{"b.txt": "bb", "A/x": "x", "c/": "", "Gr\xfc\xdfe": "latin1"})
	env.sys.put(env.root, XattrNTSD, []byte("sd"))
	env.sys.getErr["*|"+XattrNTSDFull] = eacces
	res, code := Probe(env.sys, env.root, ProtocolSMB, time.Now)
	if code != ExitOK || !res.OK || res.FSType != "cifs" || !res.ReadOnly {
		t.Fatalf("probe %d %+v", code, res)
	}
	if len(res.Entries) != 4 || res.Entries[0].Name != "A" || res.Entries[1].Name != "c" || res.Entries[0].Type != "dir" {
		t.Fatalf("entries %+v", res.Entries)
	}
	var invalid *ListEntry
	for i := range res.Entries {
		if res.Entries[i].InvalidName {
			invalid = &res.Entries[i]
		}
	}
	if invalid == nil || invalid.Name != "Gr\uFFFDe" {
		t.Fatalf("invalid name %+v", invalid)
	}
	if !res.Permissions.Readable || res.Permissions.Xattr != XattrNTSD || res.Permissions.Detail == "" {
		t.Fatalf("permissions %+v", res.Permissions)
	}
	// Not mounted: exit 10 with the guard's code.
	env.sys.magic = 0x794c7630
	res, code = Probe(env.sys, env.root, ProtocolSMB, time.Now)
	if code != ExitGuard || res.OK || res.Code != CodeWrongFilesystem {
		t.Fatalf("not mounted %d %+v", code, res)
	}
}

func TestList(t *testing.T) {
	env := newTestEnv(t, "restic", MagicNFS, "nfs4")
	files := map[string]string{}
	for i := 0; i < 30; i++ {
		files[fmt.Sprintf("Dir/f%02d", i)] = "x"
	}
	files["Dir/sub/x"] = "y"
	writeTree(t, env.root, files)
	res, code := List(env.sys, env.root, ProtocolNFS, "Dir", 10, time.Now)
	if code != ExitOK || len(res.Entries) != 10 || !res.Truncated || res.Entries[0].Name != "sub" || *res.Path != "Dir" {
		t.Fatalf("list %d %+v", code, res)
	}
	if res.Entries[1].Type != "file" || res.Entries[1].Size != 1 || res.Entries[1].MTime == "" {
		t.Fatalf("entry %+v", res.Entries[1])
	}
	if _, code := List(env.sys, env.root, ProtocolNFS, "../etc", 10, time.Now); code != ExitUsage {
		t.Fatal("a path outside the share")
	}
	res, code = List(env.sys, env.root, ProtocolNFS, "Missing", 10, time.Now)
	if code != ExitFailed || res.Code != CodeNotFound {
		t.Fatalf("missing %d %+v", code, res)
	}
	// The limit is capped.
	res, _ = List(env.sys, env.root, ProtocolNFS, "Dir", 1_000_000, time.Now)
	if res.Truncated || len(res.Entries) != 31 {
		t.Fatalf("cap %+v", len(res.Entries))
	}
	if !isAccess(&os.PathError{Err: syscall.EPERM}) || isUnreachable(filepath.ErrBadPattern) {
		t.Fatal("errno helpers")
	}
}
