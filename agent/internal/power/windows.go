package power

// windowsPower evaluates the two fields of SYSTEM_POWER_STATUS
// (docs/WINDOWS-AGENT.md, section 11). Without a system battery the machine
// is on mains; ACLineStatus 255 (unknown) never blocks a backup. A UPS that
// reports itself over HID counts as a battery, as with pmset on macOS.
func windowsPower(acLine, batteryFlag byte) Status {
	switch {
	case batteryFlag != 255 && batteryFlag&128 != 0:
		return Status{OnAC: true, Known: true, Detail: "no battery present"}
	case acLine == 1:
		return Status{OnAC: true, Known: true, Detail: "AC power"}
	case acLine == 0:
		return Status{OnAC: false, Known: true, Detail: "running on battery"}
	}
	return Status{OnAC: true, Known: false, Detail: "the power source is unknown (GetSystemPowerStatus)"}
}
