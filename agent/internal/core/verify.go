package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/restic"
)

func (a *Agent) runVerify(ctx context.Context, j job) {
	var params api.VerifySampleParams
	var parseErr error
	if j.task != nil {
		if len(j.task.Params) == 0 {
			parseErr = errors.New("the verify_sample task has no parameters")
		} else {
			parseErr = json.Unmarshal(j.task.Params, &params)
		}
	}
	rc, err := a.beginRun(ctx, api.RunVerifySample, j, a.ensureConfig(ctx))
	if err != nil {
		a.startFailed(j, "verify_sample", err)
		return
	}
	out := runOutcome{Status: api.StatusFailed}
	if parseErr != nil {
		out.fail("invalid_task", "Invalid verify_sample parameters: %v", parseErr)
		rc.rl.Errorf("%s", out.Errors[0].Message)
	} else {
		out = a.doVerify(rc, params)
	}
	a.endRun(rc, out)
}

// doVerify restores the listed files into a temporary folder, compares their
// SHA-256 with the expected values and deletes the copy.
func (a *Agent) doVerify(rc *runContext, p api.VerifySampleParams) runOutcome {
	out := runOutcome{Status: api.StatusFailed}
	rl := rc.rl

	if !snapshotIDRe.MatchString(p.SnapshotID) {
		out.fail("invalid_task", "Invalid snapshot id %q.", p.SnapshotID)
		rl.Errorf("%s", out.Errors[0].Message)
		return out
	}
	if len(p.Files) == 0 {
		out.fail("invalid_task", "The restore test lists no files.")
		rl.Errorf("%s", out.Errors[0].Message)
		return out
	}
	includes := make([]string, 0, len(p.Files))
	for _, f := range p.Files {
		if !strings.HasPrefix(f.Path, "/") || strings.ContainsRune(f.Path, 0) || filepath.Clean(f.Path) != f.Path {
			out.fail("invalid_task", "Invalid file path %q in the restore test.", f.Path)
			rl.Errorf("%s", out.Errors[0].Message)
			return out
		}
		includes = append(includes, f.Path)
	}

	tmpRoot := a.d.Layout.TmpDir()
	if err := os.MkdirAll(tmpRoot, 0o700); err != nil {
		out.fail("tmp_unusable", "Cannot create the temporary folder %s: %v", tmpRoot, err)
		rl.Errorf("%s", out.Errors[0].Message)
		return out
	}
	tmp, err := os.MkdirTemp(tmpRoot, "verify-")
	if err != nil {
		out.fail("tmp_unusable", "Cannot create a temporary folder in %s: %v", tmpRoot, err)
		rl.Errorf("%s", out.Errors[0].Message)
		return out
	}
	defer func() {
		if err := removeAllForce(tmp); err != nil {
			rl.Warnf("The temporary copy in %s could not be deleted completely: %v", tmp, err)
		} else {
			rl.Infof("The temporary copy was deleted.")
		}
	}()
	rl.Infof("Restoring %d sample file(s) of snapshot %s into a temporary folder.", len(includes), shortID(p.SnapshotID))

	_, err = rc.runner.Restore(rc.ctx, restic.RestoreOptions{SnapshotID: p.SnapshotID, Target: tmp, Includes: includes})
	if err != nil {
		var re *restic.Error
		switch {
		case rc.ctx.Err() != nil:
			out.fail("interrupted", "The restore test was interrupted because the agent is stopping.")
			out.Interrupted = true
		case errors.As(err, &re):
			msg := re.Error()
			if hint := re.Hint(); hint != "" {
				msg += ". " + hint
			}
			out.fail(fmt.Sprintf("restic_exit_%d", re.ExitCode), "%s", msg)
			rl.Errorf("%s", msg)
			// The server tells from restic's own words whether the backup is
			// damaged or the test could not complete; what restic restored
			// anyway is checked as well.
			files, _ := inspectRestoredFiles(tmp, p.Files, rc.ctx.Done())
			if rc.ctx.Err() == nil {
				out.RestoreTest = &api.RestoreTest{Files: reportFiles(files), Restic: resticFailureOf(re)}
			}
			out.SnapshotID = p.SnapshotID
		default:
			out.fail("restic_error", "%v", err)
			rl.Errorf("%v", err)
		}
		return out
	}

	files, problems := inspectRestoredFiles(tmp, p.Files, rc.ctx.Done())
	if rc.ctx.Err() != nil {
		interruptedOutcome(&out)
		return out
	}
	out.RestoreTest = &api.RestoreTest{Files: reportFiles(files)}
	for i, f := range p.Files {
		if problem := problems[i]; problem != nil {
			rl.Errorf("%s: %s", f.Path, problem.Message)
			out.Errors = append(out.Errors, *problem)
			continue
		}
		out.Sample = append(out.Sample, api.SampleFile{Path: f.Path, SHA256: strings.ToLower(f.SHA256), Size: files[i].size})
	}
	ok := len(out.Sample)
	if len(out.Errors) > 0 {
		rl.Errorf("Restore test failed: %d of %d files did not match.", len(out.Errors), len(p.Files))
		out.Status = api.StatusFailed
		out.SnapshotID = p.SnapshotID
		out.Summary = fmt.Sprintf("%d of %d files did not match", len(out.Errors), len(p.Files))
		return out
	}
	rl.Infof("Restore test passed: all %d files restored with matching SHA-256.", ok)
	out.Status = api.StatusSucceeded
	out.SnapshotID = p.SnapshotID
	out.Summary = fmt.Sprintf("%d files verified", ok)
	return out
}

