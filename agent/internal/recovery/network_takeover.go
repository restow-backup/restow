package recovery

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// NetworkBackupDir keeps every file the takeover of the network changes or
// puts aside, with its path and mode (docs/BAREMETAL-ONESHOT.md 10.4 point 2).
const NetworkBackupDir = "/etc/restow/network-before-restore"

// TakeoverNetOf turns the network the command measured into the network
// the restored system takes over: the addresses DHCP or SLAAC gave come
// that way again, the others are static with their default gateway.
func TakeoverNetOf(n *OneshotNetwork) *baremetal.TakeoverNet {
	t := &baremetal.TakeoverNet{DNS: n.DNS, Search: nil}
	for _, s := range n.SearchDomains {
		if s != "." {
			t.Search = append(t.Search, s)
		}
	}
	if n.Cloud != nil {
		t.Cloud = n.Cloud.Name
	}
	for _, ifc := range n.Interfaces {
		ti := baremetal.TakeoverIface{Name: ifc.Name, MAC: strings.ToLower(ifc.MAC), MTU: ifc.MTU, DHCP4: ifc.DHCP4, SLAAC: ifc.SLAAC}
		var static4, static6 bool
		for _, a := range ifc.Addresses {
			ip := net.ParseIP(a.Address)
			if ip == nil {
				continue
			}
			v4 := ip.To4() != nil
			if a.Dynamic && ((v4 && ifc.DHCP4) || (!v4 && ifc.SLAAC)) {
				continue
			}
			ti.Static = append(ti.Static, fmt.Sprintf("%s/%d", ip.String(), a.Prefix))
			static4, static6 = static4 || v4, static6 || !v4
		}
		for _, r := range n.Routes {
			if r.Dev != ifc.Name {
				continue
			}
			switch {
			case r.Family == "inet" && static4 && ti.Gateway4 == "":
				ti.Gateway4, ti.OnLink4 = r.Gateway, r.OnLink
			case r.Family == "inet6" && (static6 || !ifc.SLAAC) && ti.Gateway6 == "":
				ti.Gateway6, ti.OnLink6 = r.Gateway, r.OnLink
			}
		}
		if ti.MTU == 1500 {
			ti.MTU = 0
		}
		t.Interfaces = append(t.Interfaces, ti)
	}
	return t
}

// NetworkTakeover writes the network of the fresh machine into the
// restored system after the release (10.4, 11.2), or with Takeover off
// only takes away the bindings to the old hardware and limits cloud-init.
type NetworkTakeover struct {
	Net       *baremetal.TakeoverNet
	Takeover  bool
	OldMACs   []string
	OldNames  []string
	SessionID string
	Now       time.Time

	// Plan and Problems are set by Apply.
	Plan     *baremetal.NetPlan
	Problems []string
}

// rootfsNetFS reads the restored system for the takeover.
type rootfsNetFS struct{ rf Rootfs }

func (r rootfsNetFS) ReadFile(p string) ([]byte, error)  { return r.rf.ReadFile(p, 1<<20) }
func (r rootfsNetFS) ReadDir(p string) ([]string, error) { return r.rf.ReadDir(p) }
func (r rootfsNetFS) IsSymlink(p string) bool {
	st, err := r.rf.Lstat(p)
	return err == nil && st.Mode()&fs.ModeSymlink != 0
}

// header heads every file the takeover writes.
func (t *NetworkTakeover) header() string {
	return fmt.Sprintf("# Written by Restow on %s (recovery %s): the network of this machine.\n"+
		"# The configuration from before the restore is in %s.\n", t.Now.UTC().Format(time.RFC3339), t.SessionID, NetworkBackupDir)
}

var reBackupID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// BackupDir is the folder of this restore below NetworkBackupDir (an
// earlier restore keeps its own).
func (t *NetworkTakeover) BackupDir() string {
	id := t.SessionID
	if !reBackupID.MatchString(id) {
		id = t.Now.UTC().Format("20060102T150405Z")
	}
	return path.Join(NetworkBackupDir, id)
}

// saved is a file as it was before the takeover.
type saved struct {
	existed bool
	data    []byte
	mode    fs.FileMode
}

