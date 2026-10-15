//go:build sharetest

package main

// A test-only build of restow-share (go build -tags sharetest) for the end-to-end tests of the
// server side (apps/worker/src/file-shares/e2e.pg.test.ts): it runs against a plain folder
// instead of a cifs or nfs mount. RESTOW_SHARE_TEST_ROOT names the folder that stands in for
// /share, RESTOW_SHARE_TEST_META the scratch folder (/.restow), RESTOW_SHARE_TEST_CACHE the
// cache volume (/cache), and RESTOW_SHARE_TEST_RW=1 makes the stand-in mount writable (a
// restore). The mount guard sees the protocol of RESTOW_SHARE_EXPECT. Release builds never
// contain this file.

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/restow-backup/restow/agent/internal/share"
)

func init() {
	root := os.Getenv("RESTOW_SHARE_TEST_ROOT")
	if root == "" {
		return
	}
	defaultDeps = func() deps {
		cfg := share.DefaultConfig()
		cache := os.Getenv("RESTOW_SHARE_TEST_CACHE")
		cfg.Root = root
		cfg.MetaDir = os.Getenv("RESTOW_SHARE_TEST_META")
		cfg.TmpDir = filepath.Join(cache, "tmp")
		cfg.CacheDir = filepath.Join(cache, "restic")
		cfg.Sys = testMount{
			System:   share.OS(),
			root:     root,
			protocol: os.Getenv("RESTOW_SHARE_EXPECT"),
			readOnly: os.Getenv("RESTOW_SHARE_TEST_RW") != "1",
		}
		return deps{cfg: cfg}
	}
}

// testMount answers the mount guard as if root were a cifs or nfs mount; xattrs are the real
// file system's.
type testMount struct {
	share.System
	root, protocol string
	readOnly       bool
}

func (m testMount) Statfs(string) (int64, error) {
	if m.protocol == share.ProtocolNFS {
		return share.MagicNFS, nil
	}
	return share.MagicSMB2, nil
}

func (m testMount) MountInfo() ([]byte, error) {
	opt, fstype := "rw", "cifs"
	if m.readOnly {
		opt = "ro"
	}
	if m.protocol == share.ProtocolNFS {
		fstype = "nfs4"
	}
	return []byte(fmt.Sprintf("36 25 0:32 / %s %s,relatime shared:1 - %s server:/export %s\n",
		m.root, opt, fstype, opt)), nil
}
