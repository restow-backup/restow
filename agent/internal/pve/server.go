package pve

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/buildinfo"
)

// APIPath is where the server answers the node helper.
const APIPath = "/agent/pve/v1"

// ServerError is a problem+json answer of the Restow server.
type ServerError struct {
	Status int
	Type   string
	Title  string
	Detail string
}

func (e *ServerError) Error() string {
	msg := fmt.Sprintf("Restow server answered %d %s", e.Status, e.Title)
	if e.Detail != "" {
		msg += ": " + e.Detail
	}
	return msg
}

// IsStatus reports whether err is a server answer with this status.
func IsStatus(err error, status int) bool {
	var se *ServerError
	return errors.As(err, &se) && se.Status == status
}

// Server talks to /agent/pve/v1 of the Restow instance.
type Server struct {
	base   *url.URL
	nodeID string
	secret string
	http   *http.Client
	// Attempts is the number of tries of an idempotent call (default 5).
	Attempts int
	sleep    func(context.Context, time.Duration) error
}

// NewServer creates a client. nodeID and secret are empty before enrollment.
func NewServer(rawURL, nodeID, secret string, allowInsecure bool) (*Server, error) {
	base, err := api.ParseBaseURL(rawURL, allowInsecure)
	if err != nil {
		return nil, err
	}
	return &Server{base: base, nodeID: nodeID, secret: secret, http: api.NewHTTPClient(allowInsecure), Attempts: 5, sleep: sleepCtx}, nil
}

// WithHTTPClient replaces the HTTP client (tests).
func (s *Server) WithHTTPClient(c *http.Client) *Server { s.http = c; return s }

// BaseURL is the instance URL.
func (s *Server) BaseURL() string { return s.base.String() }

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

type request struct {
	method      string
	path        string
	body        []byte
	contentType string
	out         any
	// raw receives the body of a non-JSON answer.
	raw        *[]byte
	idempotent bool
	noAuth     bool
	timeout    time.Duration
	maxBytes   int64
}

func (s *Server) do(ctx context.Context, r request) error {
	attempts := 1
	if r.idempotent {
		attempts = max(1, s.Attempts)
	}
	var last error
	for attempt := 1; attempt <= attempts; attempt++ {
		err := s.once(ctx, r)
		if err == nil {
			return nil
		}
		last = err
		if ctx.Err() != nil || attempt == attempts || !retryable(err) {
			return err
		}
		delay := time.Duration(rand.Int64N(int64(time.Second) << min(attempt, 5)))
		if err := s.sleep(ctx, delay); err != nil {
			return last
		}
	}
	return last
}

