package pve

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// The restore check of a container with a bind mount point names rootfs and the volume
// mount points itself: PVE refuses a token's restore of a bind mount point taken from the
// backup ("restoring 'mp0' to bind mount is only possible for root").
func TestRestoreCheckOfAContainerLeavesItsBindMountOut(t *testing.T) {
	const guestConfig = "hostname: paperless\nmemory: 2048\nrootfs: local-lvm:vm-113-disk-0,size=8G\n" +
		"mp0: /mnt/paperless,mp=/data\nmp1: local-lvm:vm-113-disk-1,mp=/opt,backup=1,size=2G\n"
	var mu sync.Mutex
	var restoreForm url.Values
	restow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		if strings.TrimPrefix(r.URL.Path, "/agent/pve/v1") == "/restore-points" {
			_ = json.NewEncoder(w).Encode(RestorePoint{SnapshotID: "s1", Kind: "ct", VMID: 113, GuestConfig: guestConfig})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	pveAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reply := func(data any) { _ = json.NewEncoder(w).Encode(map[string]any{"data": data}) }
		p := r.URL.Path
		switch {
		case p == "/api2/json/nodes/pve1/lxc" && r.Method == http.MethodPost:
			_ = r.ParseForm()
			mu.Lock()
			restoreForm = r.PostForm
			mu.Unlock()
			if r.PostForm.Get("rootfs") == "" {
				reply("UPID:pve1:1:2:3:vzrestore:124:restow@pve!restow:")
				return
			}
			reply(testUPID)
		case strings.HasSuffix(p, "/status") && strings.Contains(p, "/tasks/"):
			exit := "OK"
			if strings.Contains(p, "vzrestore") {
				exit = "unable to restore CT 124 - restoring 'mp0' to bind mount is only possible for root"
			}
			reply(map[string]any{"status": "stopped", "exitstatus": exit})
		case p == "/api2/json/nodes/pve1/lxc/124/config":
			reply(map[string]any{"rootfs": "local-lvm:vm-124-disk-0,size=8G", "mp1": "local-lvm:vm-124-disk-1,mp=/opt,size=2G"})
		default:
			reply(nil)
		}
	}))
	t.Cleanup(func() { restow.Close(); pveAPI.Close() })

	srv, err := NewServer(restow.URL, "node-1", "secret", true)
	if err != nil {
		t.Fatal(err)
	}
	api, err := NewPVEAPI(pveAPI.URL, "restow@pve!restow", "x", "", "")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	for _, d := range []string{"data", "run"} {
		_ = os.MkdirAll(filepath.Join(root, d), 0o700)
	}
	s := &Service{
		Layout: Layout{DataDir: filepath.Join(root, "data"), RunDir: filepath.Join(root, "run")},
		State:  &State{NodeName: "pve1", StorageID: "restow"},
		Server: srv, PVE: api,
		Logf: t.Logf,
	}
	params, _ := json.Marshal(map[string]any{"volname": "backup/ct/113/2026-11-02T08:19:26Z", "kind": "ct",
		"targetVmid": 124, "targetStorage": "local-lvm", "restoreTest": true})
	result, err := s.task(context.Background(), Task{ID: "t1", Kind: "restore", Params: params})
	if err != nil {
		t.Fatalf("restore check: %v (%v)", err, result)
	}
	mu.Lock()
	defer mu.Unlock()
	if restoreForm.Get("rootfs") != "local-lvm:8" || restoreForm.Get("mp1") != "local-lvm:2,mp=/opt,backup=1" {
		t.Errorf("restore form = %v", restoreForm)
	}
	if _, ok := restoreForm["mp0"]; ok {
		t.Errorf("the bind mount was passed on: %v", restoreForm)
	}
	if got, _ := result["omittedMounts"].([]string); len(got) != 1 || got[0] != "mp0 (/mnt/paperless)" {
		t.Errorf("omittedMounts = %v", result["omittedMounts"])
	}
}
