package recovery

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// SnapshotLayoutPath is where the backup keeps the manifest (4.3).
const SnapshotLayoutPath = "/var/lib/restow-agent/baremetal/" + baremetal.LayoutFile

// ResticReader reads from the snapshot while recover still has read
// access (before anything is changed).
type ResticReader interface {
	// Dump returns one file of the snapshot (at most max bytes).
	Dump(ctx context.Context, snapshot, p string, max int64) ([]byte, error)
	// Ls lists the nodes of the snapshot (recursively).
	Ls(ctx context.Context, snapshot string, fn func(restic.Node) error) error
}

// RunnerReader is a ResticReader over a restic.Runner (no lock, no
// cache: the recovery route is read-only).
type RunnerReader struct{ Runner *restic.Runner }

// Dump implements ResticReader.
func (r RunnerReader) Dump(ctx context.Context, snapshot, p string, max int64) ([]byte, error) {
	var buf bytes.Buffer
	err := r.Runner.Dump(ctx, snapshot, p, &buf, max, restic.DumpOptions{NoLock: true, NoCache: true})
	return buf.Bytes(), err
}

// Ls implements ResticReader.
func (r RunnerReader) Ls(ctx context.Context, snapshot string, fn func(restic.Node) error) error {
	return r.Runner.LsWith(ctx, snapshot, restic.LsOptions{NoLock: true, NoCache: true}, fn)
}

// ReadManifest dumps the manifest of the snapshot and checks it against
// the SHA-256 the instance named (10.4 point 2): a different manifest
// stops the recovery before anything is changed (manifest_mismatch).
func ReadManifest(ctx context.Context, rr ResticReader, snapshot, layoutSHA256 string) (*baremetal.Manifest, []byte, error) {
	raw, err := rr.Dump(ctx, snapshot, SnapshotLayoutPath, baremetal.MaxLayoutBytes+1)
	if err != nil {
		return nil, nil, &problemError{code: ProblemManifestInvalid, err: fmt.Errorf("read the manifest: %w", err)}
	}
	sum := sha256.Sum256(raw)
	if got := hex.EncodeToString(sum[:]); !strings.EqualFold(got, layoutSHA256) {
		return nil, raw, &problemError{code: ProblemManifestMismatch, err: fmt.Errorf("the manifest in the snapshot has SHA-256 %s, the instance named %s", got, layoutSHA256)}
	}
	var head struct {
		Format string `json:"format"`
	}
	_ = jsonUnmarshal(raw, &head)
	if head.Format != baremetal.Format {
		return nil, raw, &problemError{code: ProblemManifestFormatUnknown, err: fmt.Errorf("manifest format %q", head.Format)}
	}
	m, err := baremetal.Decode(raw)
	if err != nil {
		return nil, raw, &problemError{code: ProblemManifestInvalid, err: err}
	}
	if m.Platform != baremetal.PlatformLinux || m.Linux == nil {
		return nil, raw, &problemError{code: ProblemManifestInvalid, err: fmt.Errorf("platform %s cannot be restored by this ISO", m.Platform)}
	}
	return m, raw, nil
}

// factKernels are the default kernel and the next fallback kernel.
func factKernels(m *baremetal.Manifest) []baremetal.Kernel {
	var def *baremetal.Kernel
	var rest []baremetal.Kernel
	for _, k := range m.Linux.Kernels {
		if k.UKI {
			continue
		}
		if k.Default && def == nil {
			kk := k
			def = &kk
			continue
		}
		rest = append(rest, k)
	}
	var out []baremetal.Kernel
	if def != nil {
		out = append(out, *def)
	}
	if len(rest) > 0 {
		out = append(out, rest[0])
	}
	return out
}

// GatherFacts reads the facts the planner needs from the snapshot (10.4
// point 3): the module lists of the default and the fallback kernel, the
// MOK files, the restore sizes (from the instance when it sent them,
// otherwise counted from restic ls) and lvm.conf. lvmMultiline reports an
// LVM filter the fixup cannot rewrite.
func GatherFacts(ctx context.Context, rr ResticReader, m *baremetal.Manifest, snapshot string, sizes map[string]api.RecoveryRestoreSize) (*baremetal.Facts, bool, error) {
	f := &baremetal.Facts{Format: baremetal.FactsFormat, Kernels: []baremetal.KernelFacts{}, RestoreSizes: map[string]baremetal.RestoreSize{}, MokFiles: []baremetal.MokFileFact{}}
	for _, k := range factKernels(m) {
		kf := baremetal.KernelFacts{Version: k.Version, Default: k.Default}
		dump := func(name string) string {
			for _, base := range []string{"/lib/modules/", "/usr/lib/modules/"} {
				b, err := rr.Dump(ctx, snapshot, base+k.Version+"/"+name, 32<<20)
				if err == nil {
					return string(b)
				}
			}
			return ""
		}
		kf.ModulesAlias, kf.ModulesBuiltin, kf.ModulesBuiltinModinfo = dump("modules.alias"), dump("modules.builtin"), dump("modules.builtin.modinfo")
		f.Kernels = append(f.Kernels, kf)
	}
	for _, mf := range m.Linux.MokFiles {
		fact := baremetal.MokFileFact{Path: mf.Path}
		if b, err := rr.Dump(ctx, snapshot, mf.Path, 64<<10); err == nil {
			sum := sha256.Sum256(b)
			s := hex.EncodeToString(sum[:])
			fact.Present, fact.SHA256 = true, &s
		}
		f.MokFiles = append(f.MokFiles, fact)
	}
	if len(sizes) > 0 {
		for k, v := range sizes {
			f.RestoreSizes[k] = baremetal.RestoreSize{Bytes: v.Bytes, Files: v.Files, Inodes: v.Inodes}
		}
	} else {
		c := NewRestoreSizeCounter(RestoreSizeTargets(m), MaxDedupKeys)
		if err := rr.Ls(ctx, snapshot, func(n restic.Node) error { c.Add(n); return nil }); err != nil {
			return nil, false, fmt.Errorf("count the restore sizes: %w", err)
		}
		f.RestoreSizes = c.Result()
	}
	multiline := false
	if len(m.Linux.LVM.PVs) > 0 {
		if b, err := rr.Dump(ctx, snapshot, "/etc/lvm/lvm.conf", 4<<20); err == nil {
			multiline = LVMFilterMultiline(b)
		}
	}
	return f, multiline, nil
}