func retryable(err error) bool {
	var se *ServerError
	if errors.As(err, &se) {
		switch se.Status {
		case 408, 425, 429, 500, 502, 503, 504:
			return true
		}
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	// Network-level failures: only idempotent calls are retried at all.
	return true
}

func (s *Server) once(ctx context.Context, r request) error {
	timeout := r.timeout
	if timeout == 0 {
		timeout = 60 * time.Second
	}
	actx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var body io.Reader
	if r.body != nil {
		body = bytes.NewReader(r.body)
	}
	req, err := http.NewRequestWithContext(actx, r.method, s.base.String()+APIPath+r.path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json, application/problem+json")
	req.Header.Set("User-Agent", "restow-pve/"+buildinfo.Version)
	req.Header.Set("X-Restow-Helper-Version", buildinfo.Version)
	if r.body != nil {
		ct := r.contentType
		if ct == "" {
			ct = "application/json"
		}
		req.Header.Set("Content-Type", ct)
	}
	if !r.noAuth {
		req.SetBasicAuth(s.nodeID, s.secret)
	}
	resp, err := s.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	limit := r.maxBytes
	if limit == 0 {
		limit = 16 << 20
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > limit {
		return fmt.Errorf("%s %s: answer larger than %d bytes", r.method, r.path, limit)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		se := &ServerError{Status: resp.StatusCode, Title: http.StatusText(resp.StatusCode)}
		var p struct{ Type, Title, Detail string }
		if json.Unmarshal(data, &p) == nil {
			se.Type, se.Detail = p.Type, p.Detail
			if p.Title != "" {
				se.Title = p.Title
			}
		}
		return se
	}
	if r.raw != nil {
		*r.raw = data
		return nil
	}
	if r.out != nil && len(bytes.TrimSpace(data)) > 0 {
		if err := json.Unmarshal(data, r.out); err != nil {
			return fmt.Errorf("%s %s: invalid JSON answer: %w", r.method, r.path, err)
		}
	}
	return nil
}

func (s *Server) json(ctx context.Context, method, path string, in, out any, idempotent bool) error {
	var body []byte
	if in != nil {
		var err error
		if body, err = json.Marshal(in); err != nil {
			return err
		}
	}
	return s.do(ctx, request{method: method, path: path, body: body, out: out, idempotent: idempotent})
}

// --- Enrollment and service --------------------------------------------------

// EnrollRequest is POST /enroll.
type EnrollRequest struct {
	Token              string `json:"token"`
	ClusterName        string `json:"clusterName"`
	ClusterFingerprint string `json:"clusterFingerprint"`
	NodeName           string `json:"nodeName"`
	PVEVersion         string `json:"pveVersion"`
	HelperVersion      string `json:"helperVersion"`
	FleecingStorage    string `json:"fleecingStorage"`
}

// EnrollResponse is the answer of POST /enroll.
type EnrollResponse struct {
	NodeID     string `json:"nodeId"`
	NodeSecret string `json:"nodeSecret"`
	ClusterID  string `json:"clusterId"`
	StorageID  string `json:"storageId"`
	// CreatedCluster is true for the first node of a cluster.
	CreatedCluster bool `json:"createdCluster"`
}

// Enroll exchanges a one-time token for node credentials.
func (s *Server) Enroll(ctx context.Context, in EnrollRequest) (*EnrollResponse, error) {
	body, err := json.Marshal(in)
	if err != nil {
		return nil, err
	}
	var out EnrollResponse
	if err := s.do(ctx, request{method: http.MethodPost, path: "/enroll", body: body, out: &out, noAuth: true}); err != nil {
		return nil, err
	}
	return &out, nil
}

// HeartbeatRequest is POST /heartbeat.
type HeartbeatRequest struct {
	HelperVersion   string   `json:"helperVersion"`
	PVEVersion      string   `json:"pveVersion"`
	FleecingStorage string   `json:"fleecingStorage"`
	PluginLoaded    bool     `json:"pluginLoaded"`
	State           string   `json:"state"`
	Problems        []string `json:"problems"`
	RestoresAllowed bool     `json:"restoresAllowed"`
}

// Task is a job the server queued for this node.
type Task struct {
	ID     string          `json:"id"`
	Kind   string          `json:"kind"`
	Params json.RawMessage `json:"params"`
}

// HeartbeatResponse is the answer of POST /heartbeat.
type HeartbeatResponse struct {
	Tasks     []Task `json:"tasks"`
	StorageID string `json:"storageId"`
	Usage     struct {
		UsedBytes   int64 `json:"usedBytes"`
		BudgetBytes int64 `json:"budgetBytes"`
	} `json:"usage"`
	Update *struct {
		Version string `json:"version"`
	} `json:"update"`
}

// Heartbeat reports the node and fetches its tasks.
func (s *Server) Heartbeat(ctx context.Context, in HeartbeatRequest) (*HeartbeatResponse, error) {
	var out HeartbeatResponse
	return &out, s.json(ctx, http.MethodPost, "/heartbeat", in, &out, true)
}

// InventoryDisk is one disk of a guest.
type InventoryDisk struct {
	Device string `json:"device"`
	Size   uint64 `json:"size"`
	Backup bool   `json:"backup"`
}

// InventoryGuest is one VM or container.
type InventoryGuest struct {
	VMID       int             `json:"vmid"`
	Kind       string          `json:"kind"` // vm | ct
	Name       string          `json:"name"`
	Node       string          `json:"node"`
	Status     string          `json:"status"`
	Template   bool            `json:"template"`
	Privileged bool            `json:"privileged"`
	Tags       []string        `json:"tags"`
	Pool       string          `json:"pool"`
	Disks      []InventoryDisk `json:"disks"`
	Agent      bool            `json:"agent"`
}

// ReportInventory replaces the inventory this node reports.
func (s *Server) ReportInventory(ctx context.Context, guests []InventoryGuest) error {
	return s.json(ctx, http.MethodPost, "/inventory", map[string]any{"guests": guests}, nil, true)
}

// TaskResult reports how a task ended.
func (s *Server) TaskResult(ctx context.Context, taskID, status, message string, result map[string]any) error {
	return s.json(ctx, http.MethodPost, "/tasks/"+url.PathEscape(taskID)+"/result",
		map[string]any{"status": status, "error": message, "result": result}, nil, true)
}

// Listing is one restore point as PVE lists it.
type Listing struct {
	Volname    string `json:"volname"`
	VMID       int    `json:"vmid"`
	Kind       string `json:"kind"`
	CTime      int64  `json:"ctime"`
	Size       uint64 `json:"size"`
	SnapshotID string `json:"snapshotId"`
}

// Listings is GET /listing: the restore points of the cluster.
func (s *Server) Listings(ctx context.Context) ([]Listing, error) {
	var out struct {
		Volumes []Listing `json:"volumes"`
	}
	return out.Volumes, s.json(ctx, http.MethodGet, "/listing", nil, &out, true)
}

// UpdateOffer asks for a newer helper release.
func (s *Server) UpdateOffer(ctx context.Context) (string, error) {
	var out struct {
		Version string `json:"version"`
	}
	return out.Version, s.json(ctx, http.MethodGet, "/update", nil, &out, true)
}

// Download fetches a release file into w (self-update).
func (s *Server) Download(ctx context.Context, path string, max int64) ([]byte, error) {
	actx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(actx, http.MethodGet, s.base.String()+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "restow-pve/"+buildinfo.Version)
	resp, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, &ServerError{Status: resp.StatusCode, Title: http.StatusText(resp.StatusCode)}
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, fmt.Errorf("%s is larger than %d bytes", path, max)
	}
	return data, nil
}

// --- Runs ----------------------------------------------------------------

// OpenRunRequest is POST /runs.
type OpenRunRequest struct {
	VMID        int    `json:"vmid"`
	Kind        string `json:"kind"` // vm | ct
	ArchiveName string `json:"archiveName"`
	StorageID   string `json:"storageId"`
	StartedAt   string `json:"startedAt"`
	Node        string `json:"node"`
}

// OpenRunResponse is the answer of POST /runs.
type OpenRunResponse struct {
	RunID   string `json:"runId"`
	GuestID string `json:"guestId"`
	Origin  string `json:"origin"`
}

// OpenRun opens a backup run (job_init/backup_init time).
func (s *Server) OpenRun(ctx context.Context, in OpenRunRequest) (*OpenRunResponse, error) {
	var out OpenRunResponse
	// Not idempotent: a retry after a lost answer opens a second run, which the
	// server closes as abandoned. A failed open fails the backup.
	return &out, s.json(ctx, http.MethodPost, "/runs", in, &out, false)
}

// DeviceSize is one disk in the incremental query.
type DeviceSize struct {
	Device string `json:"device"`
	Size   uint64 `json:"size"`
}

// IncrementalDevice is the server's view of one disk.
type IncrementalDevice struct {
	Device string `json:"device"`
	// Mode is "use" when the server's newest restore point of this disk was
	// written through the same storage id with the same size, else "new".
	Mode string `json:"mode"`
	// BaseSnapshotID and HashesDigest name the map the helper may skip
	// unchanged blocks against; empty without a usable base.
	BaseSnapshotID string `json:"baseSnapshotId"`
	HashesDigest   string `json:"hashesDigest"`
}

// QueryIncremental asks which disks have a usable base.
func (s *Server) QueryIncremental(ctx context.Context, runID string, devices []DeviceSize) ([]IncrementalDevice, error) {
	var out struct {
		Devices []IncrementalDevice `json:"devices"`
	}
	return out.Devices, s.json(ctx, http.MethodPost, "/runs/"+url.PathEscape(runID)+"/incremental",
		map[string]any{"devices": devices}, &out, true)
}

// BaseHashes fetches the block hashes of a disk of a restore point.
func (s *Server) BaseHashes(ctx context.Context, snapshotID, device string) (*HashList, error) {
	var raw []byte
	err := s.do(ctx, request{method: http.MethodGet, raw: &raw, idempotent: true, maxBytes: 1 << 30,
		timeout: 10 * time.Minute,
		path:    "/snapshots/" + url.PathEscape(snapshotID) + "/disks/" + url.PathEscape(device) + "/hashes"})
	if err != nil {
		return nil, err
	}
	return DecodeHashList(raw)
}

// PutBlocks uploads one frame of blocks; idempotent (a block index is
// replaced in the run's staging area).
func (s *Server) PutBlocks(ctx context.Context, runID string, frame []byte) error {
	return s.do(ctx, request{method: http.MethodPut, path: "/runs/" + url.PathEscape(runID) + "/blocks",
		body: frame, contentType: "application/octet-stream", idempotent: true, timeout: 10 * time.Minute})
}

// CommitDevice describes one disk of a VM commit.
type CommitDevice struct {
	Device        string `json:"device"`
	Size          uint64 `json:"size"`
	BitmapMode    string `json:"bitmapMode"`
	ReadBytes     uint64 `json:"readBytes"`
	UploadedBytes uint64 `json:"uploadedBytes"`
	ChangedBlocks uint32 `json:"changedBlocks"`
	ZeroBlocks    uint32 `json:"zeroBlocks"`
	HashSkipped   uint32 `json:"hashSkipped"`
}

// CommitRequest is POST /runs/:id/commit.
type CommitRequest struct {
	CommitID          string         `json:"commitId"`
	Devices           []CommitDevice `json:"devices,omitempty"`
	GuestConfig       string         `json:"guestConfig"`
	FirewallConfig    *string        `json:"firewallConfig"`
	ResticSnapshotID  string         `json:"resticSnapshotId,omitempty"`
	ResticBytesAdded  uint64         `json:"resticBytesAdded,omitempty"`
	ResticTotalBytes  uint64         `json:"resticTotalBytes,omitempty"`
	ResticRoot        string         `json:"resticRoot,omitempty"`
	PVEVersion        string         `json:"pveVersion,omitempty"`
	ConsistencyRemark string         `json:"consistency,omitempty"`
}

// CommitResponse is the answer of a commit.
type CommitResponse struct {
	SnapshotID       string            `json:"snapshotId"`
	AlreadyCommitted bool              `json:"alreadyCommitted"`
	HashesDigests    map[string]string `json:"hashesDigests"`
}

// Commit seals the restore point. Retried: the server answers an already
// committed commit id with the same snapshot.
func (s *Server) Commit(ctx context.Context, runID string, in CommitRequest) (*CommitResponse, error) {
	body, err := json.Marshal(in)
	if err != nil {
		return nil, err
	}
	var out CommitResponse
	err = s.do(ctx, request{method: http.MethodPost, path: "/runs/" + url.PathEscape(runID) + "/commit",
		body: body, out: &out, idempotent: true, timeout: 30 * time.Minute})
	return &out, err
}

// FinishRun reports the end of a run.
func (s *Server) FinishRun(ctx context.Context, runID, status, message string, stats map[string]any) error {
	return s.json(ctx, http.MethodPost, "/runs/"+url.PathEscape(runID)+"/finish",
		map[string]any{"status": status, "error": message, "stats": stats}, nil, true)
}

// RunLog attaches the PVE task log (its tail) to a run.
func (s *Server) RunLog(ctx context.Context, runID, log string) error {
	return s.json(ctx, http.MethodPost, "/runs/"+url.PathEscape(runID)+"/log", map[string]string{"log": log}, nil, true)
}

// ResticAccess is a short-lived credential for one guest's restic repository.
type ResticAccess struct {
	RepositoryURL      string `json:"repositoryUrl"`
	Username           string `json:"username"`
	Password           string `json:"password"`
	RepositoryPassword string `json:"repositoryPassword"`
	ExpiresAt          string `json:"expiresAt"`
}

// RunRestic fetches the per-run restic credential of a container backup.
func (s *Server) RunRestic(ctx context.Context, runID string) (*ResticAccess, error) {
	var out ResticAccess
	return &out, s.json(ctx, http.MethodPost, "/runs/"+url.PathEscape(runID)+"/restic", map[string]any{}, &out, true)
}

// --- Restore ---------------------------------------------------------------

// RestorePoint is GET /restore-points/by-volname.
type RestorePoint struct {
	SnapshotID     string       `json:"snapshotId"`
	Kind           string       `json:"kind"`
	VMID           int          `json:"vmid"`
	GuestConfig    string       `json:"guestConfig"`
	FirewallConfig *string      `json:"firewallConfig"`
	Devices        []DeviceSize `json:"devices"`
	ResticSnapshot string       `json:"resticSnapshotId"`
	ResticRoot     string       `json:"resticRoot"`
}

// ResolveVolname looks a PVE volume name up.
func (s *Server) ResolveVolname(ctx context.Context, volname string) (*RestorePoint, error) {
	var out RestorePoint
	q := url.Values{"volname": {volname}}
	return &out, s.json(ctx, http.MethodGet, "/restore-points?"+q.Encode(), nil, &out, true)
}

// RestoreBlocks streams blocks [from, from+count) of a disk of a restore point.
func (s *Server) RestoreBlocks(ctx context.Context, snapshotID, device string, from, count uint32) ([]RestoreBlock, error) {
	var raw []byte
	path := "/snapshots/" + url.PathEscape(snapshotID) + "/disks/" + url.PathEscape(device) +
		"/blocks?from=" + strconv.FormatUint(uint64(from), 10) + "&count=" + strconv.FormatUint(uint64(count), 10)
	if err := s.do(ctx, request{method: http.MethodGet, path: path, raw: &raw, idempotent: true,
		maxBytes: int64(count)*(BlockSize+9) + 64, timeout: 10 * time.Minute}); err != nil {
		return nil, err
	}
	r := bytes.NewReader(raw)
	out := make([]RestoreBlock, 0, count)
	for {
		b, err := ReadRestoreBlock(r)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, nil
}

// RestoreRestic fetches a read credential for a container restore point.
func (s *Server) RestoreRestic(ctx context.Context, snapshotID string) (*ResticAccess, error) {
	var out ResticAccess
	return &out, s.json(ctx, http.MethodPost, "/snapshots/"+url.PathEscape(snapshotID)+"/restic", map[string]any{}, &out, true)
}
