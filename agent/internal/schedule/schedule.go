// Package schedule decides when the next backup is due. It is pure logic (no
// clock, no I/O): the caller passes the current time, the run history and
// whether the Restow instance is reachable, and gets a decision. That keeps
// the rules testable, including daylight saving time and the retry backoff.
package schedule

import (
	"fmt"
	"hash/fnv"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // embedded zone database: minimal systems may not ship one

	"github.com/restow-backup/restow/agent/internal/api"
)

// Defaults of the specification.
const (
	DefaultDailyTime       = "22:00"
	DefaultOnConnectGap    = 4 * time.Hour
	MinInterval            = 5 * time.Minute
	DefaultIntervalMinutes = 24 * 60
	// MaxRetries is the number of automatic retries after failed runs before
	// the agent waits for the next regular slot.
	MaxRetries = 5
	// MaxDailyJitter spreads daily runs of many endpoints over ten minutes.
	MaxDailyJitter = 10 * time.Minute
)

// retryDelays are the waits before retry 1..MaxRetries after a failed run.
var retryDelays = []time.Duration{5 * time.Minute, 15 * time.Minute, 30 * time.Minute, time.Hour, time.Hour}

// Config is a validated schedule.
type Config struct {
	Kind string
	// Interval is the period of the interval kind and the minimum gap of
	// on_connect.
	Interval time.Duration
	// TimeOfDay of the daily kind, as minutes since midnight.
	TimeOfDay time.Duration
	Location  *time.Location
	// Jitter is added to the daily slot (deterministic per endpoint).
	Jitter time.Duration
	// Policy is the agent policy (backup window, catch-up, retries).
	Policy Policy
}

// History is what the schedule needs to know about earlier runs.
type History struct {
	// EnrolledAt guards a fresh enrollment against an immediate catch-up run
	// of the daily schedule.
	EnrolledAt time.Time
	// LastAttemptAt is when the last backup run started (any outcome).
	LastAttemptAt time.Time
	// Interrupted is set when the last run did not finish (agent restarted,
	// machine slept, connection lost). Such a run resumes as soon as the
	// server is reachable.
	Interrupted bool
	// ConsecutiveFailures counts failed runs since the last success.
	ConsecutiveFailures int
	// AwakeSince is since when the agent runs without a break (started, or
	// woke up from sleep). A regular run that became due well before is a
	// missed backup (MissedGrace). Zero: unknown, nothing counts as missed.
	AwakeSince time.Time
}

// Decision is the result of Evaluate.
type Decision struct {
	Due    bool
	Reason string
	// Wait is the code of what a due backup waits for (one of the Wait*
	// constants); empty when nothing waits. The heartbeat sends it to the
	// server, which shows it on the machine's page.
	Wait string
	// Next is when the agent expects to start the next run; zero if unknown
	// (on_connect waits for the network).
	Next time.Time
}

