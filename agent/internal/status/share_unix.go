//go:build unix

package status

// shareStatusFile has nothing to do on Unix: the file mode (0644) makes the
// status readable by everyone.
func shareStatusFile(string) error { return nil }
