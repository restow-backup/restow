//go:build windows && windowsintegration

package sysinfo

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"unsafe"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/winapi"
)

// The fixed WMI query of the machine facts on a real Windows: it answers,
// domain membership agrees with NetGetJoinInformation and the BitLocker
// summary is not an error. Runs in the CI job "Go agent on Windows" (step
// "Windows integration tests"):
//
//	go test -tags windowsintegration ./internal/sysinfo/

func TestWMIQueryAnswers(t *testing.T) {
	raw, err := runWMIQuery()
	if err != nil {
		t.Fatalf("runWMIQuery: %v", err)
	}
	t.Logf("WMI answer: %s", raw)
	var q windowsQuery
	if err := json.Unmarshal(raw, &q); err != nil {
		t.Fatalf("not JSON: %v: %s", err, raw)
	}
	if q.Computer == nil {
		t.Fatalf("computer is null (Win32_ComputerSystem failed): %s", raw)
	}
	if strings.TrimSpace(q.Computer.Domain) == "" {
		t.Errorf("Win32_ComputerSystem.Domain is empty (it holds the domain or the workgroup): %s", raw)
	}
	joined, name := joinInformation(t)
	if q.Computer.PartOfDomain != joined {
		t.Errorf("partOfDomain %v, NetGetJoinInformation says joined=%v (%q)", q.Computer.PartOfDomain, joined, name)
	}
	if !joined && !strings.EqualFold(q.Computer.Domain, name) {
		t.Errorf("workgroup %q, NetGetJoinInformation says %q", q.Computer.Domain, name)
	}
	if q.BitLocker == nil {
		t.Fatalf("bitlocker is null: %s", raw)
	}
	if q.BitLocker.Error != "" {
		t.Errorf("BitLocker query failed: %s", raw)
	}
}

// The facts the heartbeat carries: domain and BitLocker are filled.
func TestDetectWindowsFillsDomainAndBitLocker(t *testing.T) {
	f := DetectWindows(liveRegistry{}, liveServices{}, runWMIQuery)
	joined, name := joinInformation(t)
	if f.DomainMember != joined {
		t.Errorf("DomainMember %v, NetGetJoinInformation says joined=%v (%q)", f.DomainMember, joined, name)
	}
	if joined && f.Domain == "" {
		t.Error("a domain member without a domain name")
	}
	if !joined && f.Domain != "" {
		t.Errorf("not in a domain, yet Domain %q", f.Domain)
	}
	if f.BitLocker == nil {
		t.Fatal("BitLocker not looked at")
	}
	t.Logf("BitLocker: %+v", *f.BitLocker)
	switch f.BitLocker.State {
	case api.BitLockerNotInstalled:
		if len(f.BitLocker.Volumes) != 0 {
			t.Errorf("not installed, yet volumes: %+v", f.BitLocker.Volumes)
		}
	case api.BitLockerOK:
		// Win32_EncryptableVolume lists every volume, the system drive
		// included, whether it is encrypted or not.
		sys, err := winapi.SystemDirectory()
		if err != nil {
			t.Fatal(err)
		}
		drive := strings.ToUpper(filepath.VolumeName(sys))
		found := false
		for _, v := range f.BitLocker.Volumes {
			if v.Mount == drive {
				found = true
				if v.Protection == "unknown" || v.Conversion == "unknown" {
					t.Errorf("system drive with unknown state: %+v", v)
				}
			}
		}
		if !found {
			t.Errorf("system drive %s missing: %+v", drive, f.BitLocker.Volumes)
		}
	default:
		t.Errorf("BitLocker state %q", f.BitLocker.State)
	}
}

// Why the query goes as -EncodedCommand: the same script through "-Command -"
// on stdin (as before 0.5.0) writes nothing on Windows PowerShell 5.1,
// because the first try block spans several lines and no empty line follows.
// Should this test fail, PowerShell reads stdin differently, and the comment
// on runWMIQuery is out of date; the query itself is unaffected.
func TestWMIQueryOverStdinWritesNothing(t *testing.T) {
	out, err := runPowerShell(strings.NewReader(wmiQuery), "-Command", "-")
	t.Logf("stdin variant: err=%v, %d bytes: %s", err, len(out), out)
	if len(out) != 0 {
		t.Errorf("the stdin variant answered after all (%d bytes)", len(out))
	}
}

// joinInformation asks NetGetJoinInformation whether the machine is in a
// domain, independent of WMI; name is the NetBIOS domain or the workgroup.
func joinInformation(t *testing.T) (joined bool, name string) {
	t.Helper()
	sys, err := winapi.SystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	netapi := syscall.NewLazyDLL(filepath.Join(sys, "netapi32.dll"))
	var buf *uint16
	var status uint32
	r, _, _ := netapi.NewProc("NetGetJoinInformation").Call(0, uintptr(unsafe.Pointer(&buf)), uintptr(unsafe.Pointer(&status)))
	if r != 0 {
		t.Fatalf("NetGetJoinInformation: %d", r)
	}
	defer netapi.NewProc("NetApiBufferFree").Call(uintptr(unsafe.Pointer(buf)))
	const netSetupDomainName = 3 // NETSETUP_JOIN_STATUS
	return status == netSetupDomainName, winapi.UTF16PtrToString(buf)
}
