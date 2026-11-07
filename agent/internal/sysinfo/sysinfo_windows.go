package sysinfo

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/restow-backup/restow/agent/internal/hooks"
	"github.com/restow-backup/restow/agent/internal/procenv"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// liveRegistry reads the registry of this machine (read-only, winapi).
type liveRegistry struct{}

func (liveRegistry) open(path string) *winapi.RegKey {
	k, err := winapi.OpenLocalMachineKey(path)
	if err != nil {
		return nil
	}
	return k
}

func (r liveRegistry) String(path, name string) (string, bool) {
	k := r.open(path)
	if k == nil {
		return "", false
	}
	defer k.Close()
	v, err := k.String(name)
	return v, err == nil
}

func (r liveRegistry) Integer(path, name string) (uint64, bool) {
	k := r.open(path)
	if k == nil {
		return 0, false
	}
	defer k.Close()
	v, err := k.Integer(name)
	return v, err == nil
}

func (r liveRegistry) SubKeys(path string) []string {
	k := r.open(path)
	if k == nil {
		return nil
	}
	defer k.Close()
	names, _ := k.SubKeyNames()
	return names
}

func (r liveRegistry) ValueNames(path string) []string {
	k := r.open(path)
	if k == nil {
		return nil
	}
	defer k.Close()
	names, _ := k.ValueNames()
	return names
}

// liveServices reads the service configuration (QueryServiceConfigW).
type liveServices struct{}

func (liveServices) Account(name string) (string, bool) {
	scm, err := winapi.OpenSCManager(winapi.SCManagerConnect)
	if err != nil {
		return "", false
	}
	defer winapi.CloseServiceHandle(scm)
	svc, err := winapi.OpenService(scm, name, winapi.ServiceQueryConfig)
	if err != nil {
		return "", false
	}
	defer winapi.CloseServiceHandle(svc)
	cfg, buf, err := winapi.QueryServiceConfig(svc)
	if err != nil {
		return "", true
	}
	account := winapi.UTF16PtrToString(cfg.ServiceStartName)
	_ = buf // keeps the strings alive while they are read
	return account, true
}

// wmiQuery is the one fixed WMI query of the machine facts: domain
// membership (Win32_ComputerSystem) and the BitLocker states of the volumes
// (Win32_EncryptableVolume; numeric states, independent of the language).
// It takes no input; nothing from outside goes into it.
const wmiQuery = `$ErrorActionPreference = 'Stop'
$r = @{ computer = $null; bitlocker = @{ available = $false; error = ''; volumes = @() } }
try {
  $cs = Get-CimInstance -ClassName Win32_ComputerSystem
  $r.computer = @{ partOfDomain = [bool]$cs.PartOfDomain; domain = [string]$cs.Domain }
} catch { }
try {
  $v = @(Get-CimInstance -Namespace 'root\cimv2\Security\MicrosoftVolumeEncryption' -ClassName Win32_EncryptableVolume)
  $r.bitlocker.available = $true
  $r.bitlocker.volumes = @($v | ForEach-Object { @{ driveLetter = [string]$_.DriveLetter; protectionStatus = [int]$_.ProtectionStatus; conversionStatus = [int]$_.ConversionStatus } })
} catch [Microsoft.Management.Infrastructure.CimException] {
  if ([string]$_.Exception.NativeErrorCode -eq 'InvalidNamespace') { $r.bitlocker.available = $false } else { $r.bitlocker.available = $true; $r.bitlocker.error = 'query failed' }
} catch {
  $r.bitlocker.available = $true; $r.bitlocker.error = 'query failed'
}
[Console]::Out.Write((ConvertTo-Json -InputObject $r -Compress -Depth 5))
`

// runWMIQuery runs the fixed query with Windows PowerShell 5.1 from the
// system folder, without a window and with a 30 second limit.
//
// -EncodedCommand, not "-Command -" with the script on stdin: PowerShell 5.1
// reads stdin like the interactive console, so a statement over several
// lines waits for an empty line and an open block at EOF is dropped without
// output (PowerShell issue #3223). The query then wrote nothing, and domain
// membership and BitLocker were missing on every machine. The Windows
// integration test (wmi_windows_test.go) pins both behaviours.
func runWMIQuery() ([]byte, error) {
	return runPowerShell(nil, "-EncodedCommand", hooks.EncodePowerShell(wmiQuery))
}

// runPowerShell runs powershell.exe from the system folder with the fixed
// options and args, stdin (nil: none) and keeps at most 256 KiB of stdout.
func runPowerShell(stdin io.Reader, args ...string) ([]byte, error) {
	sys, err := winapi.SystemDirectory()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ps := filepath.Join(sys, "WindowsPowerShell", "v1.0", "powershell.exe")
	argv := append([]string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"}, args...)
	cmd := exec.CommandContext(ctx, ps, argv...)
	cmd.Env = procenv.Base()
	cmd.Dir = sys
	cmd.Stdin = stdin
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: winapi.CreateNoWindow}
	var out bytes.Buffer
	cmd.Stdout = &limited{w: &out, n: 256 << 10}
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	if out.Len() == 0 {
		return nil, errors.New("the WMI query wrote nothing")
	}
	return out.Bytes(), nil
}

// limited keeps at most n bytes.
type limited struct {
	w *bytes.Buffer
	n int
}

func (l *limited) Write(p []byte) (int, error) {
	if room := l.n - l.w.Len(); room > 0 {
		if len(p) > room {
			l.w.Write(p[:room])
		} else {
			l.w.Write(p)
		}
	}
	return len(p), nil
}

func osVersion() string {
	return OSVersionText(DetectWindows(liveRegistry{}, liveServices{}, nil))
}

func detectWindowsMachine() Machine {
	return MachineFromWindows(liveRegistry{}, liveServices{}, runWMIQuery)
}
