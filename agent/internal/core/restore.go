package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/restic"
)

var snapshotIDRe = regexp.MustCompile(`^([0-9a-f]{8,64}|latest)$`)

func (a *Agent) runRestore(ctx context.Context, j job) {
	var params api.RestoreParams
	var parseErr error
	if j.task != nil {
		if len(j.task.Params) == 0 {
			parseErr = errors.New("the restore task has no parameters")
		} else {
			parseErr = json.Unmarshal(j.task.Params, &params)
		}
	}
	cfg := a.ensureConfig(ctx)
	rc, err := a.beginRun(ctx, api.RunRestore, j, cfg)
	if err != nil {
		a.startFailed(j, "restore", err)
		return
	}
	out := runOutcome{Status: api.StatusFailed}
	if parseErr != nil {
		out.fail("invalid_task", "Invalid restore parameters: %v", parseErr)
		rc.rl.Errorf("%s", out.Errors[0].Message)
	} else {
		out = a.doRestore(rc, params)
	}
	a.endRun(rc, out)
}

func (a *Agent) doRestore(rc *runContext, p api.RestoreParams) runOutcome {
	out := runOutcome{Status: api.StatusFailed}
	rl := rc.rl

	if !snapshotIDRe.MatchString(p.SnapshotID) {
		out.fail("invalid_task", "Invalid snapshot id %q.", p.SnapshotID)
		rl.Errorf("%s", out.Errors[0].Message)
		return out
	}
	for _, path := range p.Paths {
		if !strings.HasPrefix(path, "/") || strings.ContainsRune(path, 0) {
			out.fail("invalid_task", "Invalid path %q: restore paths are snapshot paths that start with /.", path)
			rl.Errorf("%s", out.Errors[0].Message)
			return out
		}
	}

	target := p.TargetDir
	if target == "" {
		var roots []string
		if rc.cfg != nil {
			roots = rc.cfg.Paths
		}
		target = defaultRestoreDir(roots, a.now())
	}
	prepared, err := prepareRestoreTarget(target)
	if err != nil {
		code := "target_unusable"
		var te *targetError
		if errors.As(err, &te) {
			code = te.code
		}
		out.fail(code, "%v", err)
		rl.Errorf("%s", out.Errors[0].Message)
		return out
	}
	target = prepared
	if len(p.Paths) == 0 {
		rl.Infof("Restoring snapshot %s completely into the new folder %s.", shortID(p.SnapshotID), target)
	} else {
		rl.Infof("Restoring %d selected item(s) of snapshot %s into the new folder %s.", len(p.Paths), shortID(p.SnapshotID), target)
	}

	reporter := newProgressReporter(a.d.Server, rc.runID, a.o.ProgressInterval, func(err error) {
		a.log.Debug("progress report not delivered", "error", err)
	})
	reporter.Start(rc.ctx)
	rctx, rcancel, timedOut := rc.resticContext()
	defer rcancel()
	res, err := rc.runner.Restore(rctx, restic.RestoreOptions{
		SnapshotID: p.SnapshotID, Target: target, Includes: p.Paths,
		OnProgress: func(pr restic.Progress) { reporter.Update(pr) },
	})
	reporter.Stop()

	if err != nil {
		var re *restic.Error
		switch {
		case rc.ctx.Err() != nil:
			out.fail("interrupted", "The restore was interrupted because the agent is stopping. Start it again from the Restow UI; files already restored in %s are complete or can be deleted.", target)
			out.Interrupted = true
		case timedOut():
			out.fail("timeout", "The restore did not finish within %s and was stopped.", maxRunTime)
			rl.Errorf("%s", out.Errors[0].Message)
		case errors.As(err, &re):
			msg := re.Error()
			if hint := re.Hint(); hint != "" {
				msg += ". " + hint
			}
			out.fail(fmt.Sprintf("restic_exit_%d", re.ExitCode), "%s", msg)
			rl.Errorf("%s", msg)
		default:
			out.fail("restic_error", "%v", err)
			rl.Errorf("%v", err)
		}
		rl.Warnf("The restore folder %s may contain a partial restore. Nothing outside of it was changed.", target)
		return out
	}

	for _, e := range res.Errors {
		out.Errors = append(out.Errors, api.RunError{Path: e.Path, Message: e.Message, Code: e.During})
	}
	if snapshotIDRe.MatchString(p.SnapshotID) && p.SnapshotID != "latest" {
		out.SnapshotID = p.SnapshotID
	}
	rl.Infof("Restore finished: %d files (%s) restored into %s and verified. No existing file was overwritten.",
		res.Summary.FilesRestored, formatBytes(res.Summary.BytesRestored), target)
	out.Status = api.StatusSucceeded
	out.Summary = fmt.Sprintf("restored %d files into %s", res.Summary.FilesRestored, target)
	return out
}