// maxResticMessageBytes bounds one message restic wrote in the report.
const maxResticMessageBytes = 1000

// resticFailureOf is restic's failure as the server needs it to judge it.
func resticFailureOf(re *restic.Error) *api.ResticFailure {
	f := &api.ResticFailure{ExitCode: re.ExitCode, Fatal: boundMessage(re.Fatal)}
	for _, item := range re.Items {
		if len(f.Errors) == api.MaxResticItemErrors {
			break
		}
		f.Errors = append(f.Errors, api.ResticItemError{Item: item.Path, Message: boundMessage(item.Message)})
	}
	return f
}

// boundMessage shortens a long message in the middle: restic names the cause
// last, after paths that can be long.
func boundMessage(s string) string {
	if len(s) <= maxResticMessageBytes {
		return s
	}
	head, tail := 200, maxResticMessageBytes-200-5
	return strings.ToValidUTF8(s[:head]+" ... "+s[len(s)-tail:], "")
}

// inspectedFile is a RestoreTestFile with the size of the restored copy.
type inspectedFile struct {
	api.RestoreTestFile
	size int64
}

// inspectRestoredFiles looks at every task file in the restored copy below
// root and hashes it. problems[i] is nil when file i matches its expected
// hash, else the run error that says why not.
func inspectRestoredFiles(root string, want []api.SampleFile, done <-chan struct{}) ([]inspectedFile, []*api.RunError) {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		realRoot = root
	}
	files := make([]inspectedFile, len(want))
	problems := make([]*api.RunError, len(want))
	for i, f := range want {
		files[i], problems[i] = inspectRestoredFile(realRoot, f, done)
	}
	return files, problems
}

func reportFiles(files []inspectedFile) []api.RestoreTestFile {
	out := make([]api.RestoreTestFile, len(files))
	for i, f := range files {
		out[i] = f.RestoreTestFile
	}
	return out
}

// inspectRestoredFile hashes one restored file and compares it with the
// expected value. Only regular files inside the temporary folder are read (no
// symbolic links). A file that is not there is missing; anything else that
// keeps it from being read is a problem of this machine, not of the backup.
func inspectRestoredFile(root string, f api.SampleFile, done <-chan struct{}) (inspectedFile, *api.RunError) {
	got := inspectedFile{RestoreTestFile: api.RestoreTestFile{Path: f.Path}}
	local := filepath.Join(root, filepath.FromSlash(f.Path))
	st, err := os.Lstat(local)
	if errors.Is(err, fs.ErrNotExist) {
		got.Missing = true
		return got, &api.RunError{Path: f.Path, Code: "missing", Message: "The file was not restored (not found in the snapshot)."}
	}
	if err != nil {
		got.Error = "The restored file cannot be read: " + err.Error()
		return got, &api.RunError{Path: f.Path, Code: "read_error", Message: got.Error}
	}
	if !st.Mode().IsRegular() {
		got.Error = "The restored item is not a regular file."
		return got, &api.RunError{Path: f.Path, Code: "not_regular", Message: got.Error}
	}
	real, err := filepath.EvalSymlinks(local)
	if err != nil || (real != root && !strings.HasPrefix(real, root+string(filepath.Separator))) {
		got.Error = "The restored path leaves the temporary folder."
		return got, &api.RunError{Path: f.Path, Code: "not_regular", Message: got.Error}
	}
	sum, size, err := hashFile(local, done)
	if err != nil {
		got.Error = "The restored file cannot be read: " + err.Error()
		return got, &api.RunError{Path: f.Path, Code: "read_error", Message: got.Error}
	}
	got.SHA256, got.size = sum, size
	if !strings.EqualFold(sum, f.SHA256) {
		return got, &api.RunError{Path: f.Path, Code: "hash_mismatch",
			Message: fmt.Sprintf("SHA-256 mismatch: expected %s, restored file has %s.", strings.ToLower(f.SHA256), sum)}
	}
	return got, nil
}
