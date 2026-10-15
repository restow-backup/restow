package share

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/restic"
)

// Restore runs (4.7) and copy runs (4.10).

// Destinations and conflict policies.
const (
	DestOriginal  = "original"
	DestNewFolder = "new_folder"
	DestFolder    = "folder"

	ConflictOverwrite = "overwrite"
	ConflictKeepBoth  = "keep_both"
	ConflictSkip      = "skip"

	CopyOverwrite = "overwrite"
	CopyMirror    = "mirror"
)

// CopyMarkerFile marks a mirror copy's target folder (4.10 rule 4).
const CopyMarkerFile = ".restow-copy.json"

// CopyMarkerFormat is the marker's `format`.
const CopyMarkerFormat = "restow-copy-target"

// StagingPrefix is the prefix of the keep-both staging folder in the share root.
const StagingPrefix = ".restow-restore-"

// CopyMarker is the content of the marker file.
type CopyMarker struct {
	Format        string `json:"format"`
	V             int    `json:"v"`
	JobID         string `json:"jobId"`
	SourceShareID string `json:"sourceShareId"`
	CreatedAt     string `json:"createdAt"`
}

// RestorePlan is what a restore does, derived from its parameters.
type RestorePlan struct {
	// Folder is the destination relative to the target share's root ("" = root).
	Folder string
	// MustNotExist: the folder is created by this run (new_folder).
	MustNotExist bool
	// Staging is the keep-both staging folder relative to the root, or "".
	Staging   string
	Overwrite string // restic --overwrite
	Delete    bool   // mirror
	Mirror    bool
}

// NewFolderName is `Restow-Restore-YYYYMMDD-HHMMSS` (UTC).
func NewFolderName(t time.Time) string {
	return "Restow-Restore-" + t.UTC().Format("20060102-150405")
}

func runPrefix(runID string) string {
	id := strings.ReplaceAll(runID, "-", "")
	if len(id) > 8 {
		id = id[:8]
	}
	return id
}

// PlanRestore checks the parameters and derives the plan. The error is a
// *GuardError with the run code.
func PlanRestore(p RestoreParams, runID, shareID string, now time.Time) (RestorePlan, error) {
	bad := func(code, format string, args ...any) (RestorePlan, error) {
		return RestorePlan{}, &GuardError{Code: code, Detail: fmt.Sprintf(format, args...)}
	}
	if p.SnapshotID == "" {
		return bad(CodeRestoreTarget, "no restore point given")
	}
	for _, sel := range p.Paths {
		if !ValidRelative(sel) {
			return bad(CodeRestoreTarget, "the selected path %q is not valid", sel)
		}
	}
	switch p.Destination {
	case DestOriginal:
		plan := RestorePlan{}
		switch p.Conflict {
		case ConflictOverwrite:
			plan.Overwrite = "if-changed"
		case ConflictSkip:
			plan.Overwrite = "never"
		case ConflictKeepBoth:
			plan.Overwrite = "never"
			plan.Staging = StagingPrefix + runPrefix(runID)
		default:
			return bad(CodeRestoreTarget, "unknown conflict policy %q", p.Conflict)
		}
		return plan, nil
	case DestNewFolder:
		return RestorePlan{Folder: NewFolderName(now), MustNotExist: true, Overwrite: "never"}, nil
	case DestFolder:
		folder := strings.Trim(p.Folder, "/")
		if folder == "" && p.Copy == nil {
			folder = NewFolderName(now)
		}
		if !ValidRelative(folder) {
			return bad(CodeRestoreTarget, "the folder %q is not valid", p.Folder)
		}
		if strings.HasPrefix(folder, StagingPrefix) || folder == ".restow" {
			return bad(CodeRestoreTarget, "the folder %q is reserved", p.Folder)
		}
		plan := RestorePlan{Folder: folder, Overwrite: "never"}
		if p.Copy != nil {
			if p.TargetShareID != "" && (p.TargetShareID == p.Copy.SourceShareID || p.TargetShareID == shareID) {
				return bad(CodeCopyUnsafeTarget, "a copy never writes into its source share")
			}
			switch p.Copy.Mode {
			case CopyOverwrite:
				plan.Overwrite = "if-changed"
			case CopyMirror:
				if folder == "" {
					return bad(CodeCopyUnsafeTarget, "a mirror copy never writes into a share root")
				}
				plan.Overwrite, plan.Delete, plan.Mirror = "if-changed", true, true
			default:
				return bad(CodeRestoreTarget, "unknown copy mode %q", p.Copy.Mode)
			}
		}
		return plan, nil
	}
	return bad(CodeRestoreTarget, "unknown destination %q", p.Destination)
}

