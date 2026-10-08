// Command restow-pve is the node helper of Restow for Proxmox VE: it backs up
// VMs and containers through the PVE backup provider interface into a Restow
// instance and restores them as new guests. The storage plugin shim (Perl, a
// separate work under AGPL-3.0-or-later, see docs/PVE.md) calls it
// as `restow-pve provider <verb>` with JSON on stdin and stdout; the protocol
// is documented in docs/PVE-PROTOCOL.md. It also runs standalone: status,
// diagnose and test need no running backup.
package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/pve"
)

const usage = `restow-pve %s - Restow node helper for Proxmox VE

Usage: restow-pve <command> [options]

Commands:
  enroll          Enroll this node (token, PVE API token and fleecing storage)
  run             The service main loop (what restow-pve.service executes)
  status          Local state and the last heartbeat (--json)
  diagnose        Check everything a backup needs and print the findings (--json)
  test            Like diagnose, exit code 0 only when everything is in order
  config          Change local settings (--allow-restores, --fleecing-storage, ...)
  update          Install a newer release the Restow instance offers
  uninstall       Remove the helper, the storage plugin and the local state (--yes)
  provider VERB   Called by the storage plugin (JSON on stdin and stdout)
  serve-restore   Serve one disk of a restore point over NBD (started by the provider)
  version         Print the version (--short)
`

func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintf(stderr, usage, buildinfo.Version)
		return 2
	}
	layout := pve.DefaultLayout()
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "provider":
		return cmdProvider(layout, rest, stdin, stdout, stderr)
	case "enroll":
		return cmdEnroll(layout, rest, stdin, stdout, stderr)
	case "run":
		return cmdRun(layout, stderr)
	case "status":
		return cmdStatus(layout, rest, stdout, stderr)
	case "diagnose":
		return cmdDiagnose(layout, rest, stdout, stderr, false)
	case "test":
		return cmdDiagnose(layout, rest, stdout, stderr, true)
	case "config":
		return cmdConfig(layout, rest, stdout, stderr)
	case "update":
		return cmdUpdate(layout, stdout, stderr)
	case "uninstall":
		return cmdUninstall(layout, rest, stdout, stderr)
	case "serve-restore":
		return cmdServeRestore(layout, rest, stderr)
	case "version", "--version":
		if len(rest) > 0 && rest[0] == "--short" {
			fmt.Fprintln(stdout, buildinfo.Version)
		} else {
			fmt.Fprintf(stdout, "restow-pve %s (%s, %s)\n", buildinfo.Version, buildinfo.Commit, buildinfo.Date)
		}
		return 0
	case "help", "-h", "--help":
		fmt.Fprintf(stdout, usage, buildinfo.Version)
		return 0
	}
	fmt.Fprintf(stderr, "restow-pve: unknown command %q\n\n", cmd)
	fmt.Fprintf(stderr, usage, buildinfo.Version)
	return 2
}

func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
}

// --- provider ----------------------------------------------------------------

func cmdProvider(layout pve.Layout, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) != 1 {
		fmt.Fprintln(stderr, "err: usage: restow-pve provider <verb>")
		return 2
	}
	verb := args[0]
	enc := json.NewEncoder(stdout)
	var req pve.ProviderRequest
	data, err := io.ReadAll(io.LimitReader(stdin, 16<<20))
	if err == nil && len(strings.TrimSpace(string(data))) > 0 {
		err = json.Unmarshal(data, &req)
	}
	if err != nil {
		_ = enc.Encode(pve.ProviderResponse{Error: "invalid request: " + err.Error()})
		return 1
	}
	exe, _ := os.Executable()
	p := &pve.Provider{Layout: layout, Log: stderr, Exe: exe}
	ctx, cancel := signalContext()
	defer cancel()
	result, err := p.Handle(ctx, verb, req)
	if err != nil {
		_ = enc.Encode(pve.ProviderResponse{Error: err.Error()})
		return 1
	}
	_ = enc.Encode(pve.ProviderResponse{OK: true, Result: result})
	return 0
}

// --- enroll ----------------------------------------------------------------

var clusterNameRE = regexp.MustCompile(`(?m)^\s*cluster_name:\s*(\S+)`)

