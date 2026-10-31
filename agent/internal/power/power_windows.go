package power

import "github.com/restow-backup/restow/agent/internal/winapi"

// detect reads GetSystemPowerStatus; a failed call assumes AC, as for any
// detection failure.
func detect() Status {
	var s winapi.SystemPowerStatus
	if err := winapi.GetSystemPowerStatus(&s); err != nil {
		return Status{OnAC: true, Known: false, Detail: "power state is not available: " + err.Error()}
	}
	return windowsPower(s.ACLineStatus, s.BatteryFlag)
}