// RestoreArgs are the inputs of the `restic restore` command line.
type RestoreArgs struct {
	Snapshot string
	// SnapshotRoot is the share root inside the snapshot (/share).
	SnapshotRoot string
	Target       string
	// Includes are paths relative to the share root.
	Includes  []string
	Overwrite string
	Verify    bool
	Delete    bool
	// Excludes are restic patterns relative to the restored folder.
	Excludes []string
}

// Args renders the command line: `restic restore <snap>:/share --target ...`.
// `-vv` makes restic report every item it restores, which the permission
// write-back needs (it touches only what was restored).
func (a RestoreArgs) Args() []string {
	args := []string{"restore", a.Snapshot + ":" + a.SnapshotRoot, "--target", a.Target}
	for _, inc := range a.Includes {
		args = append(args, "--include", "/"+restic.EscapeIncludePath(strings.Trim(inc, "/")))
	}
	args = append(args, "--no-lock", "--overwrite", a.Overwrite,
		"--exclude-xattr", "system.*", "--exclude-xattr", "security.*")
	if a.Verify {
		args = append(args, "--verify")
	}
	if a.Delete {
		args = append(args, "--delete")
	}
	for _, ex := range a.Excludes {
		args = append(args, "--exclude", ex)
	}
	return append(args, "--json", "-vv")
}

// CheckMirrorTarget is rule 4 of 4.10: a mirror refuses a non-empty folder
// without its marker, or with another job's, unless the admin confirmed it.
func CheckMirrorTarget(dir, jobID string, confirmed bool) error {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) || (err == nil && len(entries) == 0) {
		return nil
	}
	if err != nil {
		return &GuardError{Code: classifyReadError(err), Detail: err.Error()}
	}
	data, err := os.ReadFile(filepath.Join(dir, CopyMarkerFile))
	if err == nil {
		var m CopyMarker
		if json.Unmarshal(data, &m) == nil && m.Format == CopyMarkerFormat && m.JobID == jobID {
			return nil
		}
		if confirmed {
			return nil
		}
		return &GuardError{Code: CodeCopyUnsafeTarget, Detail: "the target folder belongs to another copy job"}
	}
	if confirmed {
		return nil
	}
	return &GuardError{Code: CodeCopyUnsafeTarget,
		Detail: fmt.Sprintf("the target folder is not empty (%d entries) and was not created by this copy job", len(entries))}
}

// CheckMirrorCount is rules 5 and 6 of 4.10.
func CheckMirrorCount(files, lastCopied int64, force bool) error {
	if files <= 0 {
		return &GuardError{Code: CodeCopyEmptySource, Detail: "the restore point is empty; a mirror never empties its target"}
	}
	if lastCopied > 0 && files < lastCopied/2 && !force {
		return &GuardError{Code: CodeCopyEmptySource, Detail: fmt.Sprintf(
			"the restore point has %d files, the one copied last %d; run the copy by hand with Copy anyway if this is intended", files, lastCopied)}
	}
	return nil
}

// WriteCopyMarker writes (or refreshes) the marker after a mirror run.
func WriteCopyMarker(dir string, m CopyMarker, now time.Time) error {
	m.Format, m.V = CopyMarkerFormat, 1
	if data, err := os.ReadFile(filepath.Join(dir, CopyMarkerFile)); err == nil {
		var old CopyMarker
		if json.Unmarshal(data, &old) == nil && old.JobID == m.JobID && old.CreatedAt != "" {
			m.CreatedAt = old.CreatedAt
		}
	}
	if m.CreatedAt == "" {
		m.CreatedAt = now.UTC().Format(time.RFC3339)
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	return os.WriteFile(filepath.Join(dir, CopyMarkerFile), append(b, '\n'), 0o644)
}

// RemoveStaleStaging removes keep-both staging folders of earlier runs.
func RemoveStaleStaging(root, own string) []string {
	var removed []string
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), StagingPrefix) && e.Name() != own {
			if os.RemoveAll(filepath.Join(root, e.Name())) == nil {
				removed = append(removed, e.Name())
			}
		}
	}
	return removed
}

