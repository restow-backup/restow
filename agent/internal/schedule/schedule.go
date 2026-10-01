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
}

// Decision is the result of Evaluate.
type Decision struct {
	Due    bool
	Reason string
	// Next is when the agent expects to start the next run; zero if unknown
	// (on_connect waits for the network).
	Next time.Time
}

// FromAPI validates the schedule of the server configuration. Invalid values
// fall back to the defaults of the profile; every fallback is reported in
// warnings so it ends up in the log.
func FromAPI(s api.Schedule, profile string, jitter time.Duration) (Config, []string) {
	var warn []string
	cfg := Config{Kind: s.Kind, Jitter: jitter}
	switch s.Kind {
	case api.ScheduleInterval, api.ScheduleDaily, api.ScheduleOnConnect:
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

// RetryDelay is the wait before the next automatic retry.
func RetryDelay(h History) (time.Duration, bool) {
	if h.Interrupted {
		return 0, true
	}
	if h.ConsecutiveFailures <= 0 {
		return 0, false
	}
	if h.ConsecutiveFailures > MaxRetries {
		return 0, false
	}
	return retryDelays[h.ConsecutiveFailures-1], true
}

// Evaluate decides whether a backup is due now.
func Evaluate(cfg Config, h History, now time.Time, reachable bool) Decision {
	var candidates []time.Time
	regularDue := false
	reason := ""

	switch cfg.Kind {
	case api.ScheduleInterval:
		if h.LastAttemptAt.IsZero() {
			regularDue, reason = true, "no backup yet"
		} else {
			at := h.LastAttemptAt.Add(cfg.Interval)
			candidates = append(candidates, at)
			if !now.Before(at) {
				regularDue, reason = true, "interval elapsed"
			}
		}
	case api.ScheduleDaily:
		last := lastSlot(cfg, now)
		anchor := h.LastAttemptAt
		if h.EnrolledAt.After(anchor) {
			anchor = h.EnrolledAt
		}
		if anchor.Before(last) {
			regularDue, reason = true, "daily slot reached"
		}
		candidates = append(candidates, nextSlot(cfg, now))
	case api.ScheduleOnConnect:
		if h.LastAttemptAt.IsZero() {
			regularDue, reason = true, "no backup yet"
		} else {
			at := h.LastAttemptAt.Add(cfg.Interval)
			candidates = append(candidates, at)
			if !now.Before(at) {
				regularDue, reason = true, "minimum gap since the last backup elapsed"
			}
		}
	}

	retryDue := false
	if delay, ok := RetryDelay(h); ok && !h.LastAttemptAt.IsZero() {
		at := h.LastAttemptAt.Add(delay)
		candidates = append(candidates, at)
		if !now.Before(at) {
			retryDue = true
			if h.Interrupted {
				reason = "resuming an interrupted backup"
			} else {
				reason = fmt.Sprintf("retry %d after a failed backup", h.ConsecutiveFailures)
			}
		}
	}

	d := Decision{Next: earliestAfter(candidates, now)}
	if cfg.Kind == api.ScheduleOnConnect && !reachable {
		d.Next = time.Time{}
	}
	if !regularDue && !retryDue {
		d.Reason = "not due"
		return d
	}
	if !reachable {
		d.Reason = "due, waiting for the Restow instance to become reachable"
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
