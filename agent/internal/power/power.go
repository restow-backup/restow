// Package power answers one question for the "only on AC power" option of
// client endpoints: is this machine running on mains power? Detection is best
// effort per operating system. When the state cannot be determined the answer
// is "assume AC", so a backup is never blocked by a detection failure; the
// reason is returned so it can be logged.
package power

import (
	"bufio"
	"io/fs"
	"path"
	"strings"
)

// Status is the power source.
type Status struct {
	// OnAC is true on mains power (or when there is no battery, or unknown).
	OnAC bool
	// Known is false when detection failed or is unsupported; OnAC is then true.
	Known bool
	// Detail explains the answer for the log.
	Detail string
}

// Detect reads the power state of this machine.
func Detect() Status { return detect() }

// linuxSupplies evaluates a /sys/class/power_supply tree.
func linuxSupplies(root fs.FS) Status {
	entries, err := fs.ReadDir(root, ".")
	if err != nil {
		return Status{OnAC: true, Known: false, Detail: "power supply information is not available: " + err.Error()}
	}
	var batteries, mainsOnline, mainsSeen int
	var discharging, charging bool
	for _, e := range entries {
		typ := strings.ToLower(readTrim(root, path.Join(e.Name(), "type")))
		switch typ {
		case "battery":
			// Peripheral batteries (mouse, keyboard) have scope "Device".
			if strings.EqualFold(readTrim(root, path.Join(e.Name(), "scope")), "device") {
				continue
			}
			batteries++
			switch strings.ToLower(readTrim(root, path.Join(e.Name(), "status"))) {
			case "discharging":
				discharging = true
			case "charging", "full":
				charging = true
			}
		case "mains", "usb", "usb_c", "usb_pd", "usb_pd_drp", "usb_dcp", "usb_cdp", "usb_aca", "wireless":
			mainsSeen++
			if readTrim(root, path.Join(e.Name(), "online")) == "1" {
				mainsOnline++
			}
		}
	}
	switch {
	case batteries == 0:
		return Status{OnAC: true, Known: true, Detail: "no battery present"}
	case mainsOnline > 0:
		return Status{OnAC: true, Known: true, Detail: "mains power connected"}
	case mainsSeen > 0:
		return Status{OnAC: false, Known: true, Detail: "running on battery"}
	case discharging:
		return Status{OnAC: false, Known: true, Detail: "battery is discharging"}
	case charging:
		return Status{OnAC: true, Known: true, Detail: "battery is charging or full"}
	}
	return Status{OnAC: true, Known: false, Detail: "battery present but its state is unknown"}
}

func readTrim(root fs.FS, name string) string {
	b, err := fs.ReadFile(root, name)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// parsePmset interprets the first line of `pmset -g batt`, for example
// "Now drawing from 'AC Power'".
func parsePmset(out string) Status {
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		if !strings.Contains(line, "drawing from") {
			continue
		}
		switch {
		case strings.Contains(line, "'AC Power'"):
			return Status{OnAC: true, Known: true, Detail: "AC power"}
		case strings.Contains(line, "'Battery Power'"):
			return Status{OnAC: false, Known: true, Detail: "running on battery"}
		case strings.Contains(line, "'UPS Power'"):
			return Status{OnAC: false, Known: true, Detail: "running on UPS battery"}
		}
	}
	return Status{OnAC: true, Known: false, Detail: "cannot read the power source from pmset output"}
}