// FromAPI validates the schedule of the server configuration. Invalid values
// fall back to the defaults of the profile; every fallback is reported in
// warnings so it ends up in the log.
func FromAPI(s api.Schedule, profile string, jitter time.Duration) (Config, []string) {
	var warn []string
	cfg := Config{Kind: s.Kind, Jitter: jitter, Policy: DefaultPolicy()}
	switch s.Kind {
	case api.ScheduleInterval, api.ScheduleDaily, api.ScheduleOnConnect, api.ScheduleNone:
	default:
		if s.Kind != "" {
			warn = append(warn, fmt.Sprintf("unknown schedule kind %q, using the default of the %s profile", s.Kind, profile))
		}
		if profile == api.ProfileClient {
			cfg.Kind = api.ScheduleOnConnect
		} else {
			cfg.Kind = api.ScheduleDaily
		}
	}

	loc := time.Local
	if s.TimeZone != "" {
		l, err := time.LoadLocation(s.TimeZone)
		if err != nil {
			warn = append(warn, fmt.Sprintf("unknown time zone %q, using the local time zone of this machine", s.TimeZone))
		} else {
			loc = l
		}
	}
	cfg.Location = loc

	switch cfg.Kind {
	case api.ScheduleInterval:
		minutes := s.IntervalMinutes
		if minutes <= 0 {
			warn = append(warn, "interval schedule without intervalMinutes, using 24 hours")
			minutes = DefaultIntervalMinutes
		}
		cfg.Interval = time.Duration(minutes) * time.Minute
		if cfg.Interval < MinInterval {
			warn = append(warn, fmt.Sprintf("interval of %d minutes is too short, using %d minutes", minutes, int(MinInterval.Minutes())))
			cfg.Interval = MinInterval
		}
	case api.ScheduleDaily:
		tod, err := ParseTimeOfDay(s.TimeOfDay)
		if err != nil {
			if s.TimeOfDay != "" || s.Kind == api.ScheduleDaily {
				warn = append(warn, fmt.Sprintf("invalid timeOfDay %q, using %s", s.TimeOfDay, DefaultDailyTime))
			}
			tod, _ = ParseTimeOfDay(DefaultDailyTime)
		}
		cfg.TimeOfDay = tod
	case api.ScheduleOnConnect:
		cfg.Interval = DefaultOnConnectGap
		if s.IntervalMinutes > 0 {
			cfg.Interval = time.Duration(s.IntervalMinutes) * time.Minute
			if cfg.Interval < MinInterval {
				cfg.Interval = MinInterval
			}
		}
	}
	return cfg, warn
}

// ParseTimeOfDay parses "HH:MM" or "HH:MM:SS".
func ParseTimeOfDay(s string) (time.Duration, error) {
	parts := strings.Split(strings.TrimSpace(s), ":")
	if len(parts) < 2 || len(parts) > 3 {
		return 0, fmt.Errorf("time of day %q is not HH:MM", s)
	}
	nums := make([]int, len(parts))
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return 0, fmt.Errorf("time of day %q is not HH:MM", s)
		}
		nums[i] = n
	}
	if nums[0] > 23 || nums[1] > 59 || (len(nums) == 3 && nums[2] > 59) {
		return 0, fmt.Errorf("time of day %q is out of range", s)
	}
	d := time.Duration(nums[0])*time.Hour + time.Duration(nums[1])*time.Minute
	if len(nums) == 3 {
		d += time.Duration(nums[2]) * time.Second
	}
	return d, nil
}

// JitterFor derives a stable offset in [0, max) from an identifier, so the
// daily runs of many endpoints do not all start in the same second.
func JitterFor(id string, max time.Duration) time.Duration {
	if max <= 0 {
		return 0
	}
	h := fnv.New64a()
	_, _ = h.Write([]byte(id))
	return time.Duration(h.Sum64() % uint64(max))
}

// RetryDelay is the wait before the next automatic retry with the default
// number of retries.
func RetryDelay(h History) (time.Duration, bool) {
	return RetryDelayFor(h, MaxRetries)
}

// RetryDelayFor is the wait before the next automatic retry when at most
// maxRetries retries follow a failed run. Retries beyond the fixed delays
// wait as long as the last one.
func RetryDelayFor(h History, maxRetries int) (time.Duration, bool) {
	if h.Interrupted {
		return 0, true
	}
	if h.ConsecutiveFailures <= 0 {
		return 0, false
	}
	if h.ConsecutiveFailures > maxRetries {
		return 0, false
	}
	i := min(h.ConsecutiveFailures, len(retryDelays)) - 1
	return retryDelays[i], true
}

// WaitingForJob is the reason of every decision under the none schedule.
const WaitingForJob = "waiting for a backup job"

// Reasons of a decision that waits although a backup is due.
const (
	WaitingForServer = "due, waiting for the Restow instance to become reachable"
	WaitingForPause  = "due, waiting: the Restow instance pauses new backups while it is updated"
	WaitingForWindow = "due, waiting for the backup window"
)

