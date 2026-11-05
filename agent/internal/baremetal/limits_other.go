//go:build !linux

package baremetal

// SetPlannerLimits does nothing outside Linux: the server runs the planner
// on Linux only; elsewhere it is a tool for tests and support.
func SetPlannerLimits() error { return nil }
