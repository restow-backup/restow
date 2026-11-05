// Package sqlfake holds the stand-ins of the native SQL Server backup for
// tests on every system: a script runner that replays recorded outputs of
// sql.ps1 (testdata/runs) or answers from a handler, a file system on real
// temporary folders that records the DACLs it was asked for, and a restic
// that keeps snapshots in memory. Nothing here is used outside tests.
package sqlfake

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/restow-backup/restow/agent/internal/restic"
	"github.com/restow-backup/restow/agent/internal/sqlserver"
)

// Reply is one recorded run of the script: its stdout (JSON lines) and its
// exit code. A line "#exit N" in a recorded file sets the exit code, a line
// "#timeout" marks a run the agent ended at its limit.
type Reply struct {
	Output   string
	Exit     int
	TimedOut bool
}

// ParseRecording reads a recorded file.
func ParseRecording(text string) Reply {
	var r Reply
	var lines []string
	for _, l := range strings.Split(text, "\n") {
		switch {
		case strings.HasPrefix(l, "#exit "):
			r.Exit, _ = strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(l, "#exit ")))
		case strings.TrimSpace(l) == "#timeout":
			r.TimedOut = true
		case strings.HasPrefix(l, "#"):
		default:
			lines = append(lines, l)
		}
	}
	r.Output = strings.Join(lines, "\n")
	return r
}

// Runner is a ScriptRunner for tests. For each request it looks up a reply
// by "<op>:<name>" (the database, new or check name of the request), then by
// "<op>"; Handler, when set, answers what Replies do not. Before answering it
// calls OnRequest (a test writes the backup file SQL Server would write).
type Runner struct {
	mu        sync.Mutex
	Replies   map[string]Reply
	Handler   func(req sqlserver.Request) (Reply, bool)
	OnRequest func(req sqlserver.Request)
	Calls     []sqlserver.Request
}

// Load reads recorded files: key → file under dir.
func Load(dir string, files map[string]string) (map[string]Reply, error) {
	out := map[string]Reply{}
	for k, f := range files {
		b, err := os.ReadFile(filepath.Join(dir, f))
		if err != nil {
			return nil, err
		}
		out[k] = ParseRecording(string(b))
	}
	return out, nil
}

// RequestName is the database (or new, check) name a request is about.
func RequestName(req sqlserver.Request) string {
	var p struct {
		Database   string `json:"database"`
		NewName    string `json:"newName"`
		VerifyName string `json:"verifyName"`
		CheckName  string `json:"checkName"`
		Name       string `json:"name"`
	}
	_ = json.Unmarshal(req.Params, &p)
	for _, s := range []string{p.Database, p.NewName, p.VerifyName, p.CheckName, p.Name} {
		if s != "" {
			// A check name stands for its database.
			if i := strings.Index(s, sqlserver.VerifyMarker); i > 0 {
				return s[:i]
			}
			return s
		}
	}
	return ""
}

// Run implements sqlserver.ScriptRunner by replaying a reply through the
// real output parser.
func (r *Runner) Run(ctx context.Context, req sqlserver.Request, progress func(sqlserver.Line)) sqlserver.Result {
	r.mu.Lock()
	r.Calls = append(r.Calls, req)
	on := r.OnRequest
	reply, ok := r.Replies[req.Op+":"+RequestName(req)]
	if !ok {
		reply, ok = r.Replies[req.Op]
	}
	h := r.Handler
	r.mu.Unlock()
	if !ok && h != nil {
		reply, ok = h(req)
	}
	if !ok {
		reply = Reply{Output: `{"type":"error","problem":{"code":"sql_script_failed","step":"script","number":0,"message":"no reply recorded for ` + req.Op + `"}}`, Exit: 2}
	}
	if on != nil {
		on(req)
	}
	if ctx.Err() != nil {
		return sqlserver.Finish(sqlserver.Output{}, -1, nil, false, true, "")
	}
	out := sqlserver.ReadOutput(strings.NewReader(reply.Output), progress)
	return sqlserver.Finish(out, reply.Exit, nil, reply.TimedOut, false, "")
}

// Ops lists the operations requested so far (with their names).
func (r *Runner) Ops() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, c := range r.Calls {
		n := RequestName(c)
		if n != "" {
			out = append(out, c.Op+":"+n)
		} else {
			out = append(out, c.Op)
		}
	}
	return out
}

// Result writes a result line with data.
func Result(data any) Reply {
	b, _ := json.Marshal(map[string]any{"type": "result", "data": data})
	return Reply{Output: string(b)}
}

// Error writes an error line.
func Error(code, step string, number int, message string) Reply {
	b, _ := json.Marshal(map[string]any{"type": "error", "problem": sqlserver.Problem{Code: code, Step: step, Number: number, Message: message}})
	return Reply{Output: string(b), Exit: 2}
}

// ---- file system -------------------------------------------------------------

// FS is a sqlserver.FS on the real file system of the test (no DACLs: it
// records them). Free is the free space per path prefix (longest match), or
// Default; Root is what Volume reports as the root.
type FS struct {
	mu      sync.Mutex
	Free    map[string]uint64
	Default uint64
	Root    string
	// Total is the size Volume reports (0: unknown).
	Total   uint64
	Facts   *sqlserver.VolumeFacts
	DACLs   map[string][]string
	Removed []string
	// FailMkdir makes MkdirWithSIDs fail for paths with this prefix.
	FailMkdir string
}

// NewFS returns an FS with 1 TiB free everywhere.
func NewFS() *FS { return &FS{Default: 1 << 40, DACLs: map[string][]string{}} }

func (f *FS) FreeBytes(path string) (uint64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	best, free := -1, f.Default
	for p, v := range f.Free {
		if strings.HasPrefix(path, p) && len(p) > best {
			best, free = len(p), v
		}
	}
	return free, nil
}

