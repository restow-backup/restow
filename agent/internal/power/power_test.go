package power

import (
	"testing"
	"testing/fstest"
)

func supply(typ, extra string, files map[string]string) map[string]*fstest.MapFile {
	m := map[string]*fstest.MapFile{}
	for k, v := range files {
		m[k] = &fstest.MapFile{Data: []byte(v)}
	}
	return m
}

func TestLinuxSupplies(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		onAC  bool
		known bool
	}{
		{"desktop without battery", map[string]string{"AC/type": "Mains\n", "AC/online": "1\n"}, true, true},
		{"empty tree", map[string]string{}, true, true},
		{"laptop on mains", map[string]string{"BAT0/type": "Battery", "BAT0/status": "Charging", "AC/type": "Mains", "AC/online": "1"}, true, true},
		{"laptop on battery", map[string]string{"BAT0/type": "Battery", "BAT0/status": "Discharging", "AC/type": "Mains", "AC/online": "0"}, false, true},
		{"laptop without mains node discharging", map[string]string{"BAT0/type": "Battery", "BAT0/status": "Discharging"}, false, true},
		{"laptop without mains node full", map[string]string{"BAT0/type": "Battery", "BAT0/status": "Full"}, true, true},
		{"only a mouse battery", map[string]string{"hid-1/type": "Battery", "hid-1/scope": "Device", "hid-1/status": "Discharging"}, true, true},
		{"unknown battery state", map[string]string{"BAT0/type": "Battery", "BAT0/status": "Unknown"}, true, false},
		{"usb-c charger online", map[string]string{"BAT0/type": "Battery", "BAT0/status": "Not charging", "ucsi/type": "USB", "ucsi/online": "1"}, true, true},
	}
	for _, c := range cases {
		st := linuxSupplies(fstest.MapFS(supply("", "", c.files)))
		if st.OnAC != c.onAC || st.Known != c.known {
			t.Errorf("%s: got %+v, want OnAC=%v Known=%v", c.name, st, c.onAC, c.known)
		}
		if st.Detail == "" {
			t.Errorf("%s: no detail", c.name)
		}
	}
}

func TestParsePmset(t *testing.T) {
	ac := "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234)\t100%; charged; 0:00 remaining present: true\n"
	bat := "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t63%; discharging; 3:10 remaining present: true\n"
	ups := "Now drawing from 'UPS Power'\n"
	if st := parsePmset(ac); !st.OnAC || !st.Known {
		t.Errorf("ac: %+v", st)
	}
	if st := parsePmset(bat); st.OnAC || !st.Known {
		t.Errorf("battery: %+v", st)
	}
	if st := parsePmset(ups); st.OnAC || !st.Known {
		t.Errorf("ups: %+v", st)
	}
	if st := parsePmset("garbage"); !st.OnAC || st.Known {
		t.Errorf("garbage must default to AC/unknown: %+v", st)
	}
}

func TestDetectDoesNotPanic(t *testing.T) {
	st := Detect()
	if st.Detail == "" {
		t.Fatalf("Detect returned no detail: %+v", st)
	}
}
