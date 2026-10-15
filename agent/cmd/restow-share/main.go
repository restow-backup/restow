// Command restow-share is the runner of Restow's file share backups
// (docs/FILESHARES.md section 4). The mounter starts it in a short-lived
// container from the Restow image, with the SMB or NFS share mounted at
// /share by the host kernel:
//
//	restow-share probe --expect smb|nfs        check the mount, list the top level, check ACL access
//	restow-share list --path <rel> --limit <n>  one folder level of the live share
//	restow-share run                           a backup or restore run (session from the api)
//	restow-share version
//
// It takes no secret from its arguments: `run` reads RESTOW_SHARE_RUN_ID and
// RESTOW_SHARE_RUN_TOKEN from the environment and hands restic its
// credentials through restic's environment only.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"regexp"
	"syscall"

	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/share"
)

const usage = `restow-share %s - the file share runner of Restow

Usage: restow-share <command> [options]

Commands:
  probe --expect smb|nfs          check the mount at /share (JSON on stdout)
  list --path <rel> --limit <n>   list one folder of the share (JSON on stdout)
  run                             a backup or restore run (RESTOW_SHARE_* environment)
  version                         print the version (--short)
`

func main() { os.Exit(run(os.Args[1:], os.Getenv, os.Stdout, os.Stderr)) }

var (
	runIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

// deps are what main wires and the tests replace.
type deps struct {
	cfg share.Config
}

var defaultDeps = func() deps { return deps{cfg: share.DefaultConfig()} }

func run(args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	return runWith(defaultDeps(), args, getenv, stdout, stderr)
}

func runWith(d deps, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintf(stderr, usage, buildinfo.Version)
		return share.ExitUsage
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "probe":
		fs := flag.NewFlagSet("probe", flag.ContinueOnError)
		fs.SetOutput(stderr)
		expect := fs.String("expect", getenv("RESTOW_SHARE_EXPECT"), "smb or nfs")
		if err := fs.Parse(rest); err != nil || !validProtocol(*expect) {
			fmt.Fprintln(stderr, "restow-share probe: --expect smb|nfs is required")
			return share.ExitUsage
		}
		res, code := share.Probe(d.cfg.Sys, d.cfg.Root, *expect, d.cfg.Now)
		writeJSON(stdout, res)
		return code
	case "list":
		fs := flag.NewFlagSet("list", flag.ContinueOnError)
		fs.SetOutput(stderr)
		expect := fs.String("expect", getenv("RESTOW_SHARE_EXPECT"), "smb or nfs")
		path := fs.String("path", "", "folder relative to the share root")
		limit := fs.Int("limit", share.DefaultListLimit, "at most this many entries (2000)")
		if err := fs.Parse(rest); err != nil || !validProtocol(*expect) {
			fmt.Fprintln(stderr, "restow-share list: --expect smb|nfs (or RESTOW_SHARE_EXPECT) is required")
			return share.ExitUsage
		}
		res, code := share.List(d.cfg.Sys, d.cfg.Root, *expect, *path, *limit, d.cfg.Now)
		writeJSON(stdout, res)
		return code
	case "run":
		apiURL := getenv("RESTOW_SHARE_API_URL")
		runID := getenv("RESTOW_SHARE_RUN_ID")
		token := getenv("RESTOW_SHARE_RUN_TOKEN")
		if apiURL == "" || !runIDPattern.MatchString(runID) || !tokenPattern.MatchString(token) {
			// Never print the token, not even a malformed one.
			fmt.Fprintln(stderr, "restow-share run: RESTOW_SHARE_API_URL, RESTOW_SHARE_RUN_ID and RESTOW_SHARE_RUN_TOKEN must be set")
			return share.ExitUsage
		}
		cfg := d.cfg
		if v := getenv("GOMEMLIMIT"); v != "" {
			cfg.GoMemLimit = v
		}
		cfg.Stdout, cfg.Stderr = stdout, stderr
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
		defer cancel()
		client := &share.Client{BaseURL: apiURL, RunID: runID, Token: token}
		return share.Run(ctx, cfg, client)
	case "version", "--version":
		if len(rest) > 0 && rest[0] == "--short" {
			fmt.Fprintln(stdout, buildinfo.Version)
		} else {
			fmt.Fprintf(stdout, "restow-share %s (%s, %s)\n", buildinfo.Version, buildinfo.Commit, buildinfo.Date)
		}
		return share.ExitOK
	case "help", "-h", "--help":
		fmt.Fprintf(stdout, usage, buildinfo.Version)
		return share.ExitOK
	}
	fmt.Fprintf(stderr, "restow-share: unknown command %q\n\n", cmd)
	fmt.Fprintf(stderr, usage, buildinfo.Version)
	return share.ExitUsage
}

func validProtocol(p string) bool { return p == share.ProtocolSMB || p == share.ProtocolNFS }

func writeJSON(w io.Writer, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		b = []byte(`{"ok":false,"code":"internal","detail":"cannot encode the result"}`)
	}
	fmt.Fprintln(w, string(b))
}
