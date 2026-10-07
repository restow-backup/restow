package pve

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Layout is where restow-pve keeps its files. Every path can be moved with
// RESTOW_PVE_ROOT (tests and development), which prefixes all of them.
type Layout struct {
	// StateFile holds the node secret and the PVE API token (root, 0600,
	// local disk, never pmxcfs).
	StateFile string
	// DataDir holds caches: block hashes, the listing and status the storage
	// plugin reads, the per-guest journal of committed backups.
	DataDir string
	// RunDir holds per-job state that must cross provider calls, including
	// the unprivileged container backup.
	RunDir string
	// BinDir holds restow-pve and restic.
	BinDir string
	// PluginDir is where PVE loads custom storage plugins from.
	PluginDir string
	// ProviderDir holds backup provider modules (PVE::BackupProvider::Plugin::*).
	ProviderDir string
	// RestoreTmp is the default folder for temporary container restores.
	RestoreTmp string
}

// DefaultLayout is the layout of an installed node.
func DefaultLayout() Layout {
	root := strings.TrimRight(os.Getenv("RESTOW_PVE_ROOT"), "/")
	return Layout{
		StateFile:   root + "/etc/restow-pve/state.json",
		DataDir:     root + "/var/lib/restow-pve",
		RunDir:      root + "/run/restow-pve",
		BinDir:      root + "/opt/restow-pve/bin",
		PluginDir:   root + "/usr/share/perl5/PVE/Storage/Custom",
		ProviderDir: root + "/usr/share/perl5/PVE/BackupProvider/Plugin",
		RestoreTmp:  root + "/var/tmp/restow-pve",
	}
}

func (l Layout) cacheFile(name string) string { return filepath.Join(l.DataDir, "cache", name) }
func (l Layout) StatusCache() string          { return l.cacheFile("status.json") }
func (l Layout) VolumesCache() string         { return l.cacheFile("volumes.json") }
func (l Layout) ServiceStatus() string        { return l.cacheFile("service.json") }
func (l Layout) journalFile(vmid int) string {
	return filepath.Join(l.DataDir, "journal", fmt.Sprintf("%d.json", vmid))
}
func (l Layout) forceNewFile(vmid int) string {
	return filepath.Join(l.DataDir, "force-new", fmt.Sprintf("%d", vmid))
}
func (l Layout) jobFile(storeid string, vmid int) string {
	return filepath.Join(l.RunDir, "jobs", fmt.Sprintf("%s-%d.json", storeid, vmid))
}
func (l Layout) hashFile(vmid int, device string) string {
	return filepath.Join(l.DataDir, "maps", fmt.Sprintf("%d", vmid), device+".hashes")
}

// State is what enrollment leaves on the node.
type State struct {
	URL        string `json:"url"`
	NodeID     string `json:"nodeId"`
	NodeSecret string `json:"nodeSecret"`
	ClusterID  string `json:"clusterId"`
	// StorageID is the PVE storage id of the Restow storage (one per tenant).
	StorageID string `json:"storageId"`
	NodeName  string `json:"nodeName"`
	// PVE API token on this node: "user@realm!name" and its secret. Never sent to Restow.
	PVETokenID     string `json:"pveTokenId"`
	PVETokenSecret string `json:"pveTokenSecret"`
	// PVEAPIURL defaults to https://127.0.0.1:8006.
	PVEAPIURL string `json:"pveApiUrl,omitempty"`
	// PVECertSHA256 pins the API certificate when it is not signed by the
	// cluster CA (a custom pveproxy certificate).
	PVECertSHA256 string `json:"pveCertSha256,omitempty"`
	// FleecingStorage is the thin storage of this node for fleecing images.
	FleecingStorage string `json:"fleecingStorage"`
	// AllowRestores is the node's own decision whether the server may ask
	// for restores (default true); the server cannot change it.
	AllowRestores *bool `json:"allowRestores,omitempty"`
	// RestoreTmpDir is where container restores are unpacked before PVE copies them.
	RestoreTmpDir string `json:"restoreTmpDir,omitempty"`
	// AllowInsecureHTTP is for development only.
	AllowInsecureHTTP bool `json:"allowInsecureHttp,omitempty"`
}

// RestoresAllowed is the node-side restore policy.
func (s *State) RestoresAllowed() bool { return s.AllowRestores == nil || *s.AllowRestores }

// Validate checks that the state is complete.
func (s *State) Validate() error {
	var missing []string
	for name, v := range map[string]string{
		"url": s.URL, "nodeId": s.NodeID, "nodeSecret": s.NodeSecret, "storageId": s.StorageID,
		"pveTokenId": s.PVETokenID, "pveTokenSecret": s.PVETokenSecret, "nodeName": s.NodeName,
	} {
		if strings.TrimSpace(v) == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("state is incomplete (missing %s)", strings.Join(sortedStrings(missing), ", "))
	}
	return nil
}

func sortedStrings(s []string) []string {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
	return s
}

// ErrNotEnrolled means there is no state file yet.
var ErrNotEnrolled = errors.New("this node is not enrolled (run the installer or `restow-pve enroll`)")

// LoadState reads the state file.
func LoadState(path string) (*State, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrNotEnrolled
		}
		return nil, err
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("state file %s is damaged: %w", path, err)
	}
	return &s, nil
}

// SaveState writes the state file atomically with mode 0600.
func SaveState(path string, s *State) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, append(data, '\n'), 0o600)
}

// writeFileAtomic writes data to a temporary file next to path and renames it.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() { _ = os.Remove(tmp) }()
	if err := f.Chmod(mode); err != nil {
		_ = f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func writeJSONAtomic(path string, v any, mode os.FileMode) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return writeFileAtomic(path, data, mode)
}

func readJSON(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}
