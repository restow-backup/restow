package schedule

import (
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

func utc(y int, m time.Month, d, h, min int) time.Time {
	return time.Date(y, m, d, h, min, 0, 0, time.UTC)
}

func daily(t *testing.T, tod, zone string) Config {
	t.Helper()
	cfg, warn := FromAPI(api.Schedule{Kind: "daily", TimeOfDay: tod, TimeZone: zone}, "server", 0)
	if len(warn) != 0 {
		t.Fatalf("unexpected warnings: %v", warn)
	}
	return cfg
}

func TestParseTimeOfDay(t *testing.T) {
	good := map[string]time.Duration{"22:00": 22 * time.Hour, "0:05": 5 * time.Minute, "07:30:15": 7*time.Hour + 30*time.Minute + 15*time.Second}
	for in, want := range good {
		got, err := ParseTimeOfDay(in)
		if err != nil || got != want {
			t.Errorf("ParseTimeOfDay(%q) = %v, %v", in, got, err)
		}
	}
	for _, in := range []string{"", "24:00", "12:60", "abc", "12", "1:2:3:4", "-1:00"} {
		if _, err := ParseTimeOfDay(in); err == nil {
			t.Errorf("ParseTimeOfDay(%q) must fail", in)
		}
	}
}

func TestFromAPIDefaultsAndWarnings(t *testing.T) {
	cfg, warn := FromAPI(api.Schedule{}, "server", 0)
	if cfg.Kind != "daily" || cfg.TimeOfDay != 22*time.Hour || len(warn) != 0 {
		t.Fatalf("server default: %+v %v", cfg, warn)
	}
	cfg, _ = FromAPI(api.Schedule{Kind: "bogus"}, "client", 0)
	if cfg.Kind != "on_connect" || cfg.Interval != 4*time.Hour {
		t.Fatalf("client default: %+v", cfg)
	}
	cfg, warn = FromAPI(api.Schedule{Kind: "interval", IntervalMinutes: 1}, "server", 0)
	if cfg.Interval != MinInterval || len(warn) != 1 {
		t.Fatalf("clamp: %+v %v", cfg, warn)
	}
	cfg, warn = FromAPI(api.Schedule{Kind: "daily", TimeOfDay: "25:99"}, "server", 0)
	if cfg.TimeOfDay != 22*time.Hour || len(warn) != 1 {
		t.Fatalf("invalid time: %+v %v", cfg, warn)
	}
	_, warn = FromAPI(api.Schedule{Kind: "daily", TimeOfDay: "22:00", TimeZone: "Mars/Olympus"}, "server", 0)
	if len(warn) != 1 {
		t.Fatalf("invalid zone: %v", warn)
	}
	cfg, _ = FromAPI(api.Schedule{Kind: "on_connect", IntervalMinutes: 60}, "client", 0)
	if cfg.Interval != time.Hour {
		t.Fatalf("on_connect override: %+v", cfg)
	}
}

func TestIntervalFirstRunImmediateThenPeriodic(t *testing.T) {
	cfg, _ := FromAPI(api.Schedule{Kind: "interval", IntervalMinutes: 60}, "server", 0)
	now := utc(2026, 9, 30, 10, 0)
	d := Evaluate(cfg, History{}, now, true)
	if !d.Due {
		t.Fatalf("first interval run must start right away: %+v", d)
	}
	h := History{LastAttemptAt: now}
	if d := Evaluate(cfg, h, now.Add(59*time.Minute), true); d.Due || !d.Next.Equal(now.Add(time.Hour)) {
		t.Fatalf("not due yet: %+v", d)
	}
	if d := Evaluate(cfg, h, now.Add(60*time.Minute), true); !d.Due {
		t.Fatalf("due after the interval: %+v", d)
	}
}

func TestDailyRunsAtSlotAndCatchesUp(t *testing.T) {
	cfg := daily(t, "22:00", "UTC")
	enrolled := utc(2026, 9, 30, 10, 0)
	h := History{EnrolledAt: enrolled}

	// A fresh enrollment at 10:00 waits for 22:00.
	if d := Evaluate(cfg, h, utc(2026, 9, 30, 10, 5), true); d.Due || !d.Next.Equal(utc(2026, 9, 30, 22, 0)) {
		t.Fatalf("fresh enrollment: %+v", d)
	}
	if d := Evaluate(cfg, h, utc(2026, 9, 30, 21, 59), true); d.Due {
		t.Fatalf("before slot: %+v", d)
	}
	if d := Evaluate(cfg, h, utc(2026, 9, 30, 22, 0), true); !d.Due {
		t.Fatalf("at slot: %+v", d)
	}
	// After the run at 22:00 nothing is due until tomorrow.
	h.LastAttemptAt = utc(2026, 9, 30, 22, 0)
	if d := Evaluate(cfg, h, utc(2026, 9, 30, 23, 30), true); d.Due || !d.Next.Equal(utc(2026, 10, 1, 22, 0)) {
		t.Fatalf("after run: %+v", d)
	}
	// The machine was off at 22:00 on the 30th and comes back at 08:00: catch up once.
	h.LastAttemptAt = utc(2026, 9, 29, 22, 0)
	if d := Evaluate(cfg, h, utc(2026, 10, 1, 8, 0), true); !d.Due {
		t.Fatalf("catch-up: %+v", d)
	}
}

func TestDailyTimeZoneAndDST(t *testing.T) {
	cfg := daily(t, "22:00", "Europe/Berlin")
	h := History{EnrolledAt: utc(2026, 9, 1, 0, 0), LastAttemptAt: utc(2026, 9, 29, 20, 0)}
	// 22:00 CEST is 20:00 UTC in September.
	if d := Evaluate(cfg, h, utc(2026, 9, 30, 19, 59), true); d.Due {
		t.Fatalf("19:59 UTC must not be due in CEST: %+v", d)
	}
	if d := Evaluate(cfg, h, utc(2026, 9, 30, 20, 0), true); !d.Due {
		t.Fatalf("20:00 UTC is 22:00 CEST: %+v", d)
	}
	// After the switch back to CET (last Sunday of October 2026 = 25th) the slot is 21:00 UTC.
	h.LastAttemptAt = utc(2026, 10, 25, 21, 0)
	d := Evaluate(cfg, h, utc(2026, 10, 26, 20, 59), true)
	if d.Due || !d.Next.Equal(utc(2026, 10, 26, 21, 0)) {
		t.Fatalf("winter slot: %+v", d)
	}
}

func TestDailyJitterShiftsSlot(t *testing.T) {
	cfg, _ := FromAPI(api.Schedule{Kind: "daily", TimeOfDay: "22:00", TimeZone: "UTC"}, "server", 7*time.Minute)
	h := History{EnrolledAt: utc(2026, 9, 1, 0, 0), LastAttemptAt: utc(2026, 9, 29, 22, 7)}
	if d := Evaluate(cfg, h, utc(2026, 9, 30, 22, 6), true); d.Due {
		t.Fatalf("jitter not applied: %+v", d)
	}
	if d := Evaluate(cfg, h, utc(2026, 9, 30, 22, 7), true); !d.Due {
		t.Fatalf("due after jitter: %+v", d)
	}
}

func TestJitterForIsStableAndBounded(t *testing.T) {
	a := JitterFor("ep-1", MaxDailyJitter)
	if a != JitterFor("ep-1", MaxDailyJitter) {
		t.Fatal("jitter must be deterministic")
	}
	seen := map[time.Duration]bool{}
	for _, id := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		j := JitterFor(id, MaxDailyJitter)
		if j < 0 || j >= MaxDailyJitter {
			t.Fatalf("jitter out of range: %v", j)
		}
		seen[j] = true
	}
	if len(seen) < 4 {
		t.Fatalf("jitter barely varies: %v", seen)
	}
	if JitterFor("x", 0) != 0 {
		t.Fatal("zero max must give zero jitter")
	}
}

