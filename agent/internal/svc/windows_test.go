package svc

import "testing"

func TestWindowsCommandLine(t *testing.T) {
	exe := `C:\Program Files\Restow\bin\restow-agent.exe`
	line := windowsCommandLine(exe)
	if line != `"C:\Program Files\Restow\bin\restow-agent.exe" run --service` {
		t.Fatal(line)
	}
	for in, want := range map[string]string{
		line:                  exe,
		`C:\x\agent.exe run`:  `C:\x\agent.exe`,
		`C:\x\agent.exe`:      `C:\x\agent.exe`,
		`"C:\x y\a.exe`:       `C:\x y\a.exe`,
		`  "C:\a b\c.exe" -x`: `C:\a b\c.exe`,
	} {
		if got := programFromCommandLine(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

func TestWindowsConfigDiffers(t *testing.T) {
	want := wantedWindowsConfig(`C:\Program Files\Restow\bin\restow-agent.exe`)
	have := want
	if d := windowsConfigDiffers(have, want); d != "" {
		t.Fatalf("same config differs: %s", d)
	}
	have.CommandLine = `"c:\program files\restow\bin\RESTOW-AGENT.EXE" run --service`
	have.StartName = `NT AUTHORITY\SYSTEM`
	have.Privileges = append([]string{}, windowsPrivileges...)
	have.Privileges[0], have.Privileges[1] = have.Privileges[1], have.Privileges[0]
	if d := windowsConfigDiffers(have, want); d != "" {
		t.Fatalf("case and order must not matter: %s", d)
	}
	for name, mutate := range map[string]func(*windowsConfig){
		"program":          func(c *windowsConfig) { c.CommandLine = `"C:\Temp\restow-agent.exe" run --service` },
		"unquoted":         func(c *windowsConfig) { c.CommandLine = `C:\Program Files\Restow\bin\restow-agent.exe run --service` },
		"start type":       func(c *windowsConfig) { c.Delayed = false },
		"account":          func(c *windowsConfig) { c.StartName = `NT AUTHORITY\LocalService` },
		"failure actions":  func(c *windowsConfig) { c.Restarts = []uint32{5000} },
		"privileges":       func(c *windowsConfig) { c.Privileges = append(c.Privileges, "SeDebugPrivilege") },
		"service SID":      func(c *windowsConfig) { c.SidUnrestricted = false },
		"shutdown timeout": func(c *windowsConfig) { c.PreshutdownMillis = 180000 },
	} {
		c := want
		c.Privileges = append([]string{}, want.Privileges...)
		mutate(&c)
		if windowsConfigDiffers(c, want) == "" {
			t.Errorf("%s: change not noticed", name)
		}
	}
}

func TestWindowsProtected(t *testing.T) {
	system := []string{`C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData`, `C:\Users`}
	for _, d := range []string{`C:\`, `D:\`, `c:\windows`, `C:\Program Files\`, `C:\PROGRAMDATA`, `C:\Users`, `D:\Users`, `E:\Windows`,
		``, `relative`, `\\server\share\x`, `C:\a\..\Windows`} {
		if !windowsProtected(d, system) {
			t.Errorf("%q must be protected", d)
		}
	}
	for _, d := range []string{`C:\ProgramData\Restow`, `C:\ProgramData\Restow\state`, `C:\Program Files\Restow`, `D:\Restow`} {
		if windowsProtected(d, system) {
			t.Errorf("%q must be removable", d)
		}
	}
}