// MaxDedupKeys bounds the hard-link keys of the size counter (as the
// server's RestoreSizeCounter).
const MaxDedupKeys = 1_000_000

// RestoreSizeTargets are the mount targets a restore fills: every mount
// and local fstab entry, no swap, no automount (as the server's
// restoreSizeTargets).
func RestoreSizeTargets(m *baremetal.Manifest) []string {
	set := map[string]bool{}
	for _, mo := range m.Linux.Mounts {
		if mo.Autofs || mo.FS == nil || !strings.HasPrefix(mo.Target, "/") {
			continue
		}
		set[normTarget(mo.Target)] = true
	}
	for _, e := range m.Linux.Fstab {
		if e.Type == "swap" || e.Type == "autofs" || !strings.HasPrefix(e.Target, "/") || e.Resolved == nil || e.Resolved.FS == nil {
			continue
		}
		set[normTarget(e.Target)] = true
	}
	out := make([]string, 0, len(set))
	for t := range set {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

func normTarget(t string) string {
	for strings.Contains(t, "//") {
		t = strings.ReplaceAll(t, "//", "/")
	}
	if len(t) > 1 {
		t = strings.TrimSuffix(t, "/")
	}
	return t
}

// RestoreSizeCounter counts the nodes of a snapshot into the mount target
// each belongs to, with the rules of the server's counter: hard links
// once per target (inode|size|mtime), inode 0 never merged, at most
// maxKeys keys over all targets (a later file is counted every time).
type RestoreSizeCounter struct {
	targets    []string
	sizes      map[string]*baremetal.RestoreSize
	seen       map[string]map[string]bool
	overflowed map[string]bool
	keys       int
	maxKeys    int
}

// NewRestoreSizeCounter starts a counter.
func NewRestoreSizeCounter(targets []string, maxKeys int) *RestoreSizeCounter {
	c := &RestoreSizeCounter{sizes: map[string]*baremetal.RestoreSize{}, seen: map[string]map[string]bool{}, overflowed: map[string]bool{}, maxKeys: maxKeys}
	set := map[string]bool{}
	for _, t := range targets {
		set[normTarget(t)] = true
	}
	for t := range set {
		c.targets = append(c.targets, t)
		c.sizes[t] = &baremetal.RestoreSize{}
		c.seen[t] = map[string]bool{}
	}
	sort.Slice(c.targets, func(i, j int) bool { return len(c.targets[i]) > len(c.targets[j]) })
	return c
}

func (c *RestoreSizeCounter) targetOf(p string) string {
	for _, t := range c.targets {
		if t == "/" || p == t || strings.HasPrefix(p, t+"/") {
			return t
		}
	}
	return ""
}

// Add counts one node.
func (c *RestoreSizeCounter) Add(n restic.Node) {
	t := c.targetOf(path.Clean(n.Path))
	if t == "" {
		return
	}
	s := c.sizes[t]
	if n.Type == "file" {
		if n.Inode > 0 {
			key := strconv.FormatUint(n.Inode, 10) + "|" + strconv.FormatUint(n.Size, 10) + "|" + n.ModTime.UTC().Format(time.RFC3339Nano)
			if c.seen[t][key] {
				return
			}
			if c.keys < c.maxKeys {
				c.seen[t][key] = true
				c.keys++
			} else {
				c.overflowed[t] = true
			}
		}
		s.Files++
		s.Bytes += int64(n.Size)
	}
	s.Inodes++
}

// Result is the size per target.
func (c *RestoreSizeCounter) Result() map[string]baremetal.RestoreSize {
	out := map[string]baremetal.RestoreSize{}
	for t, s := range c.sizes {
		out[t] = *s
	}
	return out
}

// UpperBounds are the targets whose sizes may count a hard link twice.
func (c *RestoreSizeCounter) UpperBounds() []string {
	var out []string
	for t := range c.overflowed {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
