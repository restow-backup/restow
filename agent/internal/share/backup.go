package share

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// SnapshotHost is the restic host of every share snapshot (4.4).
const SnapshotHost = "restow-share"

// BackupArgs are the inputs of the `restic backup` command line (4.4).
type BackupArgs struct {
	ShareID, RunID string
	Protocol       string
	Parent         string
	// ReadConcurrency 0 means 4.
	ReadConcurrency int
	// ExcludeFile holds literal paths (offline files), IExcludeFile the
	// patterns on SMB; on NFS the patterns are in ExcludeFile as well.
	ExcludeFile, IExcludeFile string
	ExcludeLargerThanBytes    int64
	LimitUploadKiB            int
	// Paths: the share root or the include folders, then the scratch folder.
	Paths []string
}

// Args renders the command line. Nothing in it is secret.
func (a BackupArgs) Args() []string {
	args := []string{"backup", "--json", "--host", SnapshotHost, "--tag", "restow-share",
		"--tag", "share=" + a.ShareID, "--tag", "run=" + a.RunID}
	if a.Parent != "" {
		args = append(args, "--parent", a.Parent)
	}
	rc := a.ReadConcurrency
	if rc <= 0 {
		rc = 4
	}
	args = append(args, "--no-scan", "--read-concurrency", strconv.Itoa(rc), "--retry-lock", "1h")
	if a.ExcludeFile != "" {
		args = append(args, "--exclude-file", a.ExcludeFile)
	}
	if a.IExcludeFile != "" {
		args = append(args, "--iexclude-file", a.IExcludeFile)
	}
	if a.ExcludeLargerThanBytes > 0 {
		args = append(args, "--exclude-larger-than", strconv.FormatInt(a.ExcludeLargerThanBytes, 10))
	}
	if a.LimitUploadKiB > 0 {
		args = append(args, "--limit-upload", strconv.Itoa(a.LimitUploadKiB))
	}
	if a.Protocol == ProtocolSMB {
		// Inode numbers are not stable on cifs, and the change time moves on
		// permission changes the sidecar captures anyway (4.4).
		args = append(args, "--ignore-inode", "--ignore-ctime")
	}
	return append(args, a.Paths...)
}

// ValidRelative checks a path relative to the share root: '/'-separated
// segments, no `.`/`..`, no backslash or control characters.
func ValidRelative(p string) bool {
	if p == "" {
		return true
	}
	if strings.HasPrefix(p, "/") || strings.HasSuffix(p, "/") || len(p) > 4096 {
		return false
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." || strings.ContainsAny(seg, "\\\x00") {
			return false
		}
		for _, r := range seg {
			if r < 0x20 || r == 0x7f {
				return false
			}
		}
	}
	return true
}

// CheckSources is guard step 3 and the empty-root guard (4.2, 4.3): the root
// (or every include folder) can be read and is not empty when the previous
// restore point had files, unless the admin allowed it once.
func CheckSources(root string, includes []string, previousFiles int64, allowEmpty bool) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return &GuardError{Code: classifyReadError(err), Detail: err.Error()}
	}
	empty := len(entries) == 0
	if len(includes) > 0 {
		empty = true
		for _, inc := range includes {
			if !ValidRelative(inc) || inc == "" {
				return &GuardError{Code: CodeIncludeMissing, Detail: fmt.Sprintf("include folder %q is not a valid relative path", inc)}
			}
			dir := filepath.Join(root, filepath.FromSlash(inc))
			fi, err := os.Stat(dir)
			if err != nil || !fi.IsDir() {
				if err != nil && !errors.Is(err, os.ErrNotExist) && classifyReadError(err) != CodeInternal {
					return &GuardError{Code: classifyReadError(err), Detail: err.Error()}
				}
				return &GuardError{Code: CodeIncludeMissing, Detail: "the include folder " + inc + " does not exist"}
			}
			sub, err := os.ReadDir(dir)
			if err != nil {
				return &GuardError{Code: classifyReadError(err), Detail: err.Error()}
			}
			if len(sub) > 0 {
				empty = false
			}
		}
	}
	if empty && previousFiles > 0 && !allowEmpty {
		return &GuardError{Code: CodeEmptySource, Detail: fmt.Sprintf(
			"the share is empty although the previous restore point had %d files; nothing was backed up", previousFiles)}
	}
	return nil
}

// warningCodes are the item codes that make a run end "with warnings".
func isWarningCode(code string) bool { return code != ItemOfflineSkipped }

// classifyResticItem maps a per-file error of restic backup.
func classifyResticItem(message string) string {
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "device or resource busy"), strings.Contains(lower, "sharing violation"),
		strings.Contains(lower, "used by another process"), strings.Contains(lower, "text file busy"):
		return ItemLockedFile
	}
	return ItemReadError
}

