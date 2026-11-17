//go:build !linux && !darwin && !windows

package dbprobe

import "os"

func fileIdentity(_ *os.File, _ os.FileInfo) (inode, device, created *string) { return nil, nil, nil }
