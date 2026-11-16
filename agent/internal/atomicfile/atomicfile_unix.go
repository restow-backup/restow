//go:build unix

package atomicfile

import "os"

func rename(from, to string) error { return os.Rename(from, to) }

func isTransient(error) bool { return false }

func open(path string) (*os.File, error) { return os.Open(path) }