// relOf turns a snapshot path below root into a path relative to the share root.
func relOf(root, p string) string {
	root = strings.TrimRight(root, "/")
	if p == root {
		return ""
	}
	if strings.HasPrefix(p, root+"/") {
		return p[len(root)+1:]
	}
	return strings.TrimPrefix(p, "/")
}

func guardOutcome(err error) Outcome {
	var ge *GuardError
	if errors.As(err, &ge) {
		return failed(ExitGuard, ge.Code, ge.Detail)
	}
	return failed(ExitFailed, CodeInternal, err.Error())
}

func (j *job) backup(ctx context.Context) Outcome {
	cfg, b, protocol := j.cfg, j.s.Backup, j.s.Expect.Protocol
	started := cfg.Now()
	j.rep.Phase(ctx, PhasePrepare)
	if _, err := CheckMount(cfg.Sys, cfg.Root, protocol, true); err != nil {
		return guardOutcome(err)
	}
	var previousFiles int64
	if b.Previous != nil {
		previousFiles = b.Previous.FileCount
	}
	if err := CheckSources(cfg.Root, b.Includes, previousFiles, b.AllowEmptyOnce); err != nil {
		return guardOutcome(err)
	}
	if err := os.MkdirAll(cfg.MetaDir, 0o700); err != nil {
		return failed(ExitFailed, CodeInternal, "the scratch folder: "+err.Error())
	}

	// Permissions: decided at the root for the whole run.
	mode := ACLModeNone
	if b.Permissions != "off" {
		var err error
		mode, err = ChooseACLXattr(cfg.Sys, cfg.Root, protocol)
		if mode == ACLModeNone && err != nil {
			j.log.Printf("permissions cannot be read at the share root (%v); they are not backed up", err)
			j.rep.Item(Item{Path: "", Code: ItemACLUnreadable, Message: err.Error(), Phase: PhasePrepare})
		}
	}
	var previous map[string]PreviousEntry
	if protocol == ProtocolSMB && mode != ACLModeNone && !b.RereadPermissions && b.ParentSnapshotID != "" {
		previous = j.previousSidecar(ctx, b.ParentSnapshotID)
	}

	// The walk writes the sidecar.
	j.rep.Phase(ctx, PhaseScan)
	sidecarPath := filepath.Join(cfg.MetaDir, SidecarFile)
	f, err := os.OpenFile(sidecarPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return failed(ExitFailed, CodeInternal, "the sidecar: "+err.Error())
	}
	sidecar, err := NewSidecarWriter(f, SidecarHeader{Protocol: protocol, Xattr: mode,
		Created: started.UTC().Format(time.RFC3339), Runner: buildinfo.Version})
	if err != nil {
		f.Close()
		return failed(ExitFailed, CodeInternal, "the sidecar: "+err.Error())
	}
	var capture *Capturer
	if protocol == ProtocolSMB || mode != ACLModeNone {
		capture = &Capturer{X: cfg.Sys, Protocol: protocol, Xattr: mode}
	}
	walk, err := Walk(ctx, WalkOptions{
		Root: cfg.Root, Includes: b.Includes, Excludes: NewMatcher(b.Excludes, b.CaseInsensitive),
		Capture: capture, Sidecar: sidecar, Previous: previous, SkipOffline: b.SkipOffline,
		Readers: cfg.Readers, SampleBefore: started.Add(-time.Hour), SamplePool: 4 * max(b.Samples, 0),
		Rand: cfg.Rand, OnItem: j.rep.Item,
		OnProgress: func(files, bytes uint64, current string) {
			j.rep.Update(ctx, func(p *ProgressReport) {
				p.TotalFiles, p.TotalBytes, p.CurrentPath = files, bytes, current
			})
		},
	})
	closeErr := sidecar.Close()
	if cerr := f.Close(); closeErr == nil {
		closeErr = cerr
	}
	if err != nil {
		if ctx.Err() != nil {
			return failed(ExitFailed, CodeCancelled, "stopped during the scan")
		}
		return failed(ExitFailed, CodeInternal, "the scan failed: "+err.Error())
	}
	if closeErr != nil {
		return failed(ExitFailed, CodeInternal, "the sidecar: "+closeErr.Error())
	}
	counts := sidecar.Counts()
	j.log.Printf("scan: %d files, %d folders, %d bytes; permissions %s: %d entries, %d descriptors, %d errors, %d reused",
		walk.Files, walk.Dirs, walk.Bytes, mode, counts.Entries, counts.Descriptors, counts.Errors, walk.Reused)
	if walk.Files == 0 && previousFiles > 0 && !b.AllowEmptyOnce {
		return failed(ExitGuard, CodeEmptySource, fmt.Sprintf(
			"nothing to back up after the excludes although the previous restore point had %d files", previousFiles))
	}
	if previousFiles > 0 && int64(walk.Files) < previousFiles/2 {
		j.rep.Item(Item{Code: ItemFilesDropped, Phase: PhaseScan,
			Message: fmt.Sprintf("%d files, the previous restore point had %d", walk.Files, previousFiles)})
	}
	for i, rel := range walk.Offline {
		if i >= 100 {
			break
		}
		j.rep.Item(Item{Path: rel, Code: ItemOfflineSkipped, Phase: PhaseScan, Message: "offline file, not recalled"})
	}

	manifest := Manifest{Format: ManifestFormat, V: 1, ShareID: j.s.Run.ShareID, Protocol: protocol,
		Includes: nonNil(b.Includes), CreatedAt: started.UTC().Format(time.RFC3339), Files: int64(walk.Files), Bytes: int64(walk.Bytes),
		Permissions: ManifestPermission{Mode: b.Permissions, Xattr: mode, Entries: counts.Entries,
			Descriptors: counts.Descriptors, Errors: counts.Errors}}
	if manifest.Permissions.Mode == "" {
		manifest.Permissions.Mode = "auto"
	}
	mb, _ := json.MarshalIndent(manifest, "", "  ")
	if err := os.WriteFile(filepath.Join(cfg.MetaDir, ManifestFile), append(mb, '\n'), 0o600); err != nil {
		return failed(ExitFailed, CodeInternal, "the manifest: "+err.Error())
	}

	// restic backup.
	j.rep.Phase(ctx, PhaseBackup)
	optDir, err := os.MkdirTemp(mkdirAll(cfg.TmpDir), "share-")
	if err != nil {
		return failed(ExitFailed, CodeInternal, err.Error())
	}
	defer os.RemoveAll(optDir)
	var offlineAbs []string
	for _, rel := range walk.Offline {
		offlineAbs = append(offlineAbs, strings.TrimRight(cfg.Root, "/")+"/"+rel)
	}
	args := BackupArgs{ShareID: j.s.Run.ShareID, RunID: j.s.Run.ID, Protocol: protocol, Parent: b.ParentSnapshotID,
		ReadConcurrency: b.ReadConcurrency, ExcludeLargerThanBytes: b.ExcludeLargerThanBytes, LimitUploadKiB: b.LimitUploadKiB}
	literal, dropped := ExcludeLines(nil, offlineAbs)
	patterns, droppedPatterns := ExcludeLines(b.Excludes, nil)
	for _, d := range append(dropped, droppedPatterns...) {
		j.log.Printf("exclude pattern %q cannot be used and was skipped", d)
	}
	if protocol == ProtocolSMB {
		args.ExcludeFile, err = writeLines(optDir, "excludes", literal)
		if err == nil {
			args.IExcludeFile, err = writeLines(optDir, "iexcludes", patterns)
		}
	} else {
		args.ExcludeFile, err = writeLines(optDir, "excludes", append(patterns, literal...))
	}
	if err != nil {
		return failed(ExitFailed, CodeInternal, err.Error())
	}
	if len(b.Includes) == 0 {
		args.Paths = []string{cfg.Root}
	} else {
		for _, inc := range b.Includes {
			args.Paths = append(args.Paths, strings.TrimRight(cfg.Root, "/")+"/"+inc)
		}
	}
	args.Paths = append(args.Paths, cfg.MetaDir)

	var summary *restic.BackupSummary
	res, err := j.restic.Command(ctx, restic.CommandOptions{Name: "backup", Args: args.Args(), OnStdoutLine: func(line []byte) {
		if p, ok := restic.ParseBackupStatus(line); ok {
			j.rep.Update(ctx, func(r *ProgressReport) {
				r.FilesDone, r.BytesDone, r.CurrentPath = p.FilesDone, p.BytesDone, relOf(cfg.Root, p.CurrentPath)
				r.TotalFiles, r.TotalBytes = walk.Files, walk.Bytes
			})
			return
		}
		if s, ok := restic.ParseBackupSummary(line); ok {
			summary = &s
		}
	}})
	if err != nil {
		if ctx.Err() != nil {
			return failed(ExitFailed, CodeCancelled, "stopped during the backup")
		}
		return failed(ExitFailed, CodeInternal, err.Error())
	}
	for _, it := range res.Items {
		j.rep.Item(Item{Path: relOf(cfg.Root, it.Path), Code: classifyResticItem(it.Message), Message: it.Message, Phase: PhaseBackup})
	}
	if res.ItemCount > len(res.Items) {
		j.log.Printf("%d more files could not be read", res.ItemCount-len(res.Items))
	}
	if e := res.Err(); e != nil {
		return resticFailure(ctx, e)
	}
	if summary == nil || summary.SnapshotID == "" {
		return failed(ExitFailed, CodeResticFailed, fmt.Sprintf("restic backup ended (exit code %d) without a snapshot", res.ExitCode))
	}

	// Samples for the restore check (4.3, 8.4).
	j.rep.Phase(ctx, PhaseFinalize)
	cfg.Rand.Shuffle(len(walk.Candidates), func(a, c int) {
		walk.Candidates[a], walk.Candidates[c] = walk.Candidates[c], walk.Candidates[a]
	})
	samples := PickSamples(cfg.Root, walk.Candidates, b.Samples)
	if len(samples) > 0 && j.api != nil {
		if err := j.api.Samples(ctx, summary.SnapshotID, samples); err != nil {
			j.log.Printf("the samples could not be sent: %v", err)
		}
	}

	stats := map[string]any{
		"files": walk.Files, "dirs": walk.Dirs, "bytes": walk.Bytes,
		"filesNew": summary.FilesNew, "filesChanged": summary.FilesChanged, "filesUnmodified": summary.FilesUnmodified,
		"dataAdded": summary.DataAdded, "dataAddedPacked": summary.DataAddedPacked,
		"totalFilesProcessed": summary.TotalFilesProcessed, "totalBytesProcessed": summary.TotalBytesProcessed,
		"durationSeconds": cfg.Now().Sub(started).Seconds(), "offlineSkipped": walk.OfflineCount,
		"samples": len(samples), "previousFiles": previousFiles,
		"permissions": map[string]any{"mode": manifest.Permissions.Mode, "xattr": mode, "entries": counts.Entries,
			"descriptors": counts.Descriptors, "errors": counts.Errors, "reused": walk.Reused},
	}
	out := Outcome{Status: StatusSucceeded, SnapshotID: summary.SnapshotID, Stats: stats, Exit: ExitOK}
	warn := res.ExitCode == restic.ExitIncomplete
	for code, n := range j.rep.Counts() {
		if n > 0 && isWarningCode(code) {
			warn = true
		}
	}
	if warn {
		out.Status, out.Exit = StatusWarning, ExitWarnings
	}
	return out
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func mkdirAll(dir string) string {
	_ = os.MkdirAll(dir, 0o700)
	return dir
}

func writeLines(dir, name string, lines []string) (string, error) {
	if len(lines) == 0 {
		return "", nil
	}
	p := filepath.Join(dir, name)
	return p, os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o600)
}