// clusterFacts reads the cluster name and a fingerprint every node of the
// cluster shares: the SHA-256 of the cluster CA certificate.
func clusterFacts() (name, fingerprint string) {
	root := os.Getenv("RESTOW_PVE_ROOT")
	if data, err := os.ReadFile(root + "/etc/pve/corosync.conf"); err == nil {
		if m := clusterNameRE.FindSubmatch(data); m != nil {
			name = string(m[1])
		}
	}
	if data, err := os.ReadFile(root + pve.ClusterCAFile); err == nil {
		sum := sha256.Sum256(data)
		fingerprint = hex.EncodeToString(sum[:])
	}
	return name, fingerprint
}

func readSecretArg(direct, file string) (string, error) {
	if file != "" {
		data, err := os.ReadFile(file)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(data)), nil
	}
	return strings.TrimSpace(direct), nil
}

func cmdEnroll(layout pve.Layout, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("enroll", flag.ContinueOnError)
	fs.SetOutput(stderr)
	url := fs.String("url", os.Getenv("RESTOW_URL"), "Restow instance URL")
	tokenFile := fs.String("token-file", os.Getenv("RESTOW_TOKEN_FILE"), "file with the one-time enrollment token")
	tokenID := fs.String("pve-token-id", os.Getenv("RESTOW_PVE_TOKEN_ID"), "PVE API token id (restow@pve!restow)")
	tokenSecretFile := fs.String("pve-token-secret-file", os.Getenv("RESTOW_PVE_TOKEN_SECRET_FILE"), "file with the PVE API token secret")
	fleecing := fs.String("fleecing-storage", os.Getenv("RESTOW_PVE_FLEECING"), "thin storage of this node for fleecing images")
	node := fs.String("node", "", "PVE node name (default: the host name)")
	insecure := fs.Bool("allow-insecure-http", false, "development only: accept http:// URLs")
	force := fs.Bool("force", false, "enroll again although this node is enrolled")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if existing, err := pve.LoadState(layout.StateFile); err == nil && existing.NodeID != "" && !*force {
		fmt.Fprintf(stdout, "This node is already enrolled (node %s). Use --force to enroll again.\n", existing.NodeID)
		return 0
	}
	token, err := readSecretArg(os.Getenv("RESTOW_TOKEN"), *tokenFile)
	if err != nil {
		fmt.Fprintln(stderr, "restow-pve:", err)
		return 1
	}
	secret, err := readSecretArg(os.Getenv("RESTOW_PVE_TOKEN_SECRET"), *tokenSecretFile)
	if err != nil {
		fmt.Fprintln(stderr, "restow-pve:", err)
		return 1
	}
	if token == "" || secret == "" || *url == "" || *tokenID == "" {
		fmt.Fprintln(stderr, "restow-pve: enroll needs --url, the enrollment token (RESTOW_TOKEN_FILE), --pve-token-id and the token secret (RESTOW_PVE_TOKEN_SECRET_FILE)")
		return 2
	}
	_ = stdin
	nodeName := *node
	if nodeName == "" {
		h, _ := os.Hostname()
		nodeName, _, _ = strings.Cut(h, ".")
	}
	st := &pve.State{URL: *url, NodeName: nodeName, PVETokenID: *tokenID, PVETokenSecret: secret,
		FleecingStorage: *fleecing, AllowInsecureHTTP: *insecure}
	ctx, cancel := signalContext()
	defer cancel()
	api, err := pve.NewPVEAPI(st.PVEAPIURL, st.PVETokenID, st.PVETokenSecret, os.Getenv("RESTOW_PVE_ROOT")+pve.ClusterCAFile, "")
	if err != nil {
		fmt.Fprintln(stderr, "restow-pve:", err)
		return 1
	}
	version, err := api.Version(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "restow-pve: the PVE API does not accept the token: %v\n", err)
		return 1
	}
	if !pve.VersionAtLeast(version, 8, 4) {
		fmt.Fprintf(stderr, "restow-pve: Proxmox VE %s is too old; the backup provider interface needs 8.4 or newer\n", version)
		return 1
	}
	if perms, err := api.Permissions(ctx); err == nil {
		if missing := pve.MissingPrivileges(perms); len(missing) > 0 {
			fmt.Fprintf(stderr, "restow-pve: the token lacks %s on / (see docs/PVE.md, onboarding)\n", strings.Join(missing, ", "))
			return 1
		}
	}
	name, fp := clusterFacts()
	if name == "" {
		name = nodeName
	}
	srv, err := pve.NewServer(*url, "", "", *insecure)
	if err != nil {
		fmt.Fprintln(stderr, "restow-pve:", err)
		return 1
	}
	res, err := srv.Enroll(ctx, pve.EnrollRequest{Token: token, ClusterName: name, ClusterFingerprint: fp,
		NodeName: nodeName, PVEVersion: version, HelperVersion: buildinfo.Version, FleecingStorage: *fleecing})
	if err != nil {
		fmt.Fprintf(stderr, "restow-pve: enrollment failed: %v\n", err)
		return 1
	}
	st.NodeID, st.NodeSecret, st.ClusterID, st.StorageID = res.NodeID, res.NodeSecret, res.ClusterID, res.StorageID
	if err := pve.SaveState(layout.StateFile, st); err != nil {
		fmt.Fprintln(stderr, "restow-pve: save state:", err)
		return 1
	}
	fmt.Fprintf(stdout, "Enrolled node %s (%s) of cluster %s; PVE storage id %s.\n", nodeName, res.NodeID, name, res.StorageID)
	if res.CreatedCluster {
		fmt.Fprintf(stdout, "First node of this cluster: add the storage once with\n  pvesm add restow %s --content backup --nodes <nodes with restow-pve>\n", res.StorageID)
	}
	return 0
}

