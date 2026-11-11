//go:build linux

package main

import (
	"fmt"
	"syscall"
	"testing"
)

// processLimits are the data segment and CPU time limits of this process.
func processLimits(t *testing.T) string {
	t.Helper()
	var data, cpu syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_DATA, &data); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Getrlimit(syscall.RLIMIT_CPU, &cpu); err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("data %d/%d cpu %d/%d", data.Cur, data.Max, cpu.Cur, cpu.Max)
}
