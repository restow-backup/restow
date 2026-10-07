package pve

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// ClusterCAFile is the cluster CA that signs every node's pve-ssl.pem.
const ClusterCAFile = "/etc/pve/pve-root-ca.pem"

// PVEAPI is a client for the local PVE API (https://127.0.0.1:8006/api2/json)
// with an API token. It never talks to another host.
type PVEAPI struct {
	base    string
	auth    string
	http    *http.Client
	timeout time.Duration
}

// PVEAPIError is an error answer of the PVE API.
type PVEAPIError struct {
	Status  int
	Message string
}

func (e *PVEAPIError) Error() string {
	return fmt.Sprintf("PVE API answered %d: %s", e.Status, e.Message)
}

// NewPVEAPI creates the client. The server certificate must chain to the
// cluster CA (hostname not checked: the connection is to the loopback
// address), or match pinSHA256 (hex SHA-256 of the leaf, for a custom
// pveproxy certificate).
func NewPVEAPI(baseURL, tokenID, tokenSecret, caFile, pinSHA256 string) (*PVEAPI, error) {
	if baseURL == "" {
		baseURL = "https://127.0.0.1:8006"
	}
	u, err := url.Parse(baseURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, fmt.Errorf("invalid PVE API URL %q", baseURL)
	}
	pool := x509.NewCertPool()
	if caFile != "" {
		if pem, err := os.ReadFile(caFile); err == nil {
			pool.AppendCertsFromPEM(pem)
		}
	}
	pin := strings.ToLower(strings.ReplaceAll(pinSHA256, ":", ""))
	tlsConf := &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: true, // verified below: chain to the cluster CA or pinned leaf
		VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 {
				return errors.New("PVE API sent no certificate")
			}
			leafSum := sha256.Sum256(raw[0])
			if pin != "" && hex.EncodeToString(leafSum[:]) == pin {
				return nil
			}
			leaf, err := x509.ParseCertificate(raw[0])
			if err != nil {
				return err
			}
			inter := x509.NewCertPool()
			for _, r := range raw[1:] {
				if c, err := x509.ParseCertificate(r); err == nil {
					inter.AddCert(c)
				}
			}
			if _, err := leaf.Verify(x509.VerifyOptions{Roots: pool, Intermediates: inter}); err != nil {
				return fmt.Errorf("the PVE API certificate is neither signed by the cluster CA (%s) nor pinned "+
					"(SHA-256 %x; pin it with `restow-pve config --pve-cert-sha256 %x`): %w", caFile, leafSum, leafSum, err)
			}
			return nil
		},
	}
	tr := &http.Transport{TLSClientConfig: tlsConf, Proxy: nil, MaxIdleConns: 2, IdleConnTimeout: 30 * time.Second}
	return &PVEAPI{
		base:    strings.TrimRight(baseURL, "/") + "/api2/json",
		auth:    "PVEAPIToken=" + tokenID + "=" + tokenSecret,
		http:    &http.Client{Transport: tr},
		timeout: 60 * time.Second,
	}, nil
}

// WithHTTPClient replaces the transport (tests).
func (p *PVEAPI) WithHTTPClient(c *http.Client) *PVEAPI { p.http = c; return p }

func (p *PVEAPI) call(ctx context.Context, method, path string, form url.Values, out any) error {
	ctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	var body io.Reader
	target := p.base + path
	if form != nil && method == http.MethodGet {
		target += "?" + form.Encode()
	} else if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", p.auth)
	if body != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return fmt.Errorf("PVE API %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != 200 {
		msg := strings.TrimSpace(resp.Status)
		var e struct {
			Errors  map[string]string `json:"errors"`
			Message string            `json:"message"`
		}
		if json.Unmarshal(data, &e) == nil {
			for k, v := range e.Errors {
				msg += fmt.Sprintf("; %s: %s", k, strings.TrimSpace(v))
			}
		}
		return &PVEAPIError{Status: resp.StatusCode, Message: msg}
	}
	if out == nil {
		return nil
	}
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return fmt.Errorf("PVE API %s %s: invalid answer: %w", method, path, err)
	}
	if len(bytes.TrimSpace(env.Data)) == 0 || string(env.Data) == "null" {
		return nil
	}
	return json.Unmarshal(env.Data, out)
}

// Version is GET /version.
func (p *PVEAPI) Version(ctx context.Context) (string, error) {
	var v struct {
		Version string `json:"version"`
		Release string `json:"release"`
	}
	if err := p.call(ctx, http.MethodGet, "/version", nil, &v); err != nil {
		return "", err
	}
	return v.Version, nil
}

// Permissions is GET /access/permissions for the token: path -> privilege -> 1.
func (p *PVEAPI) Permissions(ctx context.Context) (map[string]map[string]int, error) {
	var out map[string]map[string]int
	return out, p.call(ctx, http.MethodGet, "/access/permissions", nil, &out)
}

// Resource is one entry of GET /cluster/resources?type=vm.
type Resource struct {
	VMID     int    `json:"vmid"`
	Type     string `json:"type"` // qemu | lxc
	Name     string `json:"name"`
	Node     string `json:"node"`
	Status   string `json:"status"`
	Template int    `json:"template"`
	Tags     string `json:"tags"`
	Pool     string `json:"pool"`
	MaxDisk  uint64 `json:"maxdisk"`
}

