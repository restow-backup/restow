//go:build !windows

package winsvc

import "errors"

// Run is only available on Windows.
func Run(string, Main) error {
	return &ErrNotService{Err: errors.New("there is no service control manager on this system")}
}

// IsNotService reports whether err says the process was not started as a service.
func IsNotService(err error) bool {
	var e *ErrNotService
	return errors.As(err, &e)
}
