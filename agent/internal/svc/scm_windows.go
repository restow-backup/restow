//go:build windows

package svc

import (
	"errors"
	"fmt"
	"syscall"
	"time"
	"unsafe"

	"github.com/restow-backup/restow/agent/internal/winapi"
)

// scm is the Windows service manager: the service RestowAgent under
// LocalSystem, set up and controlled through advapi32 only (no sc.exe, whose
// output is localised; docs/WINDOWS-AGENT.md, section 9.1).
type scm struct {
	name string
}

// New returns the manager for this operating system.
func New() (Manager, error) { return &scm{name: WindowsServiceName}, nil }

// NewNamed returns a manager for a service with another name (tests).
func NewNamed(name string) Manager { return &scm{name: name} }

func (m *scm) Name() string { return "Windows" }

func (m *scm) open(access uint32) (mgr, svc syscall.Handle, err error) {
	mgr, err = winapi.OpenSCManager(winapi.SCManagerConnect)
	if err != nil {
		return 0, 0, fmt.Errorf("cannot connect to the service control manager: %w", err)
	}
	svc, err = winapi.OpenService(mgr, m.name, access)
	if err != nil {
		winapi.CloseServiceHandle(mgr)
		return 0, 0, err
	}
	return mgr, svc, nil
}

func closeBoth(mgr, svc syscall.Handle) {
	winapi.CloseServiceHandle(svc)
	winapi.CloseServiceHandle(mgr)
}

// Install creates the service or brings an existing one in line; it does not start it.
func (m *scm) Install(exe string) error {
	mgr, err := winapi.OpenSCManager(winapi.SCManagerConnect | winapi.SCManagerCreateService)
	if err != nil {
		return fmt.Errorf("cannot connect to the service control manager: %w", err)
	}
	defer winapi.CloseServiceHandle(mgr)
	svc, err := winapi.CreateService(mgr, m.name, WindowsServiceDisplay, windowsCommandLine(exe), winapi.ServiceAutoStart)
	if err != nil {
		if !winapi.IsErrno(err, winapi.ErrorServiceExists) {
			if winapi.IsErrno(err, winapi.ErrorServiceMarkedForDelete) {
				return errors.New("the service is marked for deletion; close the Services console (services.msc) or restart Windows, then try again")
			}
			return fmt.Errorf("cannot create the service: %w", err)
		}
		if svc, err = winapi.OpenService(mgr, m.name, 0xF01FF); err != nil {
			return fmt.Errorf("cannot open the existing service: %w", err)
		}
		if err := winapi.ChangeServiceConfig(svc, winapi.ServiceAutoStart, windowsCommandLine(exe), WindowsServiceDisplay); err != nil {
			winapi.CloseServiceHandle(svc)
			return fmt.Errorf("cannot update the service: %w", err)
		}
	}
	defer winapi.CloseServiceHandle(svc)
	if err := applyOptionalConfig(svc); err != nil {
		return err
	}
	return verifyConfig(svc, exe)
}

// verifyConfig reads the configuration back: a setting Windows did not take
// (a service prepared by someone else that cannot be repaired) is an error,
// not "brought in line".
func verifyConfig(svc syscall.Handle, exe string) error {
	have, err := readConfig(svc)
	if err != nil {
		return err
	}
	if d := windowsConfigDiffers(have, wantedWindowsConfig(exe)); d != "" {
		return fmt.Errorf("the setting %q of the service %s could not be brought in line; delete the service (sc.exe delete %s) and run the installer again", d, WindowsServiceName, WindowsServiceName)
	}
	return nil
}

