package paths

import "fmt"

// UntrustedError names a file or folder the agent refuses to rely on because
// someone other than root (Unix) or SYSTEM, Administrators and TrustedInstaller
// (Windows) could change it.
type UntrustedError struct {
	Path   string
	Reason string
}

func (e *UntrustedError) Error() string {
	return fmt.Sprintf("%s %s. %s", e.Path, e.Reason, untrustedHint)
}
