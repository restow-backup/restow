//go:build linux

package fssnap

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/restow-backup/restow/agent/internal/cmdrun"
	"github.com/restow-backup/restow/agent/internal/procenv"
)

// ExecHelper starts `restow-agent snapshot-exec` in a new mount namespace
// (SysProcAttr.Unshareflags CLONE_NEWNS; the Go runtime makes / private in
// the child before it runs). Everything it mounts disappears with it.
type ExecHelper struct {
	AgentBin string
	// TmpDir holds the spec files (private, the agent's TmpDir).
	TmpDir string
	// Timeout of one plain command (default 2 minutes).
	Timeout time.Duration
}

// WriteSpec writes a spec file (0600) and returns its path and a cleanup.
func (e ExecHelper) WriteSpec(spec Spec) (string, func(), error) {
	b, err := spec.Encode()
	if err != nil {
		return "", func() {}, err
	}
	if err := os.MkdirAll(e.TmpDir, 0o700); err != nil {
		return "", func() {}, err
	}
	f, err := os.CreateTemp(e.TmpDir, "snapshot-spec-*.json")
	if err != nil {
		return "", func() {}, err
	}
	name := f.Name()
	_, werr := f.Write(b)
	cerr := f.Close()
	if werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Chmod(name, 0o600)
	}
	if werr != nil {
		_ = os.Remove(name)
		return "", func() {}, werr
	}
	return name, func() { _ = os.Remove(name) }, nil
}

func (e ExecHelper) command(ctx context.Context, specFile string, argv []string) *exec.Cmd {
	full := HelperArgv(e.AgentBin, specFile, argv)
	cmd := exec.CommandContext(ctx, full[0], full[1:]...)
	// The helper dies with the agent: its namespace and every mount in it
	// go away, so no snapshot stays open after a kill -9 (6.5).
	cmd.SysProcAttr = &syscall.SysProcAttr{Unshareflags: syscall.CLONE_NEWNS, Pdeathsig: syscall.SIGKILL}
	cmd.Env = procenv.Set(procenv.Base(), "LC_ALL", "C")
	cmd.WaitDelay = 5 * time.Second
	return cmd
}

// Run mounts the plain spec in a private namespace and runs argv there.
func (e ExecHelper) Run(ctx context.Context, spec Spec, argv []string) ([]byte, error) {
	if err := cmdrun.Forbidden(argv); err != nil {
		return nil, err
	}
	t := e.Timeout
	if t == 0 {
		t = 2 * time.Minute
	}
	cctx, cancel := context.WithTimeout(ctx, t)
	defer cancel()
	file, cleanup, err := e.WriteSpec(spec)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	cmd := e.command(cctx, file, argv)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err = cmd.Run()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			msg := strings.TrimSpace(stderr.String())
			if strings.Contains(msg, "operation not permitted") && strings.Contains(msg, "snapshot-exec:") {
				return stdout.Bytes(), fmt.Errorf("%w: %s", ErrNoHelper, msg)
			}
			return stdout.Bytes(), &cmdrun.ExitError{Argv: argv, Code: ee.ExitCode(), Stderr: msg}
		}
		if errors.Is(err, syscall.EPERM) || errors.Is(err, os.ErrPermission) {
			return nil, fmt.Errorf("%w: %v", ErrNoHelper, err)
		}
		return nil, err
	}
	return stdout.Bytes(), nil
}

// Measure builds the tree and measures in it.
func (e ExecHelper) Measure(ctx context.Context, spec Spec, req MeasureRequest) (MeasureResponse, error) {
	var resp MeasureResponse
	file, cleanup, err := e.WriteSpec(spec)
	if err != nil {
		return resp, err
	}
	defer cleanup()
	in, err := json.Marshal(req)
	if err != nil {
		return resp, err
	}
	cmd := e.command(ctx, file, nil)
	var stdout, stderr bytes.Buffer
	cmd.Stdin, cmd.Stdout, cmd.Stderr = bytes.NewReader(in), &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return resp, fmt.Errorf("measuring in the snapshot tree failed: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	err = json.Unmarshal(stdout.Bytes(), &resp)
	return resp, err
}

// Probe runs `true` through the helper.
func (e ExecHelper) Probe(ctx context.Context) error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("%w: the agent does not run as root", ErrNoHelper)
	}
	if _, err := e.Run(ctx, Spec{Kind: SpecPlain}, []string{"true"}); err != nil {
		if errors.Is(err, ErrNoHelper) {
			return err
		}
		return fmt.Errorf("%w: %v", ErrNoHelper, err)
	}
	return nil
}

