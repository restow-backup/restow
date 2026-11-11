package recovery

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// memRootfs is an in-memory target root.
type memRootfs struct {
	mu    sync.Mutex
	files map[string]*memFile
}

type memFile struct {
	data  []byte
	mode  fs.FileMode
	link  string
	mtime time.Time
	xattr map[string][]byte
}

type memInfo struct {
	name string
	f    *memFile
}

func (i memInfo) Name() string       { return i.name }
func (i memInfo) Size() int64        { return int64(len(i.f.data)) }
func (i memInfo) Mode() fs.FileMode  { return i.f.mode }
func (i memInfo) ModTime() time.Time { return i.f.mtime }
func (i memInfo) IsDir() bool        { return i.f.mode.IsDir() }
func (i memInfo) Sys() any           { return nil }

func newMemRootfs() *memRootfs {
	return &memRootfs{files: map[string]*memFile{"/": {mode: fs.ModeDir | 0o755}}}
}

func (m *memRootfs) put(p string, data string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.mkdirs(path.Dir(p))
	m.files[path.Clean(p)] = &memFile{data: []byte(data), mode: 0o644, mtime: time.Now()}
}

func (m *memRootfs) mkdirs(p string) {
	for d := path.Clean(p); d != "/"; d = path.Dir(d) {
		if _, ok := m.files[d]; !ok {
			m.files[d] = &memFile{mode: fs.ModeDir | 0o755}
		}
	}
}

func (m *memRootfs) get(p string) (*memFile, error) {
	f, ok := m.files[path.Clean(p)]
	if !ok {
		return nil, &fs.PathError{Op: "open", Path: p, Err: fs.ErrNotExist}
	}
	return f, nil
}

func (m *memRootfs) ReadFile(p string, max int64) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	f, err := m.get(p)
	if err != nil {
		return nil, err
	}
	if f.mode.IsDir() {
		return nil, errors.New("a folder")
	}
	return append([]byte(nil), f.data...), nil
}

func (m *memRootfs) WriteFileAtomic(p string, data []byte, mode fs.FileMode, uid, gid int, backup string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if f, ok := m.files[path.Clean(p)]; ok && f.mode&fs.ModeSymlink != 0 {
		return ErrSymlinkTarget
	}
	if _, ok := m.files[path.Dir(path.Clean(p))]; !ok {
		return &fs.PathError{Op: "create", Path: p, Err: fs.ErrNotExist}
	}
	if old, ok := m.files[path.Clean(p)]; ok && backup != "" {
		m.files[path.Join(path.Dir(p), backup)] = old
	}
	m.files[path.Clean(p)] = &memFile{data: append([]byte(nil), data...), mode: mode, mtime: time.Now()}
	return nil
}

func (m *memRootfs) MkdirAll(p string, mode fs.FileMode) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for d := path.Clean(p); d != "/"; d = path.Dir(d) {
		if f, ok := m.files[d]; ok && !f.mode.IsDir() {
			return fmt.Errorf("%s: not a folder", d)
		}
	}
	for d := path.Clean(p); d != "/"; d = path.Dir(d) {
		if _, ok := m.files[d]; !ok {
			m.files[d] = &memFile{mode: fs.ModeDir | mode}
		}
	}
	return nil
}

func (m *memRootfs) Lstat(p string) (fs.FileInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	f, err := m.get(p)
	if err != nil {
		return nil, err
	}
	return memInfo{name: path.Base(p), f: f}, nil
}

func (m *memRootfs) Chmod(p string, mode fs.FileMode) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	f, err := m.get(p)
	if err != nil {
		return err
	}
	f.mode = f.mode&fs.ModeType | mode
	return nil
}

func (m *memRootfs) Chown(p string, uid, gid int) error { _, err := m.Lstat(p); return err }

func (m *memRootfs) Remove(p string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.get(p); err != nil {
		return err
	}
	delete(m.files, path.Clean(p))
	return nil
}

func (m *memRootfs) ReadDir(p string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.get(p); err != nil {
		return nil, err
	}
	var out []string
	for k := range m.files {
		if k != "/" && path.Dir(k) == path.Clean(p) {
			out = append(out, path.Base(k))
		}
	}
	sort.Strings(out)
	return out, nil
}

func (m *memRootfs) Getxattr(p, name string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	f, err := m.get(p)
	if err != nil {
		return nil, err
	}
	if v, ok := f.xattr[name]; ok {
		return v, nil
	}
	return nil, errors.New("no attribute")
}

// fakeExec answers the ISO's programs: mkfs results are read back by
// blkid and dumpe2fs, sfdisk --dump returns the script that was written,
// opened volumes exist.
type fakeExec struct {
	mu      sync.Mutex
	calls   []string
	stdins  [][]byte
	scripts map[string]string
	fsByDev map[string]mkfsWant
	exists  map[string]bool
	mapping map[string]string // dm name -> the device it sits on
	fail    func(argv []string) error
	output  func(argv []string) (string, bool)
}

func newFakeExec() *fakeExec {
	return &fakeExec{scripts: map[string]string{}, fsByDev: map[string]mkfsWant{}, exists: map[string]bool{}, mapping: map[string]string{}}
}

