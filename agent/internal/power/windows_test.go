package power

import "testing"

func TestWindowsPower(t *testing.T) {
	for _, c := range []struct {
		ac, flag byte
		onAC     bool
		known    bool
	}{
		{1, 128, true, true}, // no system battery
		{0, 128, true, true}, // desktop reporting "offline" without a battery
		{1, 8, true, true},   // charging
		{1, 1, true, true},
		{0, 1, false, true}, // on battery, high
		{0, 4, false, true}, // on battery, critical
		{255, 1, true, false},
		{255, 255, true, false}, // unknown battery state
		{0, 255, false, true},
	} {
		got := windowsPower(c.ac, c.flag)
		if got.OnAC != c.onAC || got.Known != c.known || got.Detail == "" {
			t.Errorf("ac=%d flag=%d: %+v", c.ac, c.flag, got)
		}
	}
}