// applyOptionalConfig sets everything CreateServiceW cannot: description,
// delayed start, failure actions (also on a non-crash failure, which the
// restart after a self-update needs), shutdown time, reduced privileges and
// the service SID.
func applyOptionalConfig(svc syscall.Handle) error {
	desc, _ := syscall.UTF16PtrFromString(windowsDescription)
	d := winapi.ServiceDescription{Description: desc}
	if err := winapi.ChangeServiceConfig2(svc, winapi.ServiceConfigDescription, unsafe.Pointer(&d)); err != nil {
		return fmt.Errorf("service description: %w", err)
	}
	delayed := winapi.ServiceDelayedAutoStartInfo{DelayedAutostart: 1}
	if err := winapi.ChangeServiceConfig2(svc, winapi.ServiceConfigDelayedAutoStartInfo, unsafe.Pointer(&delayed)); err != nil {
		return fmt.Errorf("delayed start: %w", err)
	}
	actions := make([]winapi.SCAction, len(windowsRestartDelaysMS))
	for i, ms := range windowsRestartDelaysMS {
		actions[i] = winapi.SCAction{Type: winapi.SCActionRestart, Delay: ms}
	}
	fa := winapi.ServiceFailureActions{ResetPeriod: windowsFailureResetSeconds, ActionsCount: uint32(len(actions)), Actions: &actions[0]}
	if err := winapi.ChangeServiceConfig2(svc, winapi.ServiceConfigFailureActions, unsafe.Pointer(&fa)); err != nil {
		return fmt.Errorf("failure actions: %w", err)
	}
	flag := winapi.ServiceFailureActionsFlag{FailureActionsOnNonCrashFailures: 1}
	if err := winapi.ChangeServiceConfig2(svc, winapi.ServiceConfigFailureActionsFlag, unsafe.Pointer(&flag)); err != nil {
		return fmt.Errorf("failure actions flag: %w", err)
	}
	pre := winapi.ServicePreshutdownInfo{PreshutdownTimeout: windowsPreshutdownMS}
	if err := winapi.ChangeServiceConfig2(svc, winapi.ServiceConfigPreshutdownInfo, unsafe.Pointer(&pre)); err != nil {
		return fmt.Errorf("shutdown time: %w", err)
	}
	privs, err := winapi.MultiSZ(windowsPrivileges)
	if err != nil {
		return err
	}
	rp := winapi.ServiceRequiredPrivilegesInfo{RequiredPrivileges: &privs[0]}
	if err := winapi.ChangeServiceConfig2(svc, winapi.ServiceConfigRequiredPrivilegesInfo, unsafe.Pointer(&rp)); err != nil {
		return fmt.Errorf("privileges: %w", err)
	}
	sid := winapi.ServiceSidInfo{ServiceSidType: winapi.ServiceSidTypeUnrestricted}
	if err := winapi.ChangeServiceConfig2(svc, winapi.ServiceConfigServiceSidInfo, unsafe.Pointer(&sid)); err != nil {
		return fmt.Errorf("service SID: %w", err)
	}
	return nil
}

