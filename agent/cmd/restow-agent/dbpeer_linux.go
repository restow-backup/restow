//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"syscall"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/dbprobe"
)

// The sign-in over the PostgreSQL socket (docs/DATABASES.md 3.2) uses `peer`:
// PostgreSQL signs in the system user of the connecting process. The agent
// (root) starts its own binary as that user for the one test, with the spec
// on stdin (it carries no credentials) and the facts on stdout.

// dbPeer runs the socket sign-in as osUser.
func dbPeer(ctx context.Context, osUser string, spec api.DBProbeSpec) (*api.DBProbeResult, error) {
	u, err := user.Lookup(osUser)
	if err != nil {
		return nil, fmt.Errorf("no system user %s", osUser)
	}
	uid, err1 := strconv.ParseUint(u.Uid, 10, 32)
	gid, err2 := strconv.ParseUint(u.Gid, 10, 32)
	if err1 != nil || err2 != nil {
		return nil, errors.New("the system user has no numeric ids")
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	spec.User, spec.Password = nil, nil
	in, err := json.Marshal(spec)
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	cmd := exec.CommandContext(cctx, exe, "db-probe-peer") // #nosec G204 -- the agent's own binary
	cmd.Stdin = bytes.NewReader(in)
	cmd.Dir = "/"
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "HOME=" + u.HomeDir}
	if os.Geteuid() == 0 {
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid)}}
	} else if fmt.Sprint(os.Geteuid()) != u.Uid {
		return nil, errors.New("the agent does not run as root")
	}
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	var res api.DBProbeResult
	if err := json.Unmarshal(out.Bytes(), &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// cmdDBProbePeer is the hidden helper `restow-agent db-probe-peer`: the agent
// starts it as the database's system user. Not for manual use.
func cmdDBProbePeer(stdin io.Reader, stdout, stderr io.Writer) int {
	var spec api.DBProbeSpec
	if err := json.NewDecoder(io.LimitReader(stdin, 64<<10)).Decode(&spec); err != nil {
		fmt.Fprintln(stderr, "db-probe-peer: the spec is not valid")
		return exitUsage
	}
	me, err := user.Current()
	if err != nil {
		fmt.Fprintln(stderr, "db-probe-peer: unknown system user")
		return exitUsage
	}
	res := dbprobe.RunPostgresPeer(context.Background(), spec, dbprobe.Options{}, me.Username)
	if err := json.NewEncoder(stdout).Encode(res); err != nil {
		return exitUsage
	}
	return exitOK
}