func TestOnConnect(t *testing.T) {
	cfg, _ := FromAPI(api.Schedule{Kind: "on_connect"}, "client", 0)
	now := utc(2026, 9, 30, 9, 0)

	if d := Evaluate(cfg, History{}, now, false); d.Due {
		t.Fatalf("unreachable must not start: %+v", d)
	}
	if d := Evaluate(cfg, History{}, now, true); !d.Due {
		t.Fatalf("first connect must start: %+v", d)
	}
	h := History{LastAttemptAt: now}
	if d := Evaluate(cfg, h, now.Add(3*time.Hour+59*time.Minute), true); d.Due {
		t.Fatalf("at most once per 4 h: %+v", d)
	}
	if d := Evaluate(cfg, h, now.Add(4*time.Hour), true); !d.Due {
		t.Fatalf("4 h elapsed: %+v", d)
	}
	// Due but offline: waits, then fires the moment the server is back.
	later := now.Add(10 * time.Hour)
	if d := Evaluate(cfg, h, later, false); d.Due {
		t.Fatalf("offline: %+v", d)
	}
	if d := Evaluate(cfg, h, later, true); !d.Due {
		t.Fatalf("online again: %+v", d)
	}
}

func TestInterruptedRunResumesIgnoringGap(t *testing.T) {
	cfg, _ := FromAPI(api.Schedule{Kind: "on_connect"}, "client", 0)
	now := utc(2026, 9, 30, 9, 0)
	h := History{LastAttemptAt: now.Add(-10 * time.Minute), Interrupted: true}
	if d := Evaluate(cfg, h, now, false); d.Due {
		t.Fatalf("offline: %+v", d)
	}
	d := Evaluate(cfg, h, now, true)
	if !d.Due || d.Reason != "resuming an interrupted backup" {
		t.Fatalf("resume: %+v", d)
	}
}

