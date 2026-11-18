package recovery

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"path"
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

// Apply plans and carries out the takeover on the restored system: every
// file it changes or puts aside is copied to NetworkBackupDir first (with
// its mode), nothing is deleted without that copy. It returns the changes
// for the report; Problems holds what the check of the written files found.
func (t *NetworkTakeover) Apply(rf Rootfs) ([]api.RecoveryFixupChange, error) {
	p, err := baremetal.PlanTakeover(rootfsNetFS{rf}, t.Net, t.OldMACs, t.OldNames, t.Takeover, t.header())
	if err != nil {
		return nil, err
	}
	t.Plan = p
	changes := append([]baremetal.NetChange(nil), p.Changes...)
	// What is put aside goes first, then what is written (the same path
	// can be both: /etc/network/interfaces).
	sort.SliceStable(changes, func(i, j int) bool { return changes[i].Remove && !changes[j].Remove })
	var out []api.RecoveryFixupChange
	backedUp := map[string]bool{}
	backup := func(p string) (string, error) {
		if backedUp[p] {
			return path.Join(NetworkBackupDir, p), nil
		}
		st, err := rf.Lstat(p)
		if errors.Is(err, fs.ErrNotExist) {
			return "", nil
		}
		if err != nil {
			return "", err
		}
		if !st.Mode().IsRegular() {
			return "", fmt.Errorf("%s is no plain file; the takeover leaves it", p)
		}
		data, err := rf.ReadFile(p, 16<<20)
		if err != nil {
			return "", err
		}
		dst := path.Join(NetworkBackupDir, p)
		if err := rf.MkdirAll(path.Dir(dst), 0o700); err != nil {
			return "", err
		}
		if err := rf.WriteFileAtomic(dst, data, st.Mode().Perm(), 0, 0, ""); err != nil {
			return "", err
		}
		backedUp[p] = true
		return dst, nil
	}
	if err := rf.MkdirAll(NetworkBackupDir, 0o700); err != nil {
		return nil, err
	}
	_ = rf.Chmod(NetworkBackupDir, 0o700)
	for _, c := range changes {
		b, err := backup(c.Path)
		if err != nil {
			return out, err
		}
		if c.Remove {
			if b == "" {
				continue
			}
			if err := rf.Remove(c.Path); err != nil {
				return out, err
			}
			out = append(out, api.RecoveryFixupChange{Path: c.Path, Rule: c.Rule + "_set_aside", Backup: b})
			continue
		}
		if _, err := rf.Lstat(path.Dir(c.Path)); err != nil {
			if err := rf.MkdirAll(path.Dir(c.Path), 0o755); err != nil {
				return out, err
			}
		}
		if err := rf.WriteFileAtomic(c.Path, c.Content, c.Mode, 0, 0, ""); err != nil {
			return out, err
		}
		out = append(out, api.RecoveryFixupChange{Path: c.Path, Rule: c.Rule, Backup: b})
	}
	readme := fmt.Sprintf("Restow restored this system onto a new machine on %s (recovery %s).\n"+
		"Below this folder are the files the restore changed or took away, with their paths\n"+
		"and modes, as they were before. To go back to one, copy it to its place again.\n"+
		"Network stack: %s. cloud-init brings up the network: %v.\n",
		t.Now.UTC().Format(time.RFC3339), t.SessionID, p.Stack, p.CloudInitNetwork)
	if err := rf.WriteFileAtomic(path.Join(NetworkBackupDir, "README"), []byte(readme), 0o600, 0, 0, ""); err != nil {
		return out, err
	}
	if t.Takeover {
		t.Problems = baremetal.CheckTakeover(p, t.Net)
	}
	return out, nil
}
