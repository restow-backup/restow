//go:build !windows

package sqlserver

// NewScriptRunner reports that the native SQL Server backup does not run
// here.
func NewScriptRunner(tmpDir string, stderr func(string)) (ScriptRunner, error) {
	return nil, ErrUnsupported
}
