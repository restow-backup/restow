//go:build windows

package state

import "errors"

// errWindows is returned until the state folder is protected by a DACL and the
// secrets by DPAPI (docs/WINDOWS-AGENT.md, section 7). Until then no state is
// written or read on Windows.
var errWindows = errors.New("the agent state is not supported on Windows yet")

func ensureDir(string) error { return errWindows }

func syncDir(string) error { return nil }

func checkFile(string) ([]string, error) { return nil, errWindows }