// --- run, status, diagnose -----------------------------------------------------

func loadService(layout pve.Layout) (*pve.Service, error) {
	st, err := pve.LoadState(layout.StateFile)
	if err != nil {
		return nil, err
	}
	if err := st.Validate(); err != nil {
		return nil, err
	}
	srv, err := pve.NewServer(st.URL, st.NodeID, st.NodeSecret, st.AllowInsecureHTTP)
	if err != nil {
		return nil, err
	}
	api, err := pve.NewPVEAPI(st.PVEAPIURL, st.PVETokenID, st.PVETokenSecret, os.Getenv("RESTOW_PVE_ROOT")+pve.ClusterCAFile, st.PVECertSHA256)
	if err != nil {
		return nil, err
	}
	return &pve.Service{Layout: layout, State: st, Server: srv, PVE: api}, nil
}

func cmdRun(layout pve.Layout, stderr io.Writer) int {
	s, err := loadService(layout)
	if err != nil {
		fmt.Fprintln(stderr, "restow-pve:", err)
		return 1
	}
	logger := func(f string, a ...any) {
		fmt.Fprintf(stderr, "%s %s\n", time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(f, a...))
	}
	s.Logf = logger
	ctx, cancel := signalContext()
	defer cancel()
	logger("restow-pve %s started for node %s", buildinfo.Version, s.State.NodeName)
	go func() {
		// Self-update: asked for every six hours, applied while idle.
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(6 * time.Hour):
			}
			if v, err := s.Server.UpdateOffer(ctx); err == nil && v != "" {
				if err := pve.SelfUpdate(ctx, layout, s.Server, buildinfo.Version, v); err == nil {
					logger("updated to %s, restarting", v)
					cancel()
					os.Exit(0) // systemd restarts the unit with the new binary
				} else {
					logger("update to %s not applied: %v", v, err)
				}
			}
		}
	}()
	if err := s.Run(ctx); err != nil {
		logger("%v", err)
		return 1
	}
	return 0
}

func cmdStatus(layout pve.Layout, args []string, stdout, stderr io.Writer) int {
	st, err := pve.LoadState(layout.StateFile)
	if err != nil {
		fmt.Fprintln(stderr, "restow-pve:", err)
		return 1
	}
	var svc pve.ServiceStatus
	data, _ := os.ReadFile(layout.ServiceStatus())
	_ = json.Unmarshal(data, &svc)
	out := map[string]any{
		"version": buildinfo.Version, "url": st.URL, "nodeId": st.NodeID, "node": st.NodeName,
		"clusterId": st.ClusterID, "storageId": st.StorageID, "fleecingStorage": st.FleecingStorage,
		"restoresAllowed": st.RestoresAllowed(), "service": svc,
	}
	if len(args) > 0 && args[0] == "--json" {
		_ = json.NewEncoder(stdout).Encode(out)
		return 0
	}
	fmt.Fprintf(stdout, "restow-pve %s\nnode:      %s (%s)\ninstance:  %s\nstorage:   %s\nfleecing:  %s\nrestores:  %v\nheartbeat: %s %s\nproblems:  %s\n",
		buildinfo.Version, st.NodeName, st.NodeID, st.URL, st.StorageID, st.FleecingStorage, st.RestoresAllowed(),
		svc.LastHeartbeat, svc.LastError, strings.Join(svc.Problems, ", "))
	return 0
}

