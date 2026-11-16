package core

// Unit tests never use the machine's real LVM, btrfs or namespace helper:
// the default backend is none; tests that need one install a fake.
func init() { newFSBackendFn = func(*Agent) fsBackend { return nil } }