// ReconcileStats counts the keep-both reconcile.
type ReconcileStats struct {
	Placed, Identical, Renamed, Failed uint64
}

// Reconcile moves a keep-both staging folder into place (4.7): a missing
// destination gets the staged entry, an identical file (size and mtime) is
// dropped, anything else is renamed to "<name> (restored <label>)<ext>" next
// to the original. It returns where each placed or renamed entry ended up
// (relative paths; a placed folder stands for everything below it).
func Reconcile(staging, dest, label string, onError func(rel string, err error)) (map[string]string, ReconcileStats) {
	placed := map[string]string{}
	var st ReconcileStats
	var walk func(rel string)
	walk = func(rel string) {
		entries, err := os.ReadDir(filepath.Join(staging, filepath.FromSlash(rel)))
		if err != nil {
			onError(rel, err)
			st.Failed++
			return
		}
		for _, e := range entries {
			childRel := e.Name()
			if rel != "" {
				childRel = rel + "/" + e.Name()
			}
			src := filepath.Join(staging, filepath.FromSlash(childRel))
			dst := filepath.Join(dest, filepath.FromSlash(childRel))
			sfi, err := os.Lstat(src)
			if err != nil {
				onError(childRel, err)
				st.Failed++
				continue
			}
			dfi, err := os.Lstat(dst)
			switch {
			case errors.Is(err, os.ErrNotExist):
				if err := os.Rename(src, dst); err != nil {
					onError(childRel, err)
					st.Failed++
					continue
				}
				placed[childRel] = childRel
				st.Placed++
			case err != nil:
				onError(childRel, err)
				st.Failed++
			case sfi.IsDir() && dfi.IsDir():
				walk(childRel)
			case sfi.Mode().IsRegular() && dfi.Mode().IsRegular() && sfi.Size() == dfi.Size() && sfi.ModTime().Equal(dfi.ModTime()):
				_ = os.Remove(src)
				st.Identical++
			default:
				name := restoredName(dest, childRel, label)
				if err := os.Rename(src, filepath.Join(dest, filepath.FromSlash(name))); err != nil {
					onError(childRel, err)
					st.Failed++
					continue
				}
				placed[childRel] = name
				st.Renamed++
			}
		}
	}
	walk("")
	if err := os.RemoveAll(staging); err != nil {
		onError("", err)
	}
	return placed, st
}

// restoredName is "<dir>/<base> (restored <label>)<ext>", with " 2", " 3", ...
// when that exists as well.
func restoredName(dest, rel, label string) string {
	dir, base := path.Split(rel)
	ext := path.Ext(base)
	if ext == base || len(ext) > 16 {
		ext = ""
	}
	stem := strings.TrimSuffix(base, ext)
	for i := 1; ; i++ {
		suffix := ""
		if i > 1 {
			suffix = fmt.Sprintf(" %d", i)
		}
		name := fmt.Sprintf("%s%s (restored %s%s)%s", dir, stem, label, suffix, ext)
		if _, err := os.Lstat(filepath.Join(dest, filepath.FromSlash(name))); errors.Is(err, os.ErrNotExist) {
			return name
		}
	}
}

// placedTarget is where the sidecar's path p ended up after a reconcile, or
// false when it was not placed (identical, or not restored).
func placedTarget(placed map[string]string, p string) (string, bool) {
	if t, ok := placed[p]; ok {
		return t, true
	}
	for dir := path.Dir(p); dir != "." && dir != "/" && dir != ""; dir = path.Dir(dir) {
		if t, ok := placed[dir]; ok && t == dir {
			return p, true
		}
	}
	return "", false
}

// selected says whether p is inside the selection (empty selects all).
func selected(paths []string, p string) bool {
	if len(paths) == 0 {
		return true
	}
	for _, s := range paths {
		s = strings.Trim(s, "/")
		if p == s || strings.HasPrefix(p, s+"/") {
			return true
		}
	}
	return false
}