func TestRetryBackoffAndCap(t *testing.T) {
	cfg := daily(t, "22:00", "UTC")
	start := utc(2026, 9, 30, 22, 0)
	base := History{EnrolledAt: utc(2026, 9, 1, 0, 0), LastAttemptAt: start}

	wait := []time.Duration{5 * time.Minute, 15 * time.Minute, 30 * time.Minute, time.Hour, time.Hour}
	for i, w := range wait {
		h := base
		h.ConsecutiveFailures = i + 1
		if d := Evaluate(cfg, h, start.Add(w-time.Second), true); d.Due {
			t.Errorf("failure %d: due too early: %+v", i+1, d)
		}
		d := Evaluate(cfg, h, start.Add(w), true)
		if !d.Due {
			t.Errorf("failure %d: retry should be due after %v: %+v", i+1, w, d)
		}
	}
	// The sixth failure ends the retries for this cycle.
	h := base
	h.ConsecutiveFailures = MaxRetries + 1
	if d := Evaluate(cfg, h, start.Add(5*time.Hour), true); d.Due {
		t.Fatalf("retries must stop after %d: %+v", MaxRetries, d)
	}
	// The next regular slot still fires.
	if d := Evaluate(cfg, h, utc(2026, 10, 1, 22, 0), true); !d.Due {
		t.Fatalf("regular slot after exhausted retries: %+v", d)
	}
}

func TestNextIsEarliestFutureCandidate(t *testing.T) {
	cfg, _ := FromAPI(api.Schedule{Kind: "interval", IntervalMinutes: 240}, "server", 0)
	now := utc(2026, 9, 30, 10, 0)
	h := History{LastAttemptAt: now, ConsecutiveFailures: 1}
	d := Evaluate(cfg, h, now.Add(time.Minute), true)
	if !d.Next.Equal(now.Add(5 * time.Minute)) {
		t.Fatalf("next must be the retry time: %+v", d)
	}
}
