//go:build windows

package hooks

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// errWindows is returned until the Windows hook runner exists (PowerShell
// wrapper, Job Objects; docs/WINDOWS-AGENT.md, section 12.2).
var errWindows = errors.New("hooks are not supported on Windows yet")

// Run refuses every hook on Windows for now. An empty hook is still a no-op,
// as on Unix.
func Run(_ context.Context, o Options) (Result, error) {
	if len(o.Argv) == 0 && strings.TrimSpace(o.Command) == "" {
		return Result{}, nil
	}
	return Result{}, errWindows
}

// Resolve refuses every configured hook on Windows for now.
func Resolve(_, _, _ string) ([]string, error) {
	return nil, fmt.Errorf("%w: %v", ErrNotAllowed, errWindows)
}

func trustedScript(string) (string, error) { return "", errWindows }