// classifyRestoreItem maps a per-file restore error; "" drops it (chown and
// chmod on an SMB target are expected, owners there are synthetic).
func classifyRestoreItem(protocol, message string) string {
	lower := strings.ToLower(message)
	if strings.Contains(lower, "chown") || strings.Contains(lower, "chmod") {
		if protocol == ProtocolSMB {
			return ""
		}
		return ItemOwnerNotRestore
	}
	if strings.Contains(lower, "file name too long") || strings.Contains(lower, "invalid argument") ||
		strings.Contains(lower, "illegal byte sequence") {
		return ItemNameInvalid
	}
	return ItemWriteError
}

type restoreSummary struct {
	TotalFiles    uint64 `json:"total_files"`
	FilesRestored uint64 `json:"files_restored"`
	FilesSkipped  uint64 `json:"files_skipped"`
	FilesDeleted  uint64 `json:"files_deleted"`
	TotalBytes    uint64 `json:"total_bytes"`
	BytesRestored uint64 `json:"bytes_restored"`
}

type verboseStatus struct {
	Action string `json:"action"`
	Item   string `json:"item"`
}

func (j *job) restore(ctx context.Context) Outcome {
	cfg, p, protocol := j.cfg, j.s.Restore, j.s.Expect.Protocol
	started := cfg.Now()
	j.rep.Phase(ctx, PhasePrepare)
	if _, err := CheckMount(cfg.Sys, cfg.Root, protocol, false); err != nil {
		return guardOutcome(err)
	}
	if _, err := os.ReadDir(cfg.Root); err != nil {
		return failed(ExitGuard, classifyReadError(err), err.Error())
	}
	plan, err := PlanRestore(*p, j.s.Run.ID, j.s.Run.ShareID, started)
	if err != nil {
		return guardOutcome(err)
	}
	stats := &RestoreStats{Folder: plan.Folder, PermissionsApplied: map[string]int{}}
	for _, name := range RemoveStaleStaging(cfg.Root, plan.Staging) {
		j.log.Printf("removed the staging folder %s of an earlier run", name)
	}
	destAbs := cfg.Root
	if plan.Folder != "" {
		destAbs = filepath.Join(cfg.Root, filepath.FromSlash(plan.Folder))
	}
	if plan.Mirror {
		if err := CheckMirrorTarget(destAbs, p.Copy.JobID, p.Copy.MirrorConfirmed); err != nil {
			return guardOutcome(err)
		}
		files, err := j.snapshotFileCount(ctx, p.SnapshotID)
		if err != nil {
			return failed(ExitFailed, CodeRepository, "the restore point's manifest could not be read: "+err.Error())
		}
		if err := CheckMirrorCount(files, p.Copy.LastCopiedFileCount, p.Copy.Force); err != nil {
			return guardOutcome(err)
		}
	}
	if plan.MustNotExist {
		if _, err := os.Lstat(destAbs); err == nil {
			return failed(ExitGuard, CodeRestoreTarget, "the folder "+plan.Folder+" exists already")
		}
	}
	if plan.Folder != "" {
		if err := os.MkdirAll(destAbs, 0o755); err != nil {
			return failed(ExitFailed, classifyWriteError(err), "the folder "+plan.Folder+" could not be created: "+err.Error())
		}
	}
	target := destAbs
	if plan.Staging != "" {
		target = filepath.Join(cfg.Root, plan.Staging)
		if err := os.Mkdir(target, 0o700); err != nil {
			return failed(ExitFailed, classifyWriteError(err), "the staging folder could not be created: "+err.Error())
		}
	}

	j.rep.Phase(ctx, PhaseRestore)
	args := RestoreArgs{Snapshot: p.SnapshotID, SnapshotRoot: cfg.Root, Target: target, Includes: p.Paths,
		Overwrite: plan.Overwrite, Verify: p.Verify, Delete: plan.Delete}
	if plan.Mirror {
		args.Excludes = []string{"/" + CopyMarkerFile}
	}
	touched := map[string]string{}
	var summary *restoreSummary
	res, err := j.restic.Command(ctx, restic.CommandOptions{Name: "restore", Args: args.Args(), OnStdoutLine: func(line []byte) {
		switch restic.MessageType(line) {
		case "status":
			if pr, ok := restic.ParseRestoreStatus(line); ok {
				j.rep.Update(ctx, func(r *ProgressReport) {
					r.FilesDone, r.BytesDone, r.TotalFiles, r.TotalBytes = pr.FilesDone, pr.BytesDone, pr.TotalFiles, pr.TotalBytes
				})
			}
		case "verbose_status":
			var v verboseStatus
			if json.Unmarshal(line, &v) == nil && v.Action != "deleted" {
				touched[strings.TrimPrefix(v.Item, "/")] = v.Action
			}
		case "summary":
			var s restoreSummary
			if json.Unmarshal(line, &s) == nil {
				summary = &s
			}
		}
	}})
	if err != nil {
		if ctx.Err() != nil {
			return Outcome{Status: StatusFailed, Code: CodeCancelled, Message: "stopped during the restore", Exit: ExitFailed,
				Stats: map[string]any{}, Restore: stats}
		}
		return failed(ExitFailed, CodeInternal, err.Error())
	}
	for _, it := range res.Items {
		code := classifyRestoreItem(protocol, it.Message)
		if code == "" {
			continue
		}
		stats.Failed++
		j.rep.Item(Item{Path: relOf(target, it.Path), Code: code, Message: it.Message, Phase: PhaseRestore})
	}
	if e := res.Err(); e != nil && (summary == nil || len(res.Items) == 0) {
		out := resticFailure(ctx, e)
		out.Restore = stats
		return out
	}
	if summary != nil {
		stats.Restored, stats.Skipped, stats.Deleted = summary.FilesRestored, summary.FilesSkipped, summary.FilesDeleted
	}

	var placed map[string]string
	if plan.Staging != "" {
		label := started.UTC().Format("2006-01-02 1504")
		var rs ReconcileStats
		placed, rs = Reconcile(target, destAbs, label, func(rel string, err error) {
			j.rep.Item(Item{Path: rel, Code: ItemWriteError, Message: err.Error(), Phase: PhaseRestore})
		})
		stats.Identical, stats.Renamed, stats.Failed = rs.Identical, rs.Renamed, stats.Failed+rs.Failed
		j.log.Printf("keep both: %d placed, %d identical, %d renamed, %d failed", rs.Placed, rs.Identical, rs.Renamed, rs.Failed)
	}

	j.rep.Phase(ctx, PhaseFinalize)
	if p.RestorePermissions {
		j.applyPermissions(ctx, p, plan, destAbs, touched, placed, stats)
	}
	if plan.Mirror {
		if err := WriteCopyMarker(destAbs, CopyMarker{JobID: p.Copy.JobID, SourceShareID: p.Copy.SourceShareID}, started); err != nil {
			j.rep.Item(Item{Path: plan.Folder + "/" + CopyMarkerFile, Code: ItemWriteError, Message: err.Error(), Phase: PhaseFinalize})
		}
	}

	out := Outcome{Status: StatusSucceeded, Exit: ExitOK, Restore: stats, Stats: map[string]any{
		"durationSeconds": cfg.Now().Sub(started).Seconds(), "totalFiles": summaryTotal(summary),
		"bytesRestored": summaryBytes(summary)}}
	for code, n := range j.rep.Counts() {
		if n > 0 && isWarningCode(code) {
			out.Status, out.Exit = StatusWarning, ExitWarnings
		}
	}
	return out
}

