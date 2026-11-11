//go:build !linux

package main

import "testing"

// processLimits: the planner limits itself on Linux only.
func processLimits(*testing.T) string { return "" }