type finding struct {
	Check  string `json:"check"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

func cmdDiagnose(layout pve.Layout, args []string, stdout, stderr io.Writer, strict bool) int {
	asJSON := len(args) > 0 && args[0] == "--json"
	var out []finding
	add := func(check string, ok bool, detail string, a ...any) {
		out = append(out, finding{Check: check, OK: ok, Detail: fmt.Sprintf(detail, a...)})
	}
	add("helper", true, "restow-pve %s (%s)", buildinfo.Version, buildinfo.Commit)
	for _, f := range pve.PluginFiles {
		path := pve.PluginPath(layout, f)
		_, err := os.Stat(path)
		add("plugin "+f, err == nil, "%s", path)
	}
	if _, err := os.Stat(filepath.Join(layout.BinDir, "restic")); err != nil {
		add("restic", false, "%s missing (needed for containers)", filepath.Join(layout.BinDir, "restic"))
	} else {
		add("restic", true, "%s", filepath.Join(layout.BinDir, "restic"))
	}
	if data, err := os.ReadFile("/etc/pve/storage.cfg"); err == nil {
		ok := strings.Contains(string(data), "restow:")
		add("storage.cfg", ok, "restow storage %s", map[bool]string{true: "configured", false: "not configured (pvesm add restow ...)"}[ok])
	}
	s, err := loadService(layout)
	if err != nil {
		add("enrollment", false, "%v", err)
	} else {
		add("enrollment", true, "node %s, cluster %s, storage id %s", s.State.NodeID, s.State.ClusterID, s.State.StorageID)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if v, err := s.PVE.Version(ctx); err != nil {
			add("pve api", false, "%v", err)
		} else {
			add("pve api", pve.VersionAtLeast(v, 8, 4), "Proxmox VE %s", v)
		}
		if perms, err := s.PVE.Permissions(ctx); err == nil {
			missing := pve.MissingPrivileges(perms)
			add("token privileges", len(missing) == 0, "missing on /: %s", strings.Join(missing, ", "))
			pool := perms["/pool/restow-restore"]
			add("restore pool", pool["VM.Allocate"] == 1, "VM.Allocate on /pool/restow-restore: %v", pool["VM.Allocate"] == 1)
		} else {
			add("token privileges", false, "%v", err)
		}
		problems := s.Problems(ctx)
		add("problems", len(problems) == 0, "%s", strings.Join(problems, ", "))
		if _, err := s.Server.Listings(ctx); err != nil {
			add("restow server", false, "%v", err)
		} else {
			add("restow server", true, "%s reachable, credentials accepted", s.Server.BaseURL())
		}
		if guests, err := s.PVE.Guests(ctx); err == nil {
			n := 0
			for _, g := range guests {
				if g.Node == s.State.NodeName {
					n++
				}
			}
			add("guests", true, "%d guests on this node", n)
		}
	}
	var svc pve.ServiceStatus
	if data, err := os.ReadFile(layout.ServiceStatus()); err == nil && json.Unmarshal(data, &svc) == nil {
		add("service", svc.LastError == "", "last heartbeat %s %s", svc.LastHeartbeat, svc.LastError)
	} else {
		add("service", false, "no heartbeat recorded (systemctl status restow-pve)")
	}
	failed := 0
	for _, f := range out {
		if !f.OK {
			failed++
		}
	}
	if asJSON {
		_ = json.NewEncoder(stdout).Encode(map[string]any{"findings": out, "failed": failed})
	} else {
		w := bufio.NewWriter(stdout)
		for _, f := range out {
			mark := "ok  "
			if !f.OK {
				mark = "FAIL"
			}
			fmt.Fprintf(w, "[%s] %-18s %s\n", mark, f.Check, f.Detail)
		}
		_ = w.Flush()
	}
	if strict && failed > 0 {
		return 1
	}
	return 0
}

// --- config, update, uninstall, serve-restore ----------------------------------

func cmdConfig(layout pve.Layout, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("config", flag.ContinueOnError)
	fs.SetOutput(stderr)
	allow := fs.String("allow-restores", "", "true or false: whether the server may ask this node for restores")
	fleecing := fs.String("fleecing-storage", "", "thin storage for fleecing images")
	pin := fs.String("pve-cert-sha256", "", "pin the PVE API certificate (when not signed by the cluster CA)")
	tmp := fs.String("restore-tmp", "", "folder for temporary container restores")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	st, err := pve.LoadState(layout.StateFile)
	if err != nil {
		fmt.Fprintln(stderr, "restow-pve:", err)
		return 1
	}
	switch *allow {
	case "":
	case "true", "false":
		v := *allow == "true"
		st.AllowRestores = &v
	default:
		fmt.Fprintln(stderr, "restow-pve: --allow-restores takes true or false")
		return 2
	}
	if *fleecing != "" {
		st.FleecingStorage = *fleecing
	}
	if *pin != "" {
		st.PVECertSHA256 = *pin
	}
	if *tmp != "" {
		st.RestoreTmpDir = *tmp
	}
	if err := pve.SaveState(layout.StateFile, st); err != nil {
		fmt.Fprintln(stderr, "restow-pve:", err)
		return 1
	}
	fmt.Fprintln(stdout, "Saved. Restart the service: systemctl restart restow-pve")
	return 0
}

func cmdUpdate(layout pve.Layout, stdout, stderr io.Writer) int {
	s, err := loadService(layout)
	if err != nil {
		fmt.Fprintln(stderr, "restow-pve:", err)
		return 1
	}
	ctx, cancel := signalContext()
	defer cancel()
	v, err := s.Server.UpdateOffer(ctx)
	if err != nil {
		fmt.Fprintln(stderr, "restow-pve:", err)
		return 1
	}
	if v == "" {
		fmt.Fprintln(stdout, "No newer release offered.")
		return 0
	}
	if err := pve.SelfUpdate(ctx, layout, s.Server, buildinfo.Version, v); err != nil {
		fmt.Fprintln(stderr, "restow-pve:", err)
		return 1
	}
	fmt.Fprintf(stdout, "Updated to %s. Restart: systemctl restart restow-pve pvedaemon pvestatd pveproxy pvescheduler\n", v)
	return 0
}

func cmdUninstall(layout pve.Layout, args []string, stdout, stderr io.Writer) int {
	yes := len(args) > 0 && args[0] == "--yes"
	if !yes {
		fmt.Fprintln(stderr, "restow-pve: this removes the helper, the storage plugin and the node's credentials; run with --yes")
		return 2
	}
	root := os.Getenv("RESTOW_PVE_ROOT")
	paths := []string{
		root + "/etc/systemd/system/restow-pve.service",
		filepath.Dir(layout.StateFile), layout.DataDir, layout.RunDir, layout.RestoreTmp,
	}
	for _, f := range pve.PluginFiles {
		paths = append(paths, pve.PluginPath(layout, f))
	}
	paths = append(paths, filepath.Dir(layout.BinDir))
	var errs []error
	for _, p := range paths {
		if err := os.RemoveAll(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	for _, e := range errs {
		fmt.Fprintln(stderr, "restow-pve:", e)
	}
	fmt.Fprintln(stdout, "Removed. Run `systemctl daemon-reload; systemctl restart pvedaemon pvestatd pveproxy pvescheduler`.\n"+
		"The last node removes the storage: `pvesm remove <storage id>`. Backups stay in Restow; revoke the node there.")
	if len(errs) > 0 {
		return 1
	}
	return 0
}

func cmdServeRestore(layout pve.Layout, args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("serve-restore", flag.ContinueOnError)
	fs.SetOutput(stderr)
	volname := fs.String("volname", "", "")
	device := fs.String("device", "", "")
	socket := fs.String("socket", "", "")
	idle := fs.Duration("max-time", 48*time.Hour, "stop after this long in any case")
	if err := fs.Parse(args); err != nil || *volname == "" || *device == "" || *socket == "" {
		fmt.Fprintln(stderr, "usage: restow-pve serve-restore --volname V --device D --socket PATH")
		return 2
	}
	ctx, cancel := signalContext()
	defer cancel()
	ctx, cancel2 := context.WithTimeout(ctx, *idle)
	defer cancel2()
	logf := func(f string, a ...any) {
		fmt.Fprintf(stderr, "%s %s\n", time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(f, a...))
	}
	if err := pve.ServeRestore(ctx, layout, *volname, *device, *socket, logf); err != nil {
		logf("%v", err)
		return 1
	}
	return 0
}