func summaryTotal(s *restoreSummary) uint64 {
	if s == nil {
		return 0
	}
	return s.TotalFiles
}

func summaryBytes(s *restoreSummary) uint64 {
	if s == nil {
		return 0
	}
	return s.BytesRestored
}

func classifyWriteError(err error) string {
	if isAccess(err) {
		return CodePermissionDenied
	}
	if isUnreachable(err) {
		return CodeUnreachable
	}
	return CodeRestoreTarget
}

// snapshotFileCount reads the file count from the snapshot's manifest.
func (j *job) snapshotFileCount(ctx context.Context, snapshot string) (int64, error) {
	var buf strings.Builder
	if err := j.dump(ctx, snapshot, j.metaSnapshotPath(ManifestFile), &buf); err != nil {
		return 0, err
	}
	var m Manifest
	if err := json.Unmarshal([]byte(buf.String()), &m); err != nil {
		return 0, err
	}
	return m.Files, nil
}

// applyPermissions writes the sidecar's permissions to what was restored (4.7).
func (j *job) applyPermissions(ctx context.Context, p *RestoreParams, plan RestorePlan, destAbs string,
	touched map[string]string, placed map[string]string, stats *RestoreStats) {
	cfg := j.cfg
	if err := os.MkdirAll(cfg.MetaDir, 0o700); err != nil {
		j.log.Printf("permissions not restored: %v", err)
		return
	}
	file := filepath.Join(cfg.MetaDir, "restore-"+SidecarFile)
	f, err := os.OpenFile(file, os.O_CREATE|os.O_TRUNC|os.O_RDWR, 0o600)
	if err != nil {
		j.log.Printf("permissions not restored: %v", err)
		return
	}
	defer os.Remove(file)
	defer f.Close()
	if err := j.dump(ctx, p.SnapshotID, j.metaSnapshotPath(SidecarFile), f); err != nil {
		j.rep.Item(Item{Code: ItemACLNotRestored, Phase: PhaseFinalize, Message: "the restore point has no readable permissions: " + err.Error()})
		return
	}
	if _, err := f.Seek(0, 0); err != nil {
		return
	}
	head, err := ReadSidecar(f, func(SidecarRecord) error { return ErrStopSidecar })
	if errors.Is(err, ErrSidecarNewer) {
		j.rep.Item(Item{Code: ItemACLFormatNewer, Phase: PhaseFinalize, Message: err.Error()})
		return
	}
	if err != nil {
		j.rep.Item(Item{Code: ItemACLNotRestored, Phase: PhaseFinalize, Message: "the permissions could not be read: " + err.Error()})
		return
	}
	if head.Header.Protocol != j.s.Expect.Protocol {
		j.rep.Item(Item{Code: ItemACLNotRestored, Phase: PhaseFinalize, Message: fmt.Sprintf(
			"the permissions of an %s share cannot be written to an %s share; the files keep the target's permissions",
			strings.ToUpper(head.Header.Protocol), strings.ToUpper(j.s.Expect.Protocol))})
		return
	}
	if head.Header.Xattr == ACLModeNone {
		return
	}
	if _, err := f.Seek(0, 0); err != nil {
		return
	}
	applier := &Applier{X: cfg.Sys, Protocol: j.s.Expect.Protocol, HeaderXattr: head.Header.Xattr}
	result, err := ReadSidecar(f, func(r SidecarRecord) error {
		if r.Entry == nil || r.Entry.Path == "" || !selected(p.Paths, r.Entry.Path) {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		rel := r.Entry.Path
		if placed != nil {
			t, ok := placedTarget(placed, rel)
			if !ok {
				return nil
			}
			rel = t
		} else {
			action, ok := touched[rel]
			if !ok {
				return nil
			}
			switch {
			case action == "restored" || action == "updated":
			case action == "unchanged" && plan.Overwrite == "if-changed":
			default:
				return nil
			}
			fi, err := os.Lstat(filepath.Join(destAbs, filepath.FromSlash(rel)))
			if err != nil || (plan.Overwrite == "never" && plan.Folder == "" && fi.IsDir()) {
				// skip: an existing folder of the original location stays as it is.
				return nil
			}
		}
		if _, err := applier.Apply(filepath.Join(destAbs, filepath.FromSlash(rel)), *r.Entry); err != nil {
			j.rep.Item(Item{Path: rel, Code: ItemACLNotRestored, Message: err.Error(), Phase: PhaseFinalize})
		}
		return nil
	})
	if err != nil {
		j.rep.Item(Item{Code: ItemACLNotRestored, Phase: PhaseFinalize, Message: "the permissions could not be read: " + err.Error()})
		return
	}
	for k, v := range applier.Levels {
		stats.PermissionsApplied[k] = v
	}
	stats.PermissionsFailed = applier.Failed
	if result.Trailer == nil {
		j.log.Printf("the saved permissions are incomplete (the backup ended early); applied what was there")
	}
	keys := make([]string, 0, len(applier.Levels))
	for k := range applier.Levels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	j.log.Printf("permissions written: %v, failed: %d", keys, applier.Failed)
}
