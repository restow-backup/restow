//go:build windows

package paths

import "errors"

// errTrustWindows is returned until the ACL-based trust check exists
// (docs/WINDOWS-AGENT.md, section 6). Until then nothing is trusted on
// Windows, so no file is executed or relied on.
var errTrustWindows = errors.New("the file and folder trust check is not supported on Windows yet")

// TrustedFile refuses every file on Windows for now.
func TrustedFile(string) (string, error) { return "", errTrustWindows }

// TrustedDir refuses every folder on Windows for now.
func TrustedDir(string, bool) (string, error) { return "", errTrustWindows }

// EnsureBinDir is not available on Windows yet.
func EnsureBinDir() (string, error) { return "", errTrustWindows }

// EnsureRootDir is not available on Windows yet.
func EnsureRootDir(string) (string, error) { return "", errTrustWindows }
