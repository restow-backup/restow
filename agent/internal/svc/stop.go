package svc

import (
	"errors"
	"fmt"
	"time"
)

// ErrStillRunning is returned when the service did not stop: the agent may
// still be stopping restic or running a post hook. An uninstall then removes
// nothing, neither the service nor the state, data or log folders.
var ErrStillRunning = errors.New("the Restow agent is still running")

// stopAndConfirm asks a service to stop (control) and waits until query
// reports it stopped, for at most limit. A control request that fails (the
// service is already stopping, or the request was refused) is no proof
// either way: what query reports decides. pid is the process of the service
// while it runs, for the message.
func stopAndConfirm(control func() error, query func() (stopped bool, pid uint32, err error), limit, every time.Duration) error {
	cerr := control()
	deadline := time.Now().Add(limit)
	for {
		stopped, pid, err := query()
		if err != nil {
			return fmt.Errorf("%w: its state cannot be read: %v", ErrStillRunning, err)
		}
		if stopped {
			return nil
		}
		if cerr != nil {
			return fmt.Errorf("%w (process %d): it cannot be asked to stop: %v", ErrStillRunning, pid, cerr)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%w (process %d): it did not stop within %s, for example because a backup or a hook is still ending", ErrStillRunning, pid, limit)
		}
		time.Sleep(every)
	}
}
