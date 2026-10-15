package schedule

import (
	"fmt"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

// MissedGrace is how late a regular run may start and still count as on
// time. A slot that passed more than this long before the agent was running
// (machine off, asleep, agent stopped) is a missed backup, which the catch-up
// rules of the policy decide about. A slot the agent saw come while it was
// running but could not start (server unreachable, starts paused for an
// update, on battery) is never missed: it starts as soon as it can.
const MissedGrace = 15 * time.Minute

// Policy is the agent policy as far as the schedule is concerned. The zero
// value is not the default; use DefaultPolicy.
type Policy struct {
	// Window restricts when scheduled backups, catch-ups and retries may
	// start; nil means always. A running backup is never stopped by it.
	Window *Window
	// CatchUp: a missed backup is caught up.
	CatchUp bool
	// CatchUpMode is api.CatchUpASAP or api.CatchUpNextWindow.
	CatchUpMode string
	// CatchUpMaxAge: a missed backup older than this is not caught up; zero
	// means no limit.
	CatchUpMaxAge time.Duration
	// MaxRetries is the number of automatic retries after failed runs.
	MaxRetries int
}

// DefaultPolicy is the behavior without a policy, which is the behavior of
// the releases before policies: always allowed, a missed backup caught up as
// soon as possible, MaxRetries retries.
func DefaultPolicy() Policy {
	return Policy{CatchUp: true, CatchUpMode: api.CatchUpASAP, MaxRetries: MaxRetries}
}

// MaxPolicyRetries bounds the retries a policy can ask for.
const MaxPolicyRetries = 10

// Window is a weekly time range in which backups may start.
type Window struct {
	// Days the window begins on, indexed 1 (Monday) ... 7 (Sunday).
	Days [8]bool
	// From and To are times of day; a To not after From ends on the next day,
	// equal times make 24 hours.
	From, To time.Duration
	Location *time.Location
}

// PolicyFromAPI validates the policy of the server configuration. A missing
// policy or field keeps the default; an invalid field is reported in the
// warnings and keeps the default as well. zone is the location of the
// schedule, used when the window names no zone of its own.
func PolicyFromAPI(p *api.Policy, zone *time.Location) (Policy, []string) {
	pol := DefaultPolicy()
	if p == nil {
		return pol, nil
	}
	var warn []string
	if p.BackupWindow != nil {
		w, err := windowFromAPI(*p.BackupWindow, zone)
		if err != nil {
			warn = append(warn, fmt.Sprintf("invalid backup window (%v); backups may start at any time", err))
		} else {
			pol.Window = w
		}
	}
	if c := p.CatchUp; c != nil {
		pol.CatchUp = c.Enabled
		switch c.Mode {
		case "", api.CatchUpASAP:
			pol.CatchUpMode = api.CatchUpASAP
		case api.CatchUpNextWindow:
			pol.CatchUpMode = api.CatchUpNextWindow
		default:
			warn = append(warn, fmt.Sprintf("unknown catch-up mode %q, catching up as soon as possible", c.Mode))
		}
		if c.MaxAgeHours > 0 {
			pol.CatchUpMaxAge = time.Duration(c.MaxAgeHours) * time.Hour
		}
	}
	if p.MaxRetries != nil {
		n := *p.MaxRetries
		switch {
		case n < 0:
			warn = append(warn, fmt.Sprintf("invalid number of retries %d, using %d", n, MaxRetries))
		case n > MaxPolicyRetries:
			warn = append(warn, fmt.Sprintf("%d retries are too many, using %d", n, MaxPolicyRetries))
			pol.MaxRetries = MaxPolicyRetries
		default:
			pol.MaxRetries = n
		}
	}
	return pol, warn
}

func windowFromAPI(b api.BackupWindow, zone *time.Location) (*Window, error) {
	w := &Window{Location: zone}
	if w.Location == nil {
		w.Location = time.Local
	}
	if b.TimeZone != "" {
		l, err := time.LoadLocation(b.TimeZone)
		if err != nil {
			return nil, fmt.Errorf("unknown time zone %q", b.TimeZone)
		}
		w.Location = l
	}
	some := false
	for _, d := range b.Days {
		if d < 1 || d > 7 {
			return nil, fmt.Errorf("day %d is not 1 to 7", d)
		}
		w.Days[d] = true
		some = true
	}
	if !some {
		return nil, fmt.Errorf("no day")
	}
	var err error
	if w.From, err = ParseTimeOfDay(b.From); err != nil {
		return nil, err
	}
	if w.To, err = ParseTimeOfDay(b.To); err != nil {
		return nil, err
	}
	return w, nil
}

// isoWeekday is 1 (Monday) ... 7 (Sunday).
func isoWeekday(t time.Time) int {
	if wd := int(t.Weekday()); wd != 0 {
		return wd
	}
	return 7
}

func wallClock(day time.Time, dayOffset int, tod time.Duration, loc *time.Location) time.Time {
	return time.Date(day.Year(), day.Month(), day.Day()+dayOffset,
		int(tod/time.Hour), int((tod%time.Hour)/time.Minute), int((tod%time.Minute)/time.Second), 0, loc)
}

// span is the window that begins on the calendar day of t (in the window's
// zone) moved by offset days, if the window begins on that day. The ends are
// built from wall-clock fields, so the window follows daylight saving time: a
// window over the night of the change is an hour shorter or longer, one that
// lies entirely in the skipped hour does not open that day.
func (w *Window) span(t time.Time, offset int) (start, end time.Time, ok bool) {
	l := t.In(w.Location)
	// Noon is never skipped by a change of the clock, so the weekday is right.
	day := time.Date(l.Year(), l.Month(), l.Day()+offset, 12, 0, 0, 0, w.Location)
	if !w.Days[isoWeekday(day)] {
		return time.Time{}, time.Time{}, false
	}
	start = wallClock(day, 0, w.From, w.Location)
	endOffset := 0
	if w.To <= w.From {
		endOffset = 1
	}
	end = wallClock(day, endOffset, w.To, w.Location)
	if !end.After(start) {
		return time.Time{}, time.Time{}, false
	}
	return start, end, true
}

// Contains reports whether t lies in the window (start included, end not).
func (w *Window) Contains(t time.Time) bool {
	for off := -1; off <= 0; off++ {
		if s, e, ok := w.span(t, off); ok && !t.Before(s) && t.Before(e) {
			return true
		}
	}
	return false
}

// NextOpen is the first opening of the window after t; zero if it never opens.
func (w *Window) NextOpen(t time.Time) time.Time {
	for off := 0; off <= 8; off++ {
		if s, _, ok := w.span(t, off); ok && s.After(t) {
			return s
		}
	}
	return time.Time{}
}

// earliestStart is the first moment at or after t at which a backup may start.
func (p Policy) earliestStart(t time.Time) time.Time {
	if p.Window == nil || p.Window.Contains(t) {
		return t
	}
	return p.Window.NextOpen(t)
}

// allows reports whether a backup may start at t.
func (p Policy) allows(t time.Time) bool {
	return p.Window == nil || p.Window.Contains(t)
}