// Codes of what a due backup waits for (Decision.Wait, the heartbeat's
// `waiting`). The server shows them on the machine's page and keeps a code it
// does not know as "waiting".
const (
	WaitBackupWindow   = "backup_window"
	WaitServer         = "server_unreachable"
	WaitUpdatePause    = "update_pause"
	WaitCatchUpWindow  = "catch_up_next_window"
	WaitCatchUpSkipped = "catch_up_skipped"
	// WaitACPower is decided by the agent (the scheduler does not know the
	// power source): due, but the device runs on battery power.
	WaitACPower = "ac_power"
)

// Conditions are what the agent knows about the server when it decides.
type Conditions struct {
	// Reachable: the Restow instance answered the last request.
	Reachable bool
	// Paused: the Restow instance pauses new runs for an update.
	Paused bool
}

// Evaluate decides whether a backup is due now (no pause known).
func Evaluate(cfg Config, h History, now time.Time, reachable bool) Decision {
	return EvaluateIn(cfg, h, now, Conditions{Reachable: reachable})
}

// EvaluateIn decides whether a backup is due now under the given conditions.
//
// The regular run is due at its slot (daily), when the interval has passed
// since the last attempt (interval, on_connect), or at once when there was
// none. The backup window of the policy moves every start (regular, catch-up,
// retry, resumption of an interrupted run) to a moment inside the window. A
// regular run whose start passed while the agent was not running (see
// MissedGrace) is a missed backup: it is caught up as the policy says, or
// skipped until the next regular slot. A due run waits while the server is
// unreachable or pauses new runs; that wait never makes it missed.
func EvaluateIn(cfg Config, h History, now time.Time, c Conditions) Decision {
	// A machine in no backup job starts nothing: no regular slot, no retry and
	// no resumption of an interrupted run (it resumes once a job schedules it).
	if cfg.Kind == api.ScheduleNone {
		return Decision{Reason: WaitingForJob}
	}
	p := cfg.Policy

	// dueAt is when the regular run became due (zero: not due); nextRegular
	// the regular slot after it.
	var dueAt, nextRegular time.Time
	reason := ""
	switch cfg.Kind {
	case api.ScheduleInterval, api.ScheduleOnConnect:
		if h.LastAttemptAt.IsZero() {
			dueAt, reason = now, "no backup yet"
		} else {
			at := h.LastAttemptAt.Add(cfg.Interval)
			if now.Before(at) {
				nextRegular = at
			} else {
				// The latest point of the interval's grid that has passed: a run
				// skipped as missed is due again at the next point.
				dueAt = at.Add(now.Sub(at) / cfg.Interval * cfg.Interval)
				nextRegular = dueAt.Add(cfg.Interval)
				reason = "interval elapsed"
				if cfg.Kind == api.ScheduleOnConnect {
					reason = "minimum gap since the last backup elapsed"
				}
			}
		}
	case api.ScheduleDaily:
		last := lastSlot(cfg, now)
		anchor := h.LastAttemptAt
		if h.EnrolledAt.After(anchor) {
			anchor = h.EnrolledAt
		}
		if anchor.Before(last) {
			dueAt, reason = last, "daily slot reached"
		}
		nextRegular = nextSlot(cfg, now)
	}

	var candidates []time.Time
	if !nextRegular.IsZero() {
		candidates = append(candidates, p.earliestStart(nextRegular))
	}
	regularDue := false
	waitReason, wait := "", ""
	if !dueAt.IsZero() {
		start := p.earliestStart(dueAt)
		missed := cfg.Kind != api.ScheduleOnConnect && !h.AwakeSince.IsZero() && !start.IsZero() &&
			start.Add(MissedGrace).Before(h.AwakeSince)
		switch {
		case start.IsZero():
			// A window that never opens: nothing starts.
		case start.After(now):
			candidates = append(candidates, start)
			waitReason, wait = WaitingForWindow, WaitBackupWindow
		case missed && !p.CatchUp:
			waitReason = "a missed backup is not caught up (policy); waiting for the next regular slot"
			wait = WaitCatchUpSkipped
		case missed && p.CatchUpMaxAge > 0 && now.Sub(start) > p.CatchUpMaxAge:
			waitReason = fmt.Sprintf("a missed backup is older than %s and not caught up (policy); waiting for the next regular slot", p.CatchUpMaxAge)
			wait = WaitCatchUpSkipped
		case missed && p.CatchUpMode == api.CatchUpNextWindow && p.Window != nil:
			// The next window that opens after the machine came back.
			at := p.Window.NextOpen(h.AwakeSince)
			switch {
			case at.IsZero():
			case at.After(now):
				candidates = append(candidates, at)
				waitReason, wait = "a missed backup is caught up in the next backup window", WaitCatchUpWindow
			case p.allows(now):
				regularDue, reason = true, "catching up a missed backup in the backup window"
			default:
				candidates = append(candidates, p.Window.NextOpen(now))
				waitReason, wait = WaitingForWindow, WaitBackupWindow
			}
		case !p.allows(now):
			candidates = append(candidates, p.earliestStart(now))
			waitReason, wait = WaitingForWindow, WaitBackupWindow
		default:
			regularDue = true
			if missed {
				reason = "catching up a missed backup"
			}
		}
	}

	retryDue := false
	if delay, ok := RetryDelayFor(h, p.MaxRetries); ok && !h.LastAttemptAt.IsZero() {
		at := h.LastAttemptAt.Add(delay)
		switch {
		case now.Before(at):
			candidates = append(candidates, p.earliestStart(at))
		case !p.allows(now):
			candidates = append(candidates, p.earliestStart(now))
			if !regularDue {
				waitReason, wait = WaitingForWindow, WaitBackupWindow
			}
		default:
			retryDue = true
			if h.Interrupted {
				reason = "resuming an interrupted backup"
			} else {
				reason = fmt.Sprintf("retry %d after a failed backup", h.ConsecutiveFailures)
			}
		}
	}

	d := Decision{Next: earliestAfter(candidates, now)}
	if cfg.Kind == api.ScheduleOnConnect && !c.Reachable {
		d.Next = time.Time{}
	}
	if !regularDue && !retryDue {
		d.Reason = "not due"
		if waitReason != "" {
			d.Reason, d.Wait = waitReason, wait
		}
		return d
	}
	if !c.Reachable {
		d.Reason, d.Wait = WaitingForServer, WaitServer
		return d
	}
	if c.Paused {
		d.Reason, d.Wait = WaitingForPause, WaitUpdatePause
		return d
	}
	d.Due, d.Reason = true, reason
	return d
}

