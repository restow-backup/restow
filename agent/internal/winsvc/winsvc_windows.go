//go:build windows

package winsvc

import (
	"context"
	"errors"
	"sync"
	"syscall"
	"time"

	"github.com/restow-backup/restow/agent/internal/winapi"
)

// The service control manager calls ServiceMain and the handler on threads
// of its own; syscall.NewCallback makes Go functions of them. Callbacks are a
// limited resource, so each is created once.
var (
	mu       sync.Mutex
	name     *uint16
	work     Main
	result   = make(chan error, 1)
	controls = make(chan uint32, 8)
	handle   uintptr

	serviceMainCallback = syscall.NewCallback(serviceMain)
	handlerCallback     = syscall.NewCallback(handler)
)

// Run connects to the service control manager and runs main as the service
// serviceName. It returns when the service has stopped.
func Run(serviceName string, main Main) error {
	n, err := syscall.UTF16PtrFromString(serviceName)
	if err != nil {
		return err
	}
	mu.Lock()
	name, work = n, main
	mu.Unlock()
	table := []winapi.ServiceTableEntry{{ServiceName: n, ServiceProc: serviceMainCallback}, {}}
	if err := winapi.StartServiceCtrlDispatcher(&table[0]); err != nil {
		if winapi.IsErrno(err, winapi.ErrorFailedServiceControllerCx) {
			return &ErrNotService{Err: err}
		}
		return err
	}
	select {
	case err := <-result:
		return err
	default:
		return nil
	}
}

// handler receives the control codes (HandlerEx).
func handler(control, eventType, eventData, context uintptr) uintptr {
	switch uint32(control) {
	case winapi.ServiceControlStop, winapi.ServiceControlPreshutdown, winapi.ServiceControlShutdown:
		select {
		case controls <- uint32(control):
		default:
		}
		return 0
	case winapi.ServiceControlInterrogate:
		return 0
	}
	return winapi.ErrorCallNotImplemented
}

func report(state, accepts, checkpoint, waitHint uint32, exit Exit) {
	st := winapi.ServiceStatus{
		ServiceType: winapi.ServiceWin32OwnProcess, CurrentState: state, ControlsAccepted: accepts,
		Win32ExitCode: exit.Code, ServiceSpecificExitCode: exit.Specific, CheckPoint: checkpoint, WaitHint: waitHint,
	}
	_ = winapi.SetServiceStatus(handle, &st)
}

// serviceMain runs on a thread of the service control manager.
func serviceMain(argc, argv uintptr) uintptr {
	mu.Lock()
	n, main := name, work
	mu.Unlock()
	h, err := winapi.RegisterServiceCtrlHandlerEx(n, handlerCallback)
	if err != nil {
		result <- err
		return 0
	}
	handle = h
	report(winapi.ServiceStartPending, 0, 1, 10000, Exit{})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan Exit, 1)
	go func() { done <- main(ctx) }()
	report(winapi.ServiceRunning, winapi.ServiceAcceptStop|winapi.ServiceAcceptPreshutdown, 0, 0, Exit{})

	var exit Exit
	select {
	case exit = <-done:
	case <-controls:
		cancel()
		exit = waitStopping(done)
	}
	if exit.Code == 0 && exit.Specific != 0 {
		exit.Code = winapi.ErrorServiceSpecificError
	}
	report(winapi.ServiceStopped, 0, 0, 0, exit)
	result <- nil
	return 0
}

// waitStopping reports STOP_PENDING with a growing checkpoint every five
// seconds until the work has returned.
func waitStopping(done <-chan Exit) Exit {
	checkpoint := uint32(1)
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	report(winapi.ServiceStopPending, 0, checkpoint, 10000, Exit{})
	for {
		select {
		case exit := <-done:
			return exit
		case <-tick.C:
			checkpoint++
			report(winapi.ServiceStopPending, 0, checkpoint, 10000, Exit{})
		}
	}
}

// IsNotService reports whether err says the process was not started as a service.
func IsNotService(err error) bool {
	var e *ErrNotService
	return errors.As(err, &e)
}