func (f *FS) MkdirWithSIDs(dir string, modify []string) error {
	if f.FailMkdir != "" && strings.HasPrefix(dir, f.FailMkdir) {
		return errors.New("access denied")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.DACLs[dir] = append([]string{"modify"}, modify...)
	return nil
}

// PrepareStagingRoot accepts a new or empty folder (and writes the marker)
// or one with the marker; it refuses one that holds other files.
func (f *FS) PrepareStagingRoot(root string) (string, error) {
	if f.FailMkdir != "" && strings.HasPrefix(root, f.FailMkdir) {
		return "", errors.New("access denied")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	marker := filepath.Join(root, sqlserver.StagingMarker)
	if _, err := os.Stat(marker); err == nil {
		return root, nil
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", err
	}
	if len(entries) > 0 {
		return "", fmt.Errorf("%s exists, holds other files and was not created by the agent", root)
	}
	f.mu.Lock()
	f.DACLs[root] = []string{"modify"}
	f.mu.Unlock()
	return root, os.WriteFile(marker, []byte(sqlserver.StagingMarkerText), 0o600)
}

func (f *FS) SetReadSIDs(dir string, read []string) error {
	if _, err := os.Stat(dir); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.DACLs[dir] = append([]string{"read"}, read...)
	return nil
}

func (f *FS) RemoveAll(path string) error {
	f.mu.Lock()
	f.Removed = append(f.Removed, path)
	f.mu.Unlock()
	return os.RemoveAll(path)
}

func (f *FS) SHA256File(ctx context.Context, path string) (string, int64, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", 0, err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), int64(len(b)), nil
}

func (f *FS) ReadFile(path string) ([]byte, error) { return os.ReadFile(path) }

func (f *FS) WriteFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func (f *FS) Volume(path string) (sqlserver.VolumeFacts, error) {
	if f.Facts != nil {
		return *f.Facts, nil
	}
	root := f.Root
	if root == "" {
		root = "/"
	}
	return sqlserver.VolumeFacts{Root: root, Fixed: true, FileSystem: "NTFS", TotalBytes: f.Total}, nil
}

// DACL returns what was set on dir.
func (f *FS) DACL(dir string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.DACLs[dir]
}

// ---- restic ---------------------------------------------------------------------

// Restic keeps snapshots in memory: Backup copies the files below its paths
// (keyed by their snapshot path), Restore writes them below the target.
type Restic struct {
	mu        sync.Mutex
	Snapshots map[string]map[string][]byte
	Backups   []restic.BackupOptions
	Restores  []restic.RestoreOptions
	// BackupErr fails every backup; RestoreErr every restore.
	BackupErr, RestoreErr error
	// Corrupt changes the content of every restored file (a damaged
	// repository: the SHA-256 no longer matches).
	Corrupt bool
	next    int
}

// NewRestic returns an empty repository.
func NewRestic() *Restic { return &Restic{Snapshots: map[string]map[string][]byte{}} }

func (r *Restic) Backup(ctx context.Context, o restic.BackupOptions) (*restic.BackupResult, error) {
	r.mu.Lock()
	r.Backups = append(r.Backups, o)
	err := r.BackupErr
	r.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	files := map[string][]byte{}
	var total uint64
	for _, p := range o.Paths {
		_ = filepath.Walk(p, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return err
			}
			b, rerr := os.ReadFile(path)
			if rerr != nil {
				return rerr
			}
			files[sqlserver.SnapshotPathOf(path)] = b
			total += uint64(len(b))
			return nil
		})
	}
	r.mu.Lock()
	r.next++
	id := fmt.Sprintf("%064x", r.next)
	r.Snapshots[id] = files
	r.mu.Unlock()
	return &restic.BackupResult{SnapshotID: id, Summary: restic.BackupSummary{FilesNew: uint64(len(files)),
		DataAdded: total, TotalFilesProcessed: uint64(len(files)), TotalBytesProcessed: total}}, nil
}

func (r *Restic) Restore(ctx context.Context, o restic.RestoreOptions) (*restic.RestoreResult, error) {
	r.mu.Lock()
	r.Restores = append(r.Restores, o)
	err := r.RestoreErr
	snap := r.Snapshots[o.SnapshotID]
	corrupt := r.Corrupt
	r.mu.Unlock()
	if err != nil {
		return nil, err
	}
	for _, inc := range o.Includes {
		b, ok := snap[inc]
		if !ok {
			continue
		}
		if corrupt {
			b = append([]byte("damaged "), b...)
		}
		dst := sqlserver.RestoredPath(o.Target, inc)
		if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
			return nil, err
		}
		if err := os.WriteFile(dst, b, 0o600); err != nil {
			return nil, err
		}
	}
	return &restic.RestoreResult{}, nil
}

// Put stores a file in a snapshot (a backup made earlier).
func (r *Restic) Put(snapshotID, path string, content []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.Snapshots[snapshotID] == nil {
		r.Snapshots[snapshotID] = map[string][]byte{}
	}
	r.Snapshots[snapshotID][path] = content
}

// Log collects run log lines.
type Log struct {
	mu    sync.Mutex
	Lines []string
}

func (l *Log) add(level, format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.Lines = append(l.Lines, level+" "+fmt.Sprintf(format, args...))
}

func (l *Log) Infof(format string, args ...any)  { l.add("INFO", format, args...) }
func (l *Log) Warnf(format string, args ...any)  { l.add("WARN", format, args...) }
func (l *Log) Errorf(format string, args ...any) { l.add("ERROR", format, args...) }

// Text is the whole log.
func (l *Log) Text() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.Lines, "\n")
}