// previousSidecar reads the parent snapshot's sidecar for the ACL reuse; any
// problem only costs the reuse.
func (j *job) previousSidecar(ctx context.Context, parent string) map[string]PreviousEntry {
	var buf bytes.Buffer
	if err := j.dump(ctx, parent, j.metaSnapshotPath(SidecarFile), &buf); err != nil {
		j.log.Printf("the previous permissions could not be read (%v); reading all of them", err)
		return nil
	}
	prev, err := LoadPrevious(func(fn func(SidecarRecord) error) (SidecarResult, error) {
		return ReadSidecar(&buf, fn)
	})
	if err != nil {
		j.log.Printf("the previous permissions could not be read (%v); reading all of them", err)
		return nil
	}
	return prev
}

func (j *job) metaSnapshotPath(name string) string {
	return strings.TrimRight(j.cfg.MetaDir, "/") + "/" + name
}

// dump writes one file of a snapshot to w (`restic dump`).
func (j *job) dump(ctx context.Context, snapshot, path string, w io.Writer) error {
	res, err := j.restic.Command(ctx, restic.CommandOptions{Name: "dump",
		Args: []string{"dump", "--no-lock", snapshot, path}, Stdout: w})
	if err != nil {
		return err
	}
	if e := res.Err(); e != nil {
		return e
	}
	return nil
}

// PickSamples hashes up to want candidates that did not change while they
// were read (size and modification time equal before and after).
func PickSamples(root string, candidates []SampleCandidate, want int) []SampleFile {
	var out []SampleFile
	for _, c := range candidates {
		if len(out) >= want {
			break
		}
		p := filepath.Join(root, filepath.FromSlash(c.Rel))
		before, err := os.Lstat(p)
		if err != nil || !before.Mode().IsRegular() || before.Size() != c.Size || !before.ModTime().Equal(c.MTime) {
			continue
		}
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		h := sha256.New()
		n, err := io.Copy(h, f)
		f.Close()
		if err != nil || n != c.Size {
			continue
		}
		after, err := os.Lstat(p)
		if err != nil || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
			continue
		}
		out = append(out, SampleFile{Path: strings.TrimRight(root, "/") + "/" + c.Rel,
			SHA256: hex.EncodeToString(h.Sum(nil)), Size: c.Size})
	}
	return out
}
