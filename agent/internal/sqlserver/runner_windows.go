//go:build windows

package sqlserver

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/restow-backup/restow/agent/internal/hooks"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/procctl"
	"github.com/restow-backup/restow/agent/internal/procenv"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// winRunner runs sql.ps1 with Windows PowerShell 5.1 (C6): the script file
// lives in the agent's protected tmp folder with a DACL for SYSTEM and the
// Administrators only and is checked against the embedded script before
// each start; the process runs without a window, with the agent's reduced
// environment, in its own Job object.
type winRunner struct {
	dir string
	// stderr receives the bounded error output of each run (may be nil).
	stderr func(string)
	mu     sync.Mutex
}

// NewScriptRunner returns the runner of this machine; tmpDir is the agent's
// tmp folder (data\tmp), stderr gets the script's error output for the log.
func NewScriptRunner(tmpDir string, stderr func(string)) (ScriptRunner, error) {
	return &winRunner{dir: tmpDir, stderr: stderr}, nil
}

// ensureScript writes the script if its file is missing or differs and
// returns its path; the file is checked once more right before the start.
func (r *winRunner) ensureScript() (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := os.MkdirAll(r.dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(r.dir, ScriptFileName())
	if scriptIntact(path) {
		return path, winapi.SetFileDACL(path, paths.PrivateFileSDDL)
	}
	_ = os.Remove(path)
	tmp := path + fmt.Sprintf(".%d.tmp", os.Getpid())
	_ = os.Remove(tmp)
	h, err := winapi.CreateFileSDDL(tmp, paths.PrivateFileSDDL)
	if err != nil {
		return "", err
	}
	f := os.NewFile(uintptr(h), tmp)
	_, werr := f.Write(Script)
	cerr := f.Close()
	if werr != nil || cerr != nil {
		_ = os.Remove(tmp)
		return "", errors.Join(werr, cerr)
	}
	if err := winapi.RenameReplacing(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return path, nil
}

func scriptIntact(path string) bool {
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]) == ScriptSHA256
}

func (r *winRunner) Run(ctx context.Context, req Request, progress func(Line)) Result {
	script, err := r.ensureScript()
	if err == nil && !scriptIntact(script) {
		err = errors.New("the script file changed after it was written")
	}
	if err != nil {
		return Finish(Output{}, -1, fmt.Errorf("the script file could not be prepared: %w", err), false, false, "")
	}
	ps, err := hooks.PowerShellExe()
	if err != nil {
		return Finish(Output{}, -1, err, false, false, "")
	}
	body, err := EncodeRequest(req)
	if err != nil {
		return Finish(Output{}, -1, err, false, false, "")
	}
	cmd := exec.Command(ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script)
	cmd.Env = procenv.Base()
	if sys, err := winapi.SystemDirectory(); err == nil {
		cmd.Dir = sys
	}
	cmd.Stdin = bytes.NewReader(body)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | winapi.CreateNoWindow}
	stderr := &tailBuffer{n: MaxStderrBytes}
	cmd.Stderr = stderr
	pr, pw, err := os.Pipe()
	if err != nil {
		return Finish(Output{}, -1, err, false, false, "")
	}
	cmd.Stdout = pw
	if err := cmd.Start(); err != nil {
		_ = pr.Close()
		_ = pw.Close()
		return Finish(Output{}, -1, err, false, false, "")
	}
	_ = pw.Close()
	job, attachErr := procctl.Attach(cmd.Process)

	read := make(chan Output, 1)
	go func() { read <- ReadOutput(pr, progress) }()
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()

	limit := time.NewTimer(KillAfter(req))
	defer limit.Stop()
	timedOut, cancelled := false, false
	stop := func() {
		if job != nil {
			_ = job.Terminate()
		} else {
			_ = cmd.Process.Kill()
		}
	}
	select {
	case <-waited:
	case <-limit.C:
		timedOut = true
		stop()
		<-waited
	case <-ctx.Done():
		cancelled = true
		stop()
		<-waited
	}
	if job != nil {
		job.Close() // KILL_ON_JOB_CLOSE: nothing the script started lives on
	}
	var out Output
	select {
	case out = <-read:
	case <-time.After(5 * time.Second):
		_ = pr.Close()
		out = <-read
	}
	_ = pr.Close()
	if r.stderr != nil && stderr.String() != "" {
		r.stderr(stderr.String())
	}
	exit := -1
	if cmd.ProcessState != nil {
		exit = cmd.ProcessState.ExitCode()
	}
	if attachErr != nil {
		return Finish(Output{}, exit, attachErr, false, false, stderr.String())
	}
	return Finish(out, exit, nil, timedOut, cancelled, stderr.String())
}