// readConfig reads what Refresh compares.
func readConfig(svc syscall.Handle) (windowsConfig, error) {
	var c windowsConfig
	qc, buf, err := winapi.QueryServiceConfig(svc)
	if err != nil {
		return c, err
	}
	c.CommandLine = winapi.UTF16PtrToString(qc.BinaryPathName)
	c.StartType = qc.StartType
	c.StartName = winapi.UTF16PtrToString(qc.ServiceStartName)
	c.Dependencies = winapi.ParseMultiSZ(qc.Dependencies)
	c.LoadOrderGroup = winapi.UTF16PtrToString(qc.LoadOrderGroup)
	_ = buf
	if b, err := winapi.QueryServiceConfig2(svc, winapi.ServiceConfigDelayedAutoStartInfo); err == nil {
		c.Delayed = (*winapi.ServiceDelayedAutoStartInfo)(unsafe.Pointer(&b[0])).DelayedAutostart != 0
	}
	if b, err := winapi.QueryServiceConfig2(svc, winapi.ServiceConfigFailureActions); err == nil {
		fa := (*winapi.ServiceFailureActions)(unsafe.Pointer(&b[0]))
		c.ResetSeconds = fa.ResetPeriod
		if fa.Actions != nil && fa.ActionsCount > 0 {
			for _, a := range unsafe.Slice(fa.Actions, fa.ActionsCount) {
				if a.Type == winapi.SCActionRestart {
					c.Restarts = append(c.Restarts, a.Delay)
				}
			}
		}
	}
	if b, err := winapi.QueryServiceConfig2(svc, winapi.ServiceConfigFailureActionsFlag); err == nil {
		c.NonCrashFailures = (*winapi.ServiceFailureActionsFlag)(unsafe.Pointer(&b[0])).FailureActionsOnNonCrashFailures != 0
	}
	if b, err := winapi.QueryServiceConfig2(svc, winapi.ServiceConfigRequiredPrivilegesInfo); err == nil {
		c.Privileges = winapi.ParseMultiSZ((*winapi.ServiceRequiredPrivilegesInfo)(unsafe.Pointer(&b[0])).RequiredPrivileges)
	}
	if b, err := winapi.QueryServiceConfig2(svc, winapi.ServiceConfigServiceSidInfo); err == nil {
		c.SidUnrestricted = (*winapi.ServiceSidInfo)(unsafe.Pointer(&b[0])).ServiceSidType == winapi.ServiceSidTypeUnrestricted
	}
	if b, err := winapi.QueryServiceConfig2(svc, winapi.ServiceConfigPreshutdownInfo); err == nil {
		c.PreshutdownMillis = (*winapi.ServicePreshutdownInfo)(unsafe.Pointer(&b[0])).PreshutdownTimeout
	}
	return c, nil
}

// Start starts the service.
func (m *scm) Start() error {
	mgr, svc, err := m.open(winapi.ServiceStart | winapi.ServiceQueryStatus)
	if err != nil {
		return notInstalled(err)
	}
	defer closeBoth(mgr, svc)
	if err := winapi.StartService(svc); err != nil && !winapi.IsErrno(err, winapi.ErrorServiceAlreadyRunning) {
		return err
	}
	return waitState(svc, winapi.ServiceRunning, 60*time.Second)
}

// Stop stops the service and waits up to 90 s for it.
func (m *scm) Stop() error {
	mgr, svc, err := m.open(winapi.ServiceStop | winapi.ServiceQueryStatus)
	if err != nil {
		return notInstalled(err)
	}
	defer closeBoth(mgr, svc)
	return stopAndWait(svc)
}

func stopAndWait(svc syscall.Handle) error {
	if _, err := winapi.ControlService(svc, winapi.ServiceControlStop); err != nil && !winapi.IsErrno(err, winapi.ErrorServiceNotActive) {
		return err
	}
	return waitState(svc, winapi.ServiceStopped, 90*time.Second)
}