// RunHelper is the helper process (`restow-agent snapshot-exec`): it mounts
// the spec, aborting on the first failure, then (tree) chroots into the
// tree and either execs argv (restic) or measures, or (plain) creates the
// folders and execs argv (a btrfs command).
func RunHelper(spec Spec, argv []string, measure bool, stdin io.Reader, stdout io.Writer) error {
	// The runtime made / private already; do it again for safety: nothing
	// mounted here may propagate to the host.
	if err := syscall.Mount("", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, ""); err != nil {
		return fmt.Errorf("snapshot-exec: making / private: %w", err)
	}
	switch spec.Kind {
	case SpecTree:
		if spec.Root == "" {
			spec.Root = SnapTreeDir
		}
		if err := os.MkdirAll(spec.Root, 0o700); err != nil {
			return err
		}
	case SpecPlain:
		if err := os.MkdirAll(BtrfsTopDir, 0o700); err != nil {
			return err
		}
	default:
		return fmt.Errorf("snapshot-exec: unknown spec kind %q", spec.Kind)
	}
	for _, m := range spec.Mounts {
		if spec.Kind == SpecPlain {
			if err := os.MkdirAll(m.Target, 0o700); err != nil {
				return err
			}
		}
		if err := doMount(m); err != nil {
			return fmt.Errorf("snapshot-exec: mounting %s on %s: %w", m.Source, m.Target, err)
		}
	}
	for _, d := range spec.Mkdirs {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return fmt.Errorf("snapshot-exec: %w", err)
		}
	}
	if spec.Kind == SpecTree {
		if err := syscall.Chroot(spec.Root); err != nil {
			return fmt.Errorf("snapshot-exec: chroot: %w", err)
		}
		if err := os.Chdir("/"); err != nil {
			return err
		}
		if measure {
			var req MeasureRequest
			if err := json.NewDecoder(io.LimitReader(stdin, 16<<20)).Decode(&req); err != nil {
				return fmt.Errorf("snapshot-exec: reading the measure request: %w", err)
			}
			return json.NewEncoder(stdout).Encode(HandleMeasure(req))
		}
		if len(argv) == 0 {
			return errors.New("snapshot-exec: no command")
		}
		return syscall.Exec(argv[0], argv, os.Environ())
	}
	if len(argv) == 0 {
		return errors.New("snapshot-exec: no command")
	}
	if err := cmdrun.Forbidden(argv); err != nil {
		return err
	}
	bin, err := (cmdrun.ExecRunner{}).Resolve(argv[0])
	if err != nil {
		return err
	}
	return syscall.Exec(bin, argv, os.Environ())
}

// doMount performs one mount of a spec.
func doMount(m Mount) error {
	var flags uintptr
	var data []string
	ro := false
	for _, o := range strings.Split(m.Options, ",") {
		switch o {
		case "":
		case "ro":
			ro = true
		case "rw":
		case "nosuid":
			flags |= syscall.MS_NOSUID
		case "nodev":
			flags |= syscall.MS_NODEV
		case "noexec":
			flags |= syscall.MS_NOEXEC
		default:
			data = append(data, o)
		}
	}
	if m.Bind {
		bf := uintptr(syscall.MS_BIND)
		if m.Recursive {
			bf |= syscall.MS_REC
		}
		if err := syscall.Mount(m.Source, m.Target, "", bf, ""); err != nil {
			return err
		}
		if ro {
			// A bind mount becomes read-only with a remount.
			return syscall.Mount("", m.Target, "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY|flags, "")
		}
		return nil
	}
	if ro {
		flags |= syscall.MS_RDONLY
	}
	return syscall.Mount(m.Source, m.Target, m.FSType, flags, strings.Join(data, ","))
}
