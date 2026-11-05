//go:build !linux

package recovery

import "io"

// echoOff does nothing outside Linux (recover runs only on Linux; the
// dialogs are tested everywhere).
func echoOff(io.Reader) func() { return func() {} }
