//go:build windows

package update

import (
	"errors"
	"os"
)

// createStaged is not available on Windows yet: the Windows self-update stages
// and swaps the running binary differently (docs/WINDOWS-AGENT.md, section 13).
func createStaged(string, string) (*os.File, string, error) {
	return nil, "", errors.New("the self-update is not supported on Windows yet")
}
