package schedule

import (
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

func berlin(t *testing.T) *time.Location {
	t.Helper()
	l, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func at(l *time.Location, y int, m time.Month, d, h, min int) time.Time {
	return time.Date(y, m, d, h, min, 0, 0, l)
}

func intp(n int) *int { return &n }

func window(t *testing.T, days []int, from, to, zone string) *Window {
	t.Helper()
	pol, warn := PolicyFromAPI(&api.Policy{BackupWindow: &api.BackupWindow{Days: days, From: from, To: to, TimeZone: zone}}, time.UTC)
	if len(warn) != 0 || pol.Window == nil {
		t.Fatalf("window %v %s-%s: %v", days, from, to, warn)
	}
	return pol.Window
}

var weekdays = []int{1, 2, 3, 4, 5}

// October 2026: the 12th is a Monday, the 16th a Friday, the 17th a Saturday.
func TestWindowContains(t *testing.T) {
	l := berlin(t)
	night := window(t, weekdays, "20:00", "06:00", "Europe/Berlin")
	day := window(t, []int{1, 2, 3, 4, 5, 6, 7}, "08:00", "17:00", "Europe/Berlin")
	allDay := window(t, []int{6}, "00:00", "00:00", "Europe/Berlin")
	cases := []struct {
		name string
		w    *Window
		at   time.Time
		want bool
	}{
		{"monday evening start included", night, at(l, 2026, 10, 12, 20, 0), true},
		{"monday before start", night, at(l, 2026, 10, 12, 19, 59), false},
		{"across midnight into tuesday", night, at(l, 2026, 10, 13, 3, 0), true},
		{"end excluded", night, at(l, 2026, 10, 13, 6, 0), false},
		{"tuesday midday", night, at(l, 2026, 10, 13, 12, 0), false},
		{"friday night reaches saturday morning", night, at(l, 2026, 10, 17, 5, 59), true},
		{"saturday evening is no start day", night, at(l, 2026, 10, 17, 21, 0), false},
		{"sunday night is no start day", night, at(l, 2026, 10, 18, 23, 0), false},
		{"monday early belongs to sunday's window", night, at(l, 2026, 10, 12, 2, 0), false},
		{"daytime window", day, at(l, 2026, 10, 14, 12, 0), true},
		{"daytime window end", day, at(l, 2026, 10, 14, 17, 0), false},
		{"24 hours saturday", allDay, at(l, 2026, 10, 17, 23, 59), true},
		{"24 hours ends sunday midnight", allDay, at(l, 2026, 10, 18, 0, 0), false},
		{"24 hours not friday", allDay, at(l, 2026, 10, 16, 23, 0), false},
		{"other zone of the instant", night, time.Date(2026, 10, 12, 18, 30, 0, 0, time.UTC), true},
	}
	for _, c := range cases {
		if got := c.w.Contains(c.at); got != c.want {
			t.Errorf("%s: Contains(%s) = %v", c.name, c.at, got)
		}
	}
}

func TestWindowNextOpen(t *testing.T) {
	l := berlin(t)
	night := window(t, weekdays, "20:00", "06:00", "Europe/Berlin")
	cases := []struct {
		from, want time.Time
	}{
		{at(l, 2026, 10, 12, 10, 0), at(l, 2026, 10, 12, 20, 0)},
		{at(l, 2026, 10, 12, 20, 0), at(l, 2026, 10, 13, 20, 0)},
		{at(l, 2026, 10, 16, 21, 0), at(l, 2026, 10, 19, 20, 0)}, // over the weekend
		{at(l, 2026, 10, 18, 12, 0), at(l, 2026, 10, 19, 20, 0)},
	}
	for _, c := range cases {
		if got := night.NextOpen(c.from); !got.Equal(c.want) {
			t.Errorf("NextOpen(%s) = %s, want %s", c.from, got, c.want)
		}
	}
}

// The last Sunday of March 2026 (29th) skips 02:00-03:00, the last Sunday of
// October (25th) repeats it. Windows follow the wall clock.
func TestWindowDaylightSaving(t *testing.T) {
	l := berlin(t)
	all := []int{1, 2, 3, 4, 5, 6, 7}
	w := window(t, all, "01:00", "04:00", "Europe/Berlin")
	// Spring: 01:00 CET to 04:00 CEST is two hours.
	if !w.Contains(time.Date(2026, 3, 29, 0, 0, 0, 0, time.UTC)) || !w.Contains(time.Date(2026, 3, 29, 1, 59, 0, 0, time.UTC)) ||
		w.Contains(time.Date(2026, 3, 29, 2, 0, 0, 0, time.UTC)) {
		t.Error("spring night must be two hours long")
	}
	// Autumn: 01:00 CEST to 04:00 CET is four hours.
	if !w.Contains(time.Date(2026, 10, 24, 23, 0, 0, 0, time.UTC)) || !w.Contains(time.Date(2026, 10, 25, 2, 59, 0, 0, time.UTC)) ||
		w.Contains(time.Date(2026, 10, 25, 3, 0, 0, 0, time.UTC)) {
		t.Error("autumn night must be four hours long")
	}
	// A window inside the skipped hour does not open that day, but the next.
	gap := window(t, all, "02:00", "03:00", "Europe/Berlin")
	for m := 0; m < 24*60; m += 5 {
		ts := at(l, 2026, 3, 29, 0, 0).Add(time.Duration(m) * time.Minute)
		if ts.Day() == 29 && gap.Contains(ts) {
			t.Fatalf("window in the skipped hour is open at %s", ts)
		}
	}
	if got := gap.NextOpen(at(l, 2026, 3, 29, 0, 0)); !got.Equal(at(l, 2026, 3, 30, 2, 0)) {
		t.Errorf("next opening after the skipped hour: %s", got)
	}
	// A window across midnight on the night of the change keeps its wall-clock ends.
	night := window(t, all, "22:00", "06:00", "Europe/Berlin")
	if got := night.NextOpen(at(l, 2026, 3, 28, 12, 0)); !got.Equal(time.Date(2026, 3, 28, 21, 0, 0, 0, time.UTC)) {
		t.Errorf("CET opening: %s", got)
	}
	if !night.Contains(time.Date(2026, 3, 29, 3, 59, 0, 0, time.UTC)) || night.Contains(time.Date(2026, 3, 29, 4, 0, 0, 0, time.UTC)) {
		t.Error("the window must end at 06:00 CEST (04:00 UTC)")
	}
}

func TestPolicyFromAPI(t *testing.T) {
	pol, warn := PolicyFromAPI(nil, time.UTC)
	if len(warn) != 0 || pol != DefaultPolicy() {
		t.Fatalf("no policy must be the default: %+v %v", pol, warn)
	}
	pol, warn = PolicyFromAPI(&api.Policy{}, time.UTC)
	if len(warn) != 0 || pol != DefaultPolicy() {
		t.Fatalf("empty policy must be the default: %+v %v", pol, warn)
	}
	pol, warn = PolicyFromAPI(&api.Policy{
		CatchUp:    &api.CatchUp{Enabled: true, Mode: api.CatchUpNextWindow, MaxAgeHours: 12},
		MaxRetries: intp(2),
	}, time.UTC)
	if len(warn) != 0 || pol.CatchUpMode != api.CatchUpNextWindow || pol.CatchUpMaxAge != 12*time.Hour || pol.MaxRetries != 2 {
		t.Fatalf("parsed: %+v %v", pol, warn)
	}
	// The window falls back to the zone of the schedule.
	pol, _ = PolicyFromAPI(&api.Policy{BackupWindow: &api.BackupWindow{Days: []int{1}, From: "20:00", To: "06:00"}}, berlin(t))
	if pol.Window == nil || pol.Window.Location.String() != "Europe/Berlin" {
		t.Fatalf("zone fallback: %+v", pol.Window)
	}
	bad := []api.Policy{
		{BackupWindow: &api.BackupWindow{Days: []int{}, From: "20:00", To: "06:00"}},
		{BackupWindow: &api.BackupWindow{Days: []int{8}, From: "20:00", To: "06:00"}},
		{BackupWindow: &api.BackupWindow{Days: []int{1}, From: "25:00", To: "06:00"}},
		{BackupWindow: &api.BackupWindow{Days: []int{1}, From: "20:00", To: "06:00", TimeZone: "Mars/Base"}},
		{CatchUp: &api.CatchUp{Enabled: true, Mode: "sometime"}},
		{MaxRetries: intp(-1)},
		{MaxRetries: intp(99)},
	}
	for i, b := range bad {
		pol, warn := PolicyFromAPI(&b, time.UTC)
		if len(warn) != 1 {
			t.Errorf("bad policy %d: warnings %v", i, warn)
		}
		if pol.Window != nil || pol.CatchUpMode != api.CatchUpASAP || pol.MaxRetries < 0 || pol.MaxRetries > MaxPolicyRetries {
			t.Errorf("bad policy %d must fall back: %+v", i, pol)
		}
	}
}

func dailyWith(t *testing.T, tod string, p *api.Policy) Config {
	t.Helper()
	cfg := daily(t, tod, "Europe/Berlin")
	pol, warn := PolicyFromAPI(p, cfg.Location)
	if len(warn) != 0 {
		t.Fatalf("policy warnings: %v", warn)
	}
	cfg.Policy = pol
	return cfg
}

func nightWindow() *api.BackupWindow {
	return &api.BackupWindow{Days: []int{1, 2, 3, 4, 5, 6, 7}, From: "20:00", To: "06:00"}
}

func TestEvaluateWithWindow(t *testing.T) {
	l := berlin(t)
	enrolled := at(l, 2026, 10, 1, 0, 0)
	up := func(ts time.Time) History {
		return History{EnrolledAt: enrolled, LastAttemptAt: at(l, 2026, 10, 12, 1, 0), AwakeSince: ts}
	}
	// A slot outside the window waits for the window (on time, not missed).
	noon := dailyWith(t, "12:00", &api.Policy{BackupWindow: nightWindow()})
	h := up(at(l, 2026, 10, 13, 8, 0))
	d := Evaluate(noon, h, at(l, 2026, 10, 13, 12, 0), true)
	if d.Due || !d.Next.Equal(at(l, 2026, 10, 13, 20, 0)) || d.Reason != WaitingForWindow {
		t.Fatalf("slot before the window: %+v", d)
	}
	if d := Evaluate(noon, h, at(l, 2026, 10, 13, 20, 0), true); !d.Due {
		t.Fatalf("window opens: %+v", d)
	}
	// Next run when idle points at the window too.
	h.LastAttemptAt = at(l, 2026, 10, 13, 20, 0)
	if d := Evaluate(noon, h, at(l, 2026, 10, 13, 21, 0), true); d.Due || !d.Next.Equal(at(l, 2026, 10, 14, 20, 0)) {
		t.Fatalf("next run in the window: %+v", d)
	}
	// A slot inside the window starts on time.
	late := dailyWith(t, "22:00", &api.Policy{BackupWindow: nightWindow()})
	h = up(at(l, 2026, 10, 13, 8, 0))
	if d := Evaluate(late, h, at(l, 2026, 10, 13, 22, 0), true); !d.Due {
		t.Fatalf("slot in the window: %+v", d)
	}
	// Held back past the end of the window (server unreachable), it waits for the next window.
	if d := Evaluate(late, h, at(l, 2026, 10, 14, 6, 30), true); d.Due || !d.Next.Equal(at(l, 2026, 10, 14, 20, 0)) {
		t.Fatalf("window closed meanwhile: %+v", d)
	}
}

func TestEvaluateWindowWeekdays(t *testing.T) {
	l := berlin(t)
	cfg := dailyWith(t, "21:00", &api.Policy{BackupWindow: &api.BackupWindow{Days: weekdays, From: "20:00", To: "06:00"}})
	h := History{EnrolledAt: at(l, 2026, 10, 1, 0, 0), LastAttemptAt: at(l, 2026, 10, 16, 21, 0), AwakeSince: at(l, 2026, 10, 1, 0, 0)}
	// Saturday's slot waits until Monday's window opens.
	d := Evaluate(cfg, h, at(l, 2026, 10, 17, 21, 0), true)
	if d.Due || !d.Next.Equal(at(l, 2026, 10, 19, 20, 0)) {
		t.Fatalf("saturday: %+v", d)
	}
	// Friday's window still runs into Saturday morning: a retry at 01:00 Saturday may start.
	h.ConsecutiveFailures = 1
	h.LastAttemptAt = at(l, 2026, 10, 17, 0, 50)
	if d := Evaluate(cfg, h, at(l, 2026, 10, 17, 1, 0), true); !d.Due {
		t.Fatalf("retry in friday's window: %+v", d)
	}
}

func TestEvaluateCatchUp(t *testing.T) {
	l := berlin(t)
	enrolled := at(l, 2026, 10, 1, 0, 0)
	// The machine was off at 22:00 on the 13th and starts at 08:00 on the 14th.
	missed := History{EnrolledAt: enrolled, LastAttemptAt: at(l, 2026, 10, 12, 22, 0), AwakeSince: at(l, 2026, 10, 14, 8, 0)}
	now := at(l, 2026, 10, 14, 8, 1)
	nextSlot := at(l, 2026, 10, 14, 22, 0)
	cases := []struct {
		name   string
		policy *api.Policy
		h      History
		now    time.Time
		due    bool
		next   time.Time
		reason string
	}{
		{name: "default: at once", policy: nil, h: missed, now: now, due: true, reason: "catching up a missed backup"},
		{name: "catch-up off waits for the next slot", policy: &api.Policy{CatchUp: &api.CatchUp{Enabled: false}},
			h: missed, now: now, next: nextSlot, reason: "not caught up"},
		{name: "within the maximum age", policy: &api.Policy{CatchUp: &api.CatchUp{Enabled: true, MaxAgeHours: 12}},
			h: missed, now: now, due: true},
		{name: "older than the maximum age", policy: &api.Policy{CatchUp: &api.CatchUp{Enabled: true, MaxAgeHours: 6}},
			h: missed, now: now, next: nextSlot, reason: "older than 6h0m0s"},
		{name: "asap still waits for the window", policy: &api.Policy{BackupWindow: nightWindow(), CatchUp: &api.CatchUp{Enabled: true}},
			h: missed, now: now, next: at(l, 2026, 10, 14, 20, 0), reason: WaitingForWindow},
		{name: "asap inside the window", policy: &api.Policy{BackupWindow: nightWindow(), CatchUp: &api.CatchUp{Enabled: true}},
			h:   History{EnrolledAt: enrolled, LastAttemptAt: at(l, 2026, 10, 12, 22, 0), AwakeSince: at(l, 2026, 10, 14, 1, 0)},
			now: at(l, 2026, 10, 14, 1, 1), due: true},
		{name: "next window: back inside a window waits for the next one",
			policy: &api.Policy{BackupWindow: nightWindow(), CatchUp: &api.CatchUp{Enabled: true, Mode: api.CatchUpNextWindow}},
			h:      History{EnrolledAt: enrolled, LastAttemptAt: at(l, 2026, 10, 12, 22, 0), AwakeSince: at(l, 2026, 10, 14, 1, 0)},
			now:    at(l, 2026, 10, 14, 1, 1), next: at(l, 2026, 10, 14, 20, 0), reason: "next backup window"},
		{name: "next window: starts when it opens",
			policy: &api.Policy{BackupWindow: nightWindow(), CatchUp: &api.CatchUp{Enabled: true, Mode: api.CatchUpNextWindow}},
			h:      History{EnrolledAt: enrolled, LastAttemptAt: at(l, 2026, 10, 12, 22, 0), AwakeSince: at(l, 2026, 10, 14, 1, 0)},
			now:    at(l, 2026, 10, 14, 20, 0), due: true, reason: "in the backup window"},
		{name: "next window without a window is asap",
			policy: &api.Policy{CatchUp: &api.CatchUp{Enabled: true, Mode: api.CatchUpNextWindow}},
			h:      missed, now: now, due: true},
		{name: "agent restarted just after the slot: not missed",
			policy: &api.Policy{CatchUp: &api.CatchUp{Enabled: false}},
			h:      History{EnrolledAt: enrolled, LastAttemptAt: at(l, 2026, 10, 12, 22, 0), AwakeSince: at(l, 2026, 10, 13, 22, 10)},
			now:    at(l, 2026, 10, 13, 22, 11), due: true},
		{name: "held back while running (server away for hours): not missed",
			policy: &api.Policy{CatchUp: &api.CatchUp{Enabled: false}},
			h:      History{EnrolledAt: enrolled, LastAttemptAt: at(l, 2026, 10, 12, 22, 0), AwakeSince: at(l, 2026, 10, 13, 9, 0)},
			now:    at(l, 2026, 10, 14, 3, 0), due: true},
		{name: "unknown awake time: never missed",
			policy: &api.Policy{CatchUp: &api.CatchUp{Enabled: false}},
			h:      History{EnrolledAt: enrolled, LastAttemptAt: at(l, 2026, 10, 12, 22, 0)},
			now:    now, due: true},
	}
	for _, c := range cases {
		cfg := dailyWith(t, "22:00", c.policy)
		d := Evaluate(cfg, c.h, c.now, true)
		if d.Due != c.due {
			t.Errorf("%s: due = %v (%+v)", c.name, d.Due, d)
			continue
		}
		if !c.next.IsZero() && !d.Next.Equal(c.next) {
			t.Errorf("%s: next = %s, want %s", c.name, d.Next, c.next)
		}
		if c.reason != "" && !strings.Contains(d.Reason, c.reason) {
			t.Errorf("%s: reason %q, want %q", c.name, d.Reason, c.reason)
		}
	}
	// A skipped missed slot is not run at the next slot twice: the next slot is due as usual.
	cfg := dailyWith(t, "22:00", &api.Policy{CatchUp: &api.CatchUp{Enabled: false}})
	if d := Evaluate(cfg, missed, nextSlot, true); !d.Due {
		t.Fatalf("next regular slot after a skipped one: %+v", d)
	}
}

func TestEvaluateIntervalCatchUp(t *testing.T) {
	cfg, _ := FromAPI(api.Schedule{Kind: "interval", IntervalMinutes: 60, TimeZone: "UTC"}, "server", 0)
	cfg.Policy, _ = PolicyFromAPI(&api.Policy{CatchUp: &api.CatchUp{Enabled: false}}, time.UTC)
	last := utc(2026, 10, 14, 8, 0)
	// Off from 08:30 to 11:20: the 09:00, 10:00 and 11:00 points were missed.
	h := History{LastAttemptAt: last, AwakeSince: utc(2026, 10, 14, 11, 20)}
	d := Evaluate(cfg, h, utc(2026, 10, 14, 11, 21), true)
	if d.Due || !d.Next.Equal(utc(2026, 10, 14, 12, 0)) {
		t.Fatalf("missed interval: %+v", d)
	}
	if d := Evaluate(cfg, h, utc(2026, 10, 14, 12, 0), true); !d.Due {
		t.Fatalf("next point of the interval: %+v", d)
	}
	// on_connect is never a missed backup.
	oc, _ := FromAPI(api.Schedule{Kind: "on_connect"}, "client", 0)
	oc.Policy = cfg.Policy
	if d := Evaluate(oc, History{LastAttemptAt: last, AwakeSince: utc(2026, 10, 15, 9, 0)}, utc(2026, 10, 15, 9, 1), true); !d.Due {
		t.Fatalf("on_connect after being away: %+v", d)
	}
}

func TestEvaluateRetriesOfThePolicy(t *testing.T) {
	start := utc(2026, 9, 30, 22, 0)
	base := History{EnrolledAt: utc(2026, 9, 1, 0, 0), LastAttemptAt: start}
	for _, tc := range []struct {
		max      int
		failures int
		wait     time.Duration
		due      bool
	}{
		{0, 1, time.Hour, false},
		{2, 2, 15 * time.Minute, true},
		{2, 3, 5 * time.Hour, false},
		{8, 7, time.Hour, true}, // beyond the fixed delays: as long as the last
		{8, 7, 59 * time.Minute, false},
		{8, 9, 5 * time.Hour, false},
	} {
		cfg := daily(t, "22:00", "UTC")
		cfg.Policy.MaxRetries = tc.max
		h := base
		h.ConsecutiveFailures = tc.failures
		if d := Evaluate(cfg, h, start.Add(tc.wait), true); d.Due != tc.due {
			t.Errorf("max %d, failure %d after %s: %+v", tc.max, tc.failures, tc.wait, d)
		}
	}
	// A retry outside the window waits for it.
	cfg := daily(t, "22:00", "UTC")
	cfg.Policy, _ = PolicyFromAPI(&api.Policy{BackupWindow: &api.BackupWindow{Days: []int{1, 2, 3, 4, 5, 6, 7}, From: "20:00", To: "23:00"}}, time.UTC)
	h := base
	h.ConsecutiveFailures = 4
	d := Evaluate(cfg, h, start.Add(time.Hour), true)
	if d.Due || !d.Next.Equal(utc(2026, 10, 1, 20, 0)) {
		t.Fatalf("retry outside the window: %+v", d)
	}
	// An interrupted run resumes in the window too.
	h = History{EnrolledAt: base.EnrolledAt, LastAttemptAt: utc(2026, 9, 30, 22, 50), Interrupted: true}
	if d := Evaluate(cfg, h, utc(2026, 9, 30, 23, 5), true); d.Due {
		t.Fatalf("resumption outside the window: %+v", d)
	}
}

func TestEvaluatePause(t *testing.T) {
	cfg := daily(t, "22:00", "UTC")
	h := History{EnrolledAt: utc(2026, 9, 1, 0, 0), LastAttemptAt: utc(2026, 9, 29, 22, 0), AwakeSince: utc(2026, 9, 30, 8, 0)}
	cfg.Policy, _ = PolicyFromAPI(&api.Policy{CatchUp: &api.CatchUp{Enabled: true, MaxAgeHours: 1}}, time.UTC)
	slot := utc(2026, 9, 30, 22, 0)
	d := EvaluateIn(cfg, h, slot, Conditions{Reachable: true, Paused: true})
	if d.Due || d.Reason != WaitingForPause {
		t.Fatalf("paused: %+v", d)
	}
	// Unreachable during the update: waits as well.
	if d := EvaluateIn(cfg, h, slot.Add(10*time.Minute), Conditions{Reachable: false}); d.Due || d.Reason != WaitingForServer {
		t.Fatalf("unreachable: %+v", d)
	}
	// Three hours later the pause ends: the run starts although it is older than the
	// catch-up limit, because the agent was running at the slot (not missed).
	if d := EvaluateIn(cfg, h, slot.Add(3*time.Hour), Conditions{Reachable: true}); !d.Due || d.Reason != "daily slot reached" {
		t.Fatalf("after the pause: %+v", d)
	}
	// Retries and resumptions wait for the pause as well.
	r := History{EnrolledAt: h.EnrolledAt, LastAttemptAt: slot, ConsecutiveFailures: 1}
	if d := EvaluateIn(cfg, r, slot.Add(time.Hour), Conditions{Reachable: true, Paused: true}); d.Due {
		t.Fatalf("retry while paused: %+v", d)
	}
}
