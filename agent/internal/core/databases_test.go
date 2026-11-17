//go:build unix

package core

import (
	"context"
	"encoding/json"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

func strp(s string) *string { return &s }

// A db_probe task: the agent fetches the test with its credentials once, runs
// it beside everything else and posts the facts; the inventory goes out with
// the first heartbeat and then not again before six hours.
func TestDatabaseProbeTaskAndInventory(t *testing.T) {
	h := newHarness(t)
	var mu sync.Mutex
	var got []api.DBProbeSpec
	h.dbProbe = func(_ context.Context, spec api.DBProbeSpec) api.DBProbeResult {
		mu.Lock()
		got = append(got, spec)
		mu.Unlock()
		return api.DBProbeResult{Engine: strp("postgresql"), Login: "ok", TLS: api.DBTLSFacts{Used: true}}
	}
	inventories := 0
	h.dbInventory = func(context.Context) []api.DBInventoryInstance {
		inventories++
		port := 5432
		return []api.DBInventoryInstance{{Engine: "postgresql", Source: "pg_lsclusters", Name: "16/main", Port: &port}}
	}
	h.srv.Lock()
	h.srv.DBProbes = map[string]api.DBProbeSpec{"p-1": {
		ProbeID: "p-1", Host: strp("db.example.test"), AuthMethod: "password",
		User: strp("restow_backup"), Password: strp("s3cret"), TimeoutSeconds: 10,
	}}
	h.srv.Unlock()
	params, _ := json.Marshal(api.DBProbeTaskParams{ProbeID: "p-1"})
	h.srv.QueueTask(api.Task{ID: "t-1", Kind: api.TaskDBProbe, Params: params})
	h.start()

	deadline := time.Now().Add(10 * time.Second)
	for {
		h.srv.Lock()
		_, done := h.srv.DBProbeResults["p-1"]
		hb := len(h.srv.Heartbeats)
		h.srv.Unlock()
		if done && hb >= 3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the probe result did not arrive")
		}
		time.Sleep(20 * time.Millisecond)
	}
	h.srv.Lock()
	defer h.srv.Unlock()
	if r := h.srv.DBProbeResults["p-1"]; r.Login != "ok" || r.Engine == nil || *r.Engine != "postgresql" {
		t.Fatalf("result %+v", r)
	}
	if h.srv.DBProbeFetches["p-1"] != 1 {
		t.Fatalf("fetched %d times", h.srv.DBProbeFetches["p-1"])
	}
	mu.Lock()
	if len(got) != 1 || *got[0].User != "restow_backup" || *got[0].Password != "s3cret" {
		t.Fatalf("the probe got %+v", got)
	}
	mu.Unlock()
	with := 0
	for _, hb := range h.srv.Heartbeats {
		if !slices.Contains(hb.Capabilities, api.CapabilityDBRunner) {
			t.Fatalf("heartbeat without %s: %v", api.CapabilityDBRunner, hb.Capabilities)
		}
		if hb.DatabaseInventory != nil {
			with++
			if len(hb.DatabaseInventory.Instances) != 1 || hb.DatabaseInventory.Instances[0].Name != "16/main" {
				t.Fatalf("inventory %+v", hb.DatabaseInventory)
			}
		}
	}
	if with != 1 || inventories != 1 {
		t.Fatalf("inventory sent %d times, collected %d times; want once", with, inventories)
	}
}

// A db_health task: the agent fetches the checks with their credentials once,
// runs each one, posts the sample with the connection and asks for the sizes
// only on the first check of the task.
func TestDatabaseHealthTask(t *testing.T) {
	h := newHarness(t)
	var mu sync.Mutex
	var got []api.DBProbeSpec
	h.dbHealth = func(_ context.Context, spec api.DBProbeSpec) api.DBProbeResult {
		mu.Lock()
		got = append(got, spec)
		mu.Unlock()
		return api.DBProbeResult{Engine: strp("postgresql"), Login: "ok", TLS: api.DBTLSFacts{Used: true},
			Health: &api.DBHealthFacts{LatencyMs: 12}}
	}
	h.dbInventory = func(context.Context) []api.DBInventoryInstance { return nil }
	fingerprint := strp("3A:91")
	h.srv.Lock()
	h.srv.DBHealth = map[string]api.DBHealthPlan{"t-h": {TaskID: "t-h", WindowSeconds: 30, Checks: []api.DBHealthCheck{{
		ConnectionID: "c-1", FirstAfterSeconds: 0, IntervalSeconds: 300,
		Spec: api.DBProbeSpec{ProbeID: "t-h", Engine: strp("postgresql"), Host: strp("db.example.test"), AuthMethod: "password",
			User: strp("restow_backup"), Password: strp("s3cret"), TimeoutSeconds: 10, Purpose: api.PurposeHealth,
			PinnedFingerprintSHA256: fingerprint, Sizes: true},
	}}}}
	h.srv.Unlock()
	params, _ := json.Marshal(api.DBHealthTaskParams{WindowSeconds: 30})
	h.srv.QueueTask(api.Task{ID: "t-h", Kind: api.TaskDBHealth, Params: params})
	h.start()

	deadline := time.Now().Add(10 * time.Second)
	for {
		h.srv.Lock()
		n := len(h.srv.DBHealthSamples["t-h"])
		h.srv.Unlock()
		if n >= 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the health sample did not arrive")
		}
		time.Sleep(20 * time.Millisecond)
	}
	h.srv.Lock()
	defer h.srv.Unlock()
	if h.srv.DBHealthFetches["t-h"] != 1 {
		t.Fatalf("fetched %d times", h.srv.DBHealthFetches["t-h"])
	}
	sample := h.srv.DBHealthSamples["t-h"][0]
	if sample.ConnectionID != "c-1" || sample.Result.Health == nil || sample.Result.Health.LatencyMs != 12 || sample.At.IsZero() {
		t.Fatalf("sample %+v", sample)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 || *got[0].Password != "s3cret" || deref(got[0].PinnedFingerprintSHA256) != *fingerprint || !got[0].Sizes || got[0].Purpose != api.PurposeHealth {
		t.Fatalf("the check got %+v", got)
	}
}