func earliestAfter(ts []time.Time, now time.Time) time.Time {
	var best time.Time
	for _, t := range ts {
		if !t.After(now) {
			continue
		}
		if best.IsZero() || t.Before(best) {
			best = t
		}
	}
	return best
}

// daySlot returns the slot for the calendar day of t in the configured zone.
// Building the slot from wall-clock fields (not by adding 24h) keeps it right
// across daylight saving changes.
func daySlot(cfg Config, t time.Time, dayOffset int) time.Time {
	n := t.In(cfg.Location)
	base := time.Date(n.Year(), n.Month(), n.Day()+dayOffset, 0, 0, 0, 0, cfg.Location)
	h := int(cfg.TimeOfDay / time.Hour)
	m := int((cfg.TimeOfDay % time.Hour) / time.Minute)
	s := int((cfg.TimeOfDay % time.Minute) / time.Second)
	slot := time.Date(base.Year(), base.Month(), base.Day(), h, m, s, 0, cfg.Location)
	return slot.Add(cfg.Jitter)
}

// lastSlot is the most recent daily slot at or before now.
func lastSlot(cfg Config, now time.Time) time.Time {
	s := daySlot(cfg, now, 0)
	if s.After(now) {
		s = daySlot(cfg, now, -1)
	}
	return s
}

// nextSlot is the first daily slot after now.
func nextSlot(cfg Config, now time.Time) time.Time {
	s := daySlot(cfg, now, 0)
	if !s.After(now) {
		s = daySlot(cfg, now, 1)
	}
	return s
}
