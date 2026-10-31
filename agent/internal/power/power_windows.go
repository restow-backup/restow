package power

// detect is not implemented on Windows yet (GetSystemPowerStatus,
// docs/WINDOWS-AGENT.md, section 11): assume AC, as for any detection failure.
func detect() Status {
	return Status{OnAC: true, Known: false, Detail: "power detection is not supported on Windows yet"}
}