// Guests lists the VMs and containers of the cluster.
func (p *PVEAPI) Guests(ctx context.Context) ([]Resource, error) {
	var out []Resource
	return out, p.call(ctx, http.MethodGet, "/cluster/resources", url.Values{"type": {"vm"}}, &out)
}

// GuestConfig returns the current configuration of a guest as key/value pairs.
func (p *PVEAPI) GuestConfig(ctx context.Context, node, kind string, vmid int) (map[string]any, error) {
	var out map[string]any
	return out, p.call(ctx, http.MethodGet, fmt.Sprintf("/nodes/%s/%s/%d/config", url.PathEscape(node), apiType(kind), vmid), nil, &out)
}

// Storage is one entry of GET /nodes/{node}/storage.
type Storage struct {
	Storage string `json:"storage"`
	Type    string `json:"type"`
	Content string `json:"content"`
	Active  int    `json:"active"`
	Enabled int    `json:"enabled"`
	Avail   uint64 `json:"avail"`
}

// Storages lists the storages of a node.
func (p *PVEAPI) Storages(ctx context.Context, node string) ([]Storage, error) {
	var out []Storage
	return out, p.call(ctx, http.MethodGet, "/nodes/"+url.PathEscape(node)+"/storage", nil, &out)
}

// NextID asks the cluster for a free VMID.
func (p *PVEAPI) NextID(ctx context.Context) (int, error) {
	var out json.Number
	if err := p.call(ctx, http.MethodGet, "/cluster/nextid", nil, &out); err != nil {
		return 0, err
	}
	n, err := out.Int64()
	return int(n), err
}

// StartBackup starts vzdump for one guest onto the Restow storage and returns the task UPID.
func (p *PVEAPI) StartBackup(ctx context.Context, node string, vmid int, storage, mode, fleecing string) (string, error) {
	form := url.Values{
		"vmid":           {fmt.Sprint(vmid)},
		"storage":        {storage},
		"mode":           {mode},
		"remove":         {"0"},
		"notes-template": {"{{guestname}} (Restow)"},
	}
	if fleecing != "" {
		form.Set("fleecing", "enabled=1,storage="+fleecing)
	}
	var upid string
	return upid, p.call(ctx, http.MethodPost, "/nodes/"+url.PathEscape(node)+"/vzdump", form, &upid)
}

// RestoreGuest creates a new guest from a backup volume; returns the task UPID.
// It never passes force and always targets a new VMID.
func (p *PVEAPI) RestoreGuest(ctx context.Context, node, kind string, vmid int, archive, storage, pool string, start bool) (string, error) {
	form := url.Values{"vmid": {fmt.Sprint(vmid)}, "storage": {storage}}
	if pool != "" {
		form.Set("pool", pool)
	}
	if kind == "ct" {
		form.Set("ostemplate", archive)
		form.Set("restore", "1")
		form.Set("unprivileged", "1")
	} else {
		form.Set("archive", archive)
		form.Set("unique", "1")
	}
	if start {
		form.Set("start", "1")
	}
	var upid string
	return upid, p.call(ctx, http.MethodPost, fmt.Sprintf("/nodes/%s/%s", url.PathEscape(node), apiType(kind)), form, &upid)
}

// DeleteGuest removes a guest (restore tests clean up after themselves; the
// token may only delete guests in the restore pool).
func (p *PVEAPI) DeleteGuest(ctx context.Context, node, kind string, vmid int) (string, error) {
	var upid string
	return upid, p.call(ctx, http.MethodDelete, fmt.Sprintf("/nodes/%s/%s/%d", url.PathEscape(node), apiType(kind), vmid),
		url.Values{"purge": {"1"}, "destroy-unreferenced-disks": {"1"}}, &upid)
}

// TaskStatus is GET /nodes/{node}/tasks/{upid}/status.
type TaskStatus struct {
	Status     string `json:"status"` // running | stopped
	ExitStatus string `json:"exitstatus"`
}

// WaitTask polls a task until it stops and returns its exit status ("OK" on success).
func (p *PVEAPI) WaitTask(ctx context.Context, node, upid string, poll time.Duration) (string, error) {
	for {
		var st TaskStatus
		if err := p.call(ctx, http.MethodGet, "/nodes/"+url.PathEscape(node)+"/tasks/"+url.PathEscape(upid)+"/status", nil, &st); err != nil {
			return "", err
		}
		if st.Status == "stopped" {
			return st.ExitStatus, nil
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(poll):
		}
	}
}

// TaskLogTail returns the last lines of a task log.
func (p *PVEAPI) TaskLogTail(ctx context.Context, node, upid string, lines int) (string, error) {
	var out []struct {
		T string `json:"t"`
	}
	if err := p.call(ctx, http.MethodGet, "/nodes/"+url.PathEscape(node)+"/tasks/"+url.PathEscape(upid)+"/log",
		url.Values{"limit": {"100000"}}, &out); err != nil {
		return "", err
	}
	if len(out) > lines {
		out = out[len(out)-lines:]
	}
	var b strings.Builder
	for _, l := range out {
		b.WriteString(l.T)
		b.WriteByte('\n')
	}
	return b.String(), nil
}

func apiType(kind string) string {
	if kind == "ct" || kind == "lxc" {
		return "lxc"
	}
	return "qemu"
}
