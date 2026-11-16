//go:build !windows

package sqlserver

// NewFS reports that the native SQL Server backup does not run here.
func NewFS() (FS, error) { return nil, ErrUnsupported }