func waitState(svc syscall.Handle, want uint32, limit time.Duration) error {
	deadline := time.Now().Add(limit)
	for {
		st, err := winapi.QueryServiceStatus(svc)
		if err != nil {
			return err
		}
		if st.CurrentState == want {
			return nil
		}
		if want == winapi.ServiceRunning && st.CurrentState == winapi.ServiceStopped {
			return fmt.Errorf("the service stopped right after the start (exit code %d, service-specific %d); see C:\\ProgramData\\Restow\\logs\\agent.log",
				st.Win32ExitCode, st.ServiceSpecificExitCode)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the service did not reach the expected state within %s", limit)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// Restart stops and starts the service.
func (m *scm) Restart() error {
	if err := m.Stop(); err != nil {
		return err
	}
	return m.Start()
}

// Status reports state and process id.
func (m *scm) Status() Info {
	mgr, svc, err := m.open(winapi.ServiceQueryStatus)
	if err != nil {
		if winapi.IsErrno(err, winapi.ErrorServiceDoesNotExist) {
			return Info{State: NotInstalled}
		}
		return Info{State: Unknown, Detail: err.Error()}
	}
	defer closeBoth(mgr, svc)
	st, err := winapi.QueryServiceStatus(svc)
	if err != nil {
		return Info{State: Unknown, Detail: err.Error()}
	}
	switch st.CurrentState {
	case winapi.ServiceRunning:
		return Info{State: Running, PID: int(st.ProcessID)}
	case winapi.ServiceStopped:
		return Info{State: Stopped}
	case winapi.ServiceStartPending:
		return Info{State: Running, PID: int(st.ProcessID), Detail: "starting"}
	case winapi.ServiceStopPending:
		return Info{State: Running, PID: int(st.ProcessID), Detail: "stopping"}
	}
	return Info{State: Unknown, Detail: fmt.Sprintf("state %d", st.CurrentState)}
}

// Uninstall stops the service and deletes it.
func (m *scm) Uninstall() error {
	mgr, svc, err := m.open(winapi.ServiceStop | winapi.ServiceQueryStatus | winapi.Delete)
	if err != nil {
		if winapi.IsErrno(err, winapi.ErrorServiceDoesNotExist) {
			return nil
		}
		return err
	}
	defer closeBoth(mgr, svc)
	_ = stopAndWait(svc)
	if err := winapi.DeleteService(svc); err != nil && !winapi.IsErrno(err, winapi.ErrorServiceMarkedForDelete) {
		return err
	}
	return nil
}

// UninstallFromInside deletes the service without stopping it: the service
// control manager removes the entry once the running agent has ended.
func (m *scm) UninstallFromInside() error {
	mgr, svc, err := m.open(winapi.Delete)
	if err != nil {
		if winapi.IsErrno(err, winapi.ErrorServiceDoesNotExist) {
			return nil
		}
		return err
	}
	defer closeBoth(mgr, svc)
	if err := winapi.DeleteService(svc); err != nil && !winapi.IsErrno(err, winapi.ErrorServiceMarkedForDelete) {
		return err
	}
	return nil
}

// Refresh brings an installed service in line with what this version
// configures for exe; without a service it does nothing.
func (m *scm) Refresh(exe string) (bool, error) {
	mgr, svc, err := m.open(winapi.ServiceQueryConfig | winapi.ServiceChangeConfig)
	if err != nil {
		if winapi.IsErrno(err, winapi.ErrorServiceDoesNotExist) {
			return false, nil
		}
		return false, err
	}
	defer closeBoth(mgr, svc)
	have, err := readConfig(svc)
	if err != nil {
		return false, err
	}
	if windowsConfigDiffers(have, wantedWindowsConfig(exe)) == "" {
		return false, nil
	}
	if err := winapi.ChangeServiceConfig(svc, winapi.ServiceAutoStart, windowsCommandLine(exe), WindowsServiceDisplay); err != nil {
		return false, err
	}
	if err := applyOptionalConfig(svc); err != nil {
		return false, err
	}
	if err := verifyConfig(svc, exe); err != nil {
		return false, err
	}
	return true, nil
}

// ReloadFromInside: the service control manager only restarts after a
// failure, so the agent exits with the service-specific code 3 and the
// failure action starts it again (cmd/restow-agent maps exitNow to that code).
func (m *scm) ReloadFromInside() (bool, error) { return true, nil }

// Program returns the binary the installed service starts.
func (m *scm) Program() (string, error) {
	mgr, svc, err := m.open(winapi.ServiceQueryConfig)
	if err != nil {
		return "", notInstalled(err)
	}
	defer closeBoth(mgr, svc)
	qc, buf, err := winapi.QueryServiceConfig(svc)
	if err != nil {
		return "", err
	}
	line := winapi.UTF16PtrToString(qc.BinaryPathName)
	_ = buf
	return programFromCommandLine(line), nil
}

func notInstalled(err error) error {
	if winapi.IsErrno(err, winapi.ErrorServiceDoesNotExist) {
		return errors.New("the service RestowAgent is not installed")
	}
	return err
}
