//go:build !windows

package eventlog

func report(int, uint32, string) {}
