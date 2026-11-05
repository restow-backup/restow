//go:build !unix

package recovery

import "io/fs"

// fileOwner has no owner outside Unix (recover runs on Linux only).
func fileOwner(fs.FileInfo) ([2]int, bool) { return [2]int{}, false }
