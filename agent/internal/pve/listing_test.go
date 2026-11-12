//go:build !windows

package pve

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// listingServer is GET /listing and GET /restore-points of a server from 0.5.0: pages of
// pageSize from a cursor, every restore point of one VMID with ?vmid=, a restore point by its
// volume name. old answers like a server before 0.5.0 (one page, no cursor, no ?vmid=, no
// byteSize).
type listingServer struct {
	mu       sync.Mutex
	points   []Listing // newest first
	pageSize int
	old      bool
	// sizes are the byteSize of a restore point (by archive name); devices its disks.
	sizes   map[string]uint64
	devices map[string][]DeviceSize
	queries []string
}

func (f *listingServer) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		p := strings.TrimPrefix(r.URL.Path, APIPath)
		q := r.URL.Query()
		switch p {
		case "/listing":
			f.queries = append(f.queries, r.URL.RawQuery)
			if vmid := q.Get("vmid"); vmid != "" && !f.old {
				own := []Listing{}
				for _, l := range f.points {
					if strconv.Itoa(l.VMID) == vmid {
						own = append(own, l)
					}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"volumes": own, "next": nil})
				return
			}
			from := 0
			if c := q.Get("cursor"); c != "" && !f.old {
				from, _ = strconv.Atoi(strings.TrimPrefix(c, "c"))
			}
			to := min(from+f.pageSize, len(f.points))
			if f.old {
				from, to = 0, min(f.pageSize, len(f.points))
				_ = json.NewEncoder(w).Encode(map[string]any{"volumes": f.points[from:to]})
				return
			}
			var next any
			if to < len(f.points) {
				next = fmt.Sprintf("c%d", to)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"volumes": f.points[from:to], "next": next})
		case "/restore-points":
			name := strings.TrimPrefix(q.Get("volname"), "backup/")
			for _, l := range f.points {
				if l.Volname == name {
					rp := RestorePoint{SnapshotID: l.SnapshotID, Kind: l.Kind, VMID: l.VMID, Devices: f.devices[name]}
					if !f.old {
						rp.ByteSize = f.sizes[name]
					}
					_ = json.NewEncoder(w).Encode(rp)
					return
				}
			}
			w.Header().Set("Content-Type", "application/problem+json")
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"title":"Restore point not found"}`))
		default:
			t.Logf("unexpected %s %s", r.Method, p)
			w.WriteHeader(404)
		}
	})
}

// points are n restore points of VMIDs 101 and 102, newest first, an hour apart.
func points(n int) []Listing {
	start := time.Date(2026, 10, 3, 22, 0, 0, 0, time.UTC)
	out := make([]Listing, 0, n)
	for i := range n {
		vmid := 101 + i%2
		at := start.Add(-time.Duration(i) * time.Hour)
		out = append(out, Listing{Volname: ArchiveName("vm", vmid, at), VMID: vmid, Kind: "vm",
			CTime: at.Unix(), Size: uint64(1000 + i), SnapshotID: fmt.Sprintf("s%d", i)})
	}
	return out
}

// listingProvider is a provider enrolled with the server at url.
func listingProvider(t *testing.T, url string) *Provider {
	t.Helper()
	t.Setenv("RESTOW_PVE_ROOT", t.TempDir())
	l := DefaultLayout()
	if err := SaveState(l.StateFile, &State{URL: url, NodeID: "n", NodeSecret: "s", StorageID: "restow", NodeName: "pve1",
		PVETokenID: "restow@pve!restow", PVETokenSecret: "x", AllowInsecureHTTP: true}); err != nil {
		t.Fatal(err)
	}
	p := &Provider{Layout: l, Log: io.Discard}
	if err := p.load(); err != nil {
		t.Fatal(err)
	}
	p.server.sleep = func(context.Context, time.Duration) error { return nil }
	return p
}

func volnames(t *testing.T, out any) []string {
	t.Helper()
	var names []string
	for _, v := range out.(map[string]any)["volumes"].([]map[string]any) {
		names = append(names, v["volname"].(string))
	}
	return names
}

// The listing the node keeps for "Storage > restow > Backups" holds every page of the
// cluster's restore points, not only the newest page.
func TestListingsReadsEveryPage(t *testing.T) {
	f := &listingServer{points: points(7), pageSize: 3}
	ts := httptest.NewServer(f.handler(t))
	t.Cleanup(ts.Close)
	p := listingProvider(t, ts.URL)
	if _, err := p.Handle(context.Background(), "job-init", ProviderRequest{StoreID: "restow"}); err != nil {
		t.Fatal(err)
	}
	var cached []Listing
	if err := readJSON(p.Layout.VolumesCache(), &cached); err != nil {
		t.Fatal(err)
	}
	if len(cached) != 7 {
		t.Fatalf("the cache holds %d restore points, want all 7", len(cached))
	}
	for i, l := range cached {
		if l.SnapshotID != f.points[i].SnapshotID {
			t.Fatalf("restore point %d is %s, want %s (order kept, none twice)", i, l.SnapshotID, f.points[i].SnapshotID)
		}
	}
	if got := strings.Join(f.queries, " "); got != " cursor=c3 cursor=c6" {
		t.Fatalf("queries %q, want the first page and two cursors", got)
	}
	out, err := p.Handle(context.Background(), "list-volumes", ProviderRequest{StoreID: "restow"})
	if err != nil {
		t.Fatal(err)
	}
	if n := len(volnames(t, out)); n != 7 {
		t.Fatalf("list-volumes without a VMID gave %d, want 7", n)
	}
}

// A server before 0.5.0 sends one page and no cursor: that page is the listing.
func TestListingsOfAnOlderServer(t *testing.T) {
	f := &listingServer{points: points(7), pageSize: 5, old: true}
	ts := httptest.NewServer(f.handler(t))
	t.Cleanup(ts.Close)
	s, _ := NewServer(ts.URL, "n", "s", true)
	l, err := s.Listings(context.Background())
	if err != nil || len(l) != 5 || len(f.queries) != 1 {
		t.Fatalf("listing %d restore points in %d requests (%v), want one page of 5", len(l), len(f.queries), err)
	}
	// ?vmid= is ignored by it: the answer is filtered on the node.
	own, err := s.ListingOf(context.Background(), 102)
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range own {
		if o.VMID != 102 {
			t.Fatalf("ListingOf(102) holds VMID %d", o.VMID)
		}
	}
	if len(own) != 2 {
		t.Fatalf("ListingOf(102) = %d restore points, want the 2 of the page", len(own))
	}
}

// A listing that fails on a later page, or whose cursor does not move, fails as a whole: the
// cache it would fill keeps the last complete listing instead of losing restore points.
func TestListingsFailsRatherThanReturnPartOfIt(t *testing.T) {
	for _, tc := range []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"a page fails", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("cursor") != "" {
				w.WriteHeader(400)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"volumes": points(2), "next": "c2"})
		}},
		{"the cursor repeats", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"volumes": points(2), "next": "c2"})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ts := httptest.NewServer(tc.handler)
			t.Cleanup(ts.Close)
			p := listingProvider(t, ts.URL)
			if err := writeJSONAtomic(p.Layout.VolumesCache(), points(3), 0o644); err != nil {
				t.Fatal(err)
			}
			if l, err := p.server.Listings(context.Background()); err == nil {
				t.Fatalf("listing succeeded with %d restore points", len(l))
			}
			p.refreshListing(context.Background())
			var cached []Listing
			_ = readJSON(p.Layout.VolumesCache(), &cached)
			if len(cached) != 3 {
				t.Fatalf("the cache holds %d, want the last complete listing of 3", len(cached))
			}
		})
	}
}

// A guest's Backup tab (list_volumes with a VMID) shows every restore point of the guest, also
// those the cluster's listing does not hold; without the server it shows what it last got, or
// the cluster's listing once that is newer.
func TestListVolumesOfAGuestAsksTheServer(t *testing.T) {
	f := &listingServer{points: points(9), pageSize: 100}
	ts := httptest.NewServer(f.handler(t))
	p := listingProvider(t, ts.URL)
	// The cluster's listing holds only the newest two (as the newest page of a large cluster).
	if err := writeJSONAtomic(p.Layout.VolumesCache(), f.points[:2], 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	_ = os.Chtimes(p.Layout.VolumesCache(), old, old)
	out, err := p.Handle(context.Background(), "list-volumes", ProviderRequest{StoreID: "restow", VMID: 101})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{}
	for _, l := range f.points {
		if l.VMID == 101 {
			want = append(want, "backup/"+l.Volname)
		}
	}
	if got := volnames(t, out); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("list-volumes 101 = %v, want every restore point of 101 %v", got, want)
	}
	if f.queries[len(f.queries)-1] != "vmid=101" {
		t.Fatalf("asked %q, want vmid=101", f.queries[len(f.queries)-1])
	}

	// The server is away: the guest's own listing is newer than the cluster's.
	ts.Close()
	out, _ = p.Handle(context.Background(), "list-volumes", ProviderRequest{StoreID: "restow", VMID: 101})
	if got := volnames(t, out); len(got) != len(want) {
		t.Fatalf("without the server list-volumes 101 = %v, want the %d it last got", got, len(want))
	}
	// Once the cluster's listing is newer (a restore point was removed in Restow), it counts.
	if err := writeJSONAtomic(p.Layout.VolumesCache(), f.points[:1], 0o644); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Hour)
	_ = os.Chtimes(p.Layout.VolumesCache(), future, future)
	out, _ = p.Handle(context.Background(), "list-volumes", ProviderRequest{StoreID: "restow", VMID: 101})
	if got := volnames(t, out); len(got) != 1 || got[0] != "backup/"+f.points[0].Volname {
		t.Fatalf("list-volumes 101 = %v, want the newer cluster listing's one", got)
	}
}

// volume_size_info resolves the volume name through the server: a restore point the cluster's
// listing does not hold has its size, an unknown one is "not found", and without the server
// the node's listings answer.
func TestVolumeSizeAsksTheServer(t *testing.T) {
	f := &listingServer{points: points(5), pageSize: 100, sizes: map[string]uint64{}, devices: map[string][]DeviceSize{}}
	oldest := f.points[4].Volname
	f.sizes[oldest] = 8 << 30
	ts := httptest.NewServer(f.handler(t))
	p := listingProvider(t, ts.URL)
	if err := writeJSONAtomic(p.Layout.VolumesCache(), f.points[:2], 0o644); err != nil {
		t.Fatal(err)
	}
	size := func(volname string) (uint64, error) {
		out, err := p.Handle(context.Background(), "volume-size", ProviderRequest{StoreID: "restow", Volname: volname})
		if err != nil {
			return 0, err
		}
		return out.(map[string]any)["size"].(uint64), nil
	}
	if got, err := size("backup/" + oldest); err != nil || got != 8<<30 {
		t.Fatalf("size of a restore point outside the listing = %d, %v; want 8 GiB", got, err)
	}
	unknown := "backup/" + ArchiveName("vm", 101, time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC))
	if _, err := size(unknown); err == nil || !strings.Contains(err.Error(), "not found in Restow") {
		t.Fatalf("an unknown restore point: %v, want not found", err)
	}
	if _, err := size("backup/images/x"); err == nil {
		t.Fatal("a foreign volume name must be refused")
	}
	// A server before 0.5.0 sends no byteSize: the disks add up to the size.
	f.old = true
	f.devices[f.points[3].Volname] = []DeviceSize{{Device: "drive-scsi0", Size: 1 << 30}, {Device: "drive-scsi1", Size: 2 << 30}}
	if got, err := size("backup/" + f.points[3].Volname); err != nil || got != 3<<30 {
		t.Fatalf("size from an older server = %d, %v; want 3 GiB", got, err)
	}
	// Without the server: what the node's listing holds, else an error naming the cause.
	ts.Close()
	if got, err := size("backup/" + f.points[1].Volname); err != nil || got != f.points[1].Size {
		t.Fatalf("size without the server = %d, %v; want %d from the listing", got, err, f.points[1].Size)
	}
	if _, err := size("backup/" + oldest); err == nil || !strings.Contains(err.Error(), "did not answer") {
		t.Fatalf("a restore point neither the server nor the listing can give: %v", err)
	}
}