func (f *fakeExec) Run(ctx context.Context, s RunSpec) (RunResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	line := strings.Join(s.Argv, " ")
	if s.Stdin != nil && len(s.Stdin) > 0 {
		line += " " + fmt.Sprintf("<stdin:%d bytes>", len(s.Stdin))
	}
	f.calls = append(f.calls, line)
	f.stdins = append(f.stdins, append([]byte(nil), s.Stdin...))
	if f.fail != nil {
		if err := f.fail(s.Argv); err != nil {
			return RunResult{}, err
		}
	}
	if f.output != nil {
		if out, ok := f.output(s.Argv); ok {
			return RunResult{Output: []byte(out)}, nil
		}
	}
	a := s.Argv
	switch {
	case a[0] == "sfdisk" && len(a) == 3 && a[1] == "--dump":
		return RunResult{Output: []byte(f.scripts[a[2]])}, nil
	case a[0] == "sfdisk" && hasArg(a, "--wipe"):
		f.scripts[a[len(a)-1]] = string(s.Stdin)
	case strings.HasPrefix(a[0], "mkfs.") || a[0] == "mkswap":
		w := mkfsExpect(a)
		f.fsByDev[w.dev] = w
	case a[0] == "blkid" && len(a) == 5:
		w := f.fsByDev[a[4]]
		uuid := w.uuid
		return RunResult{Output: []byte(fmt.Sprintf("DEVNAME=%s\nUUID=%s\nTYPE=%s\nLABEL=%s\n", a[4], uuid, w.typ, w.label))}, nil
	case a[0] == "dumpe2fs":
		w := f.fsByDev[a[2]]
		return RunResult{Output: []byte("Filesystem features:      " + strings.Join(w.features, " ") + "\n")}, nil
	case a[0] == "cryptsetup" && len(a) > 1 && a[1] == "open":
		f.exists["/dev/mapper/"+a[len(a)-1]] = true
		f.mapping[a[len(a)-1]] = a[len(a)-2]
	case a[0] == "mokutil" && strings.HasPrefix(a[1], "--generate-hash"):
		return RunResult{Output: []byte("$6$salt$hash\n")}, nil
	}
	return RunResult{}, nil
}

func (f *fakeExec) lines() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return strings.Join(f.calls, "\n") + "\n"
}

// fakeOps records the operations.
type fakeOps struct {
	mu      sync.Mutex
	exec    *fakeExec
	ops     []string
	mounted map[string]bool
	free    int64
	entries int
	fail    string
	// stack is added to the devices of every isolated step (the dm nodes
	// DeviceSet finds above the target disks).
	stack []string
	// dm are the device-mapper devices of the machine.
	dm []DMMapping
	// frozen are the mount points ThawFrozen thaws once.
	frozen []string
	// parts are the partitions a disk has before it is erased.
	parts map[string][]string
}

func (o *fakeOps) Partitions(dev string) ([]string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.parts[dev]...), nil
}

func (f *fakeExec) note(s string) {
	f.mu.Lock()
	f.calls = append(f.calls, s)
	f.mu.Unlock()
}

func (o *fakeOps) rec(s string) error {
	o.exec.note("op " + s)
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ops = append(o.ops, s)
	if o.fail != "" && strings.HasPrefix(s, o.fail) {
		return errors.New("operation failed")
	}
	return nil
}

func (o *fakeOps) ReleaseHolders(ctx context.Context, dev string) error {
	return o.rec("release " + dev)
}
func (o *fakeOps) BlkZero(ctx context.Context, dev string, head, tail int64) error {
	return o.rec(fmt.Sprintf("blkzero %s %d %d", dev, head, tail))
}
func (o *fakeOps) PMBRBoot(ctx context.Context, dev string) error { return o.rec("pmbr " + dev) }
func (o *fakeOps) WaitPartUUIDs(ctx context.Context, uuids []string, timeout time.Duration) error {
	return o.rec("wait " + strings.Join(uuids, ","))
}
func (o *fakeOps) Exists(dev string) bool {
	o.exec.mu.Lock()
	defer o.exec.mu.Unlock()
	return o.exec.exists[dev]
}
func (o *fakeOps) MappingOn(name, dev string) (bool, string) {
	o.exec.mu.Lock()
	defer o.exec.mu.Unlock()
	on := o.exec.mapping[name]
	return on != "" && on == dev, on
}
func (o *fakeOps) Mounted(p string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.mounted[p]
}
func (o *fakeOps) MkdirHost(p string) error { return nil }
func (o *fakeOps) Statfs(p string) (int64, int64, error) {
	if o.free == 0 {
		return 1 << 30, 2 << 30, nil
	}
	return o.free, 1 << 30, nil
}
func (o *fakeOps) WriteBootEntry(ctx context.Context, e BootEntryRequest) (int, error) {
	o.entries++
	return o.entries, o.rec("nvram " + e.Label + " " + e.PartUUID + " " + e.Loader)
}
func (o *fakeOps) Swapfile(ctx context.Context, p string, size int64, uuid, label string) (int64, error) {
	return 34816, o.rec(fmt.Sprintf("swapfile %s %d %s", p, size, uuid))
}
func (o *fakeOps) TmpFile(name string, data []byte) (string, func(), error) {
	return "/run/restow-recovery/tmp/" + name, func() {}, o.rec("tmpfile " + name)
}
func (o *fakeOps) DeviceSet(disks, extra []string) ([]string, []string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append(append(append([]string{}, disks...), extra...), o.stack...), nil
}
func (o *fakeOps) DMMappings() []DMMapping {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]DMMapping(nil), o.dm...)
}
func (o *fakeOps) setDM(ms ...DMMapping) {
	o.mu.Lock()
	o.dm = ms
	o.mu.Unlock()
}
func (o *fakeOps) UnmountAll(ctx context.Context, root string) error { return o.rec("unmount " + root) }
func (o *fakeOps) ThawFrozen(root string) ([]string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	f := o.frozen
	o.frozen = nil
	return f, nil
}