// Apply plans and carries out the takeover on the restored system, so
// that the system keeps a working configuration whatever fails:
//
//  1. every path is checked first; one that is no plain file (a link, a
//     folder) stops the takeover before anything is touched;
//  2. every file that is there is copied, with its mode, to BackupDir;
//  3. the new files are written and read back, and checked (10.5);
//  4. only then the old files are put aside.
//
// Any error from step 3 on puts every touched path back as it was (from
// the copies) and removes what was new. It returns the changes for the
// report.
func (t *NetworkTakeover) Apply(rf Rootfs) ([]api.RecoveryFixupChange, error) {
	p, err := baremetal.PlanTakeover(rootfsNetFS{rf}, t.Net, t.OldMACs, t.OldNames, t.Takeover, t.header())
	if err != nil {
		return nil, err
	}
	t.Plan = p
	before := map[string]saved{}
	var paths []string
	for _, c := range p.Changes {
		if _, ok := before[c.Path]; ok {
			continue
		}
		st, err := rf.Lstat(c.Path)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			before[c.Path] = saved{}
		case err != nil:
			return nil, err
		case !st.Mode().IsRegular():
			return nil, fmt.Errorf("%s is no plain file (%s); the network was left as restored", c.Path, st.Mode().Type())
		default:
			data, err := rf.ReadFile(c.Path, 16<<20)
			if err != nil {
				return nil, err
			}
			before[c.Path] = saved{existed: true, data: data, mode: st.Mode().Perm()}
		}
		paths = append(paths, c.Path)
	}
	dir := t.BackupDir()
	if err := rf.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	_ = rf.Chmod(NetworkBackupDir, 0o700)
	_ = rf.Chmod(dir, 0o700)
	backups := map[string]string{}
	for _, pth := range paths {
		b := before[pth]
		if !b.existed {
			continue
		}
		dst := path.Join(dir, pth)
		if err := rf.MkdirAll(path.Dir(dst), 0o700); err != nil {
			return nil, err
		}
		if err := rf.WriteFileAtomic(dst, b.data, b.mode, 0, 0, ""); err != nil {
			return nil, err
		}
		backups[pth] = dst
	}
	touched := map[string]bool{}
	rollback := func(cause error) error {
		var errs []error
		for pth := range touched {
			b := before[pth]
			if b.existed {
				errs = append(errs, rf.WriteFileAtomic(pth, b.data, b.mode, 0, 0, ""))
			} else if err := rf.Remove(pth); err != nil && !errors.Is(err, fs.ErrNotExist) {
				errs = append(errs, err)
			}
		}
		if err := errors.Join(errs...); err != nil {
			return fmt.Errorf("%w; putting the files back failed too: %v", cause, err)
		}
		return fmt.Errorf("%w; the network was left as restored", cause)
	}
	var out []api.RecoveryFixupChange
	written := map[string]bool{}
	for _, c := range p.Changes {
		if c.Remove {
			continue
		}
		if _, err := rf.Lstat(path.Dir(c.Path)); err != nil {
			if err := rf.MkdirAll(path.Dir(c.Path), 0o755); err != nil {
				return nil, rollback(err)
			}
		}
		touched[c.Path] = true
		if err := rf.WriteFileAtomic(c.Path, c.Content, c.Mode, 0, 0, ""); err != nil {
			return nil, rollback(err)
		}
		if got, err := rf.ReadFile(c.Path, 16<<20); err != nil || string(got) != string(c.Content) {
			return nil, rollback(fmt.Errorf("%s does not read back as written", c.Path))
		}
		written[c.Path] = true
		out = append(out, api.RecoveryFixupChange{Path: c.Path, Rule: c.Rule, Backup: backups[c.Path]})
	}
	if t.Takeover {
		if problems := baremetal.CheckTakeover(p, t.Net); len(problems) > 0 {
			return nil, rollback(fmt.Errorf("the written network files did not pass their check: %s", strings.Join(problems, "; ")))
		}
	}
	for _, c := range p.Changes {
		if !c.Remove || written[c.Path] || !before[c.Path].existed {
			continue
		}
		touched[c.Path] = true
		if err := rf.Remove(c.Path); err != nil {
			return nil, rollback(err)
		}
		out = append(out, api.RecoveryFixupChange{Path: c.Path, Rule: c.Rule + "_set_aside", Backup: backups[c.Path]})
	}
	for pth := range written {
		if before[pth].existed {
			out = append(out, api.RecoveryFixupChange{Path: pth, Rule: "network_old_config_set_aside", Backup: backups[pth]})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	readme := fmt.Sprintf("Restow restored this system onto a new machine on %s (recovery %s).\n"+
		"Below this folder are the files the restore changed or took away, with their paths\n"+
		"and modes, as they were before. To go back to one, copy it to its place again.\n"+
		"Network stack: %s. cloud-init brings up the network: %v.\n",
		t.Now.UTC().Format(time.RFC3339), t.SessionID, p.Stack, p.CloudInitNetwork)
	if err := rf.WriteFileAtomic(path.Join(dir, "README"), []byte(readme), 0o600, 0, 0, ""); err != nil {
		return out, err
	}
	t.writeIndex(rf)
	return out, nil
}

// writeIndex lists the folders of every restore at the top of
// NetworkBackupDir.
func (t *NetworkTakeover) writeIndex(rf Rootfs) {
	names, _ := rf.ReadDir(NetworkBackupDir)
	var b strings.Builder
	b.WriteString("The network configuration as it was before each restore by Restow, one folder per\nrecovery (its README says when):\n\n")
	sort.Strings(names)
	for _, n := range names {
		if st, err := rf.Lstat(path.Join(NetworkBackupDir, n)); err == nil && st.IsDir() {
			b.WriteString("  " + n + "/\n")
		}
	}
	_ = rf.WriteFileAtomic(path.Join(NetworkBackupDir, "README"), []byte(b.String()), 0o600, 0, 0, "")
}