// fakeIsolator records the isolated programs.
type fakeIsolator struct {
	exec  *fakeExec
	mu    sync.Mutex
	runs  []IsolateSpec
	exit  int
	reply func(spec IsolateSpec) string
}

func (i *fakeIsolator) Run(ctx context.Context, spec IsolateSpec) (*IsolationResult, error) {
	if i.exec != nil {
		i.exec.note("chroot-exec " + strings.Join(spec.Argv, " "))
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	i.runs = append(i.runs, spec)
	out := ""
	if i.reply != nil {
		out = i.reply(spec)
	}
	return &IsolationResult{ExitCode: i.exit, Output: []byte(out)}, nil
}

// fakeSessionAPI records what the execution reports.
type fakeSessionAPI struct {
	exec     *fakeExec
	mu       sync.Mutex
	order    []string
	cancel   bool
	progress []api.RecoveryProgress
	events   []api.RecoveryEvent
	logs     []string
}

// messages are the messages of the progress reports, in order.
func (s *fakeSessionAPI) messages() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, p := range s.progress {
		out = append(out, p.Message)
	}
	return out
}

func (s *fakeSessionAPI) note(x string) {
	s.mu.Lock()
	s.order = append(s.order, x)
	exec := s.exec
	s.mu.Unlock()
	if exec != nil {
		exec.note("session " + x)
	}
}
func (s *fakeSessionAPI) Current(ctx context.Context) (*api.RecoverySessionState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return &api.RecoverySessionState{Status: api.RecoveryActive, CancelRequested: s.cancel}, nil
}
func (s *fakeSessionAPI) Progress(ctx context.Context, p api.RecoveryProgress) error {
	s.mu.Lock()
	s.progress = append(s.progress, p)
	s.mu.Unlock()
	return nil
}
func (s *fakeSessionAPI) Log(ctx context.Context, lines []string) (api.RecoveryLogResult, error) {
	s.mu.Lock()
	s.logs = append(s.logs, lines...)
	s.mu.Unlock()
	return api.RecoveryLogResult{Accepted: len(lines)}, nil
}
func (s *fakeSessionAPI) Event(ctx context.Context, kind string, detail map[string]string) error {
	s.note("event " + kind)
	s.mu.Lock()
	s.events = append(s.events, api.RecoveryEvent{Kind: kind, Detail: detail})
	s.mu.Unlock()
	return nil
}
func (s *fakeSessionAPI) Release(ctx context.Context) (string, error) {
	s.note("release")
	return api.RecoveryFinishing, nil
}

// fakeRestic writes files into the target as a restore would; block
// makes it wait for the cancellation.
type fakeRestic struct {
	exec  *fakeExec
	root  *memRootfs
	files map[string]string
	block chan struct{}
	items []restic.ItemError
	// unlisted counts item errors beyond the ones restic lists.
	unlisted int
	calls    [][]string
}

func (r *fakeRestic) Restore(ctx context.Context, args []string, onProgress func(restic.Progress)) (*RestoreOutcome, error) {
	r.calls = append(r.calls, args)
	if r.exec != nil {
		r.exec.note("restic " + strings.Join(args, " "))
	}
	if r.block != nil {
		close(r.block)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	for p, c := range r.files {
		r.root.put(p, c)
	}
	if onProgress != nil {
		onProgress(restic.Progress{FilesDone: uint64(len(r.files)), TotalFiles: uint64(len(r.files))})
	}
	out := &RestoreOutcome{Items: r.items, ItemCount: len(r.items) + r.unlisted}
	if out.ItemCount > 0 {
		out.ExitCode = 1
		out.FatalError = fmt.Sprintf("There were %d errors", out.ItemCount)
	}
	return out, nil
}

func readPlan(t *testing.T, name string) *baremetal.RestorePlan {
	t.Helper()
	b, err := osReadFile("../baremetal/testdata/plans/" + name + ".json")
	if err != nil {
		t.Fatal(err)
	}
	var p baremetal.RestorePlan
	if err := jsonUnmarshal(b, &p); err != nil {
		t.Fatal(err)
	}
	return &p
}
