package core

import (
	"errors"
	"testing"
)

func TestWindowsTargetForm(t *testing.T) {
	for _, ok := range []string{`C:\Restow-Restore-20261031-120000`, `d:\Wiederherstellung\Anna`, `E:\R`} {
		if _, parts, err := windowsTargetForm(ok); err != nil || len(parts) == 0 {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{`C:\`, `C:`, `\\server\share\r`, `\\?\C:\r`, `C:r`, `C:\a\..\b`, `C:\r\`, `C:/r`,
		`C:\r:ads`, `C:\a\NUL`, `C:\a\b.`, `relative\x`, `/tmp/x`} {
		_, _, err := windowsTargetForm(bad)
		var te *targetError
		if !errors.As(err, &te) || te.code != "invalid_task" {
			t.Errorf("%q: %v", bad, err)
		}
	}
}

func TestWindowsTargetBlocked(t *testing.T) {
	blocked := []string{`C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData\Restow`}
	for _, p := range []string{`C:\Windows`, `c:\windows\temp\r`, `C:\Program Files\x`, `C:\PROGRAM FILES (X86)\y`,
		`C:\ProgramData\Restow\data\r`, `D:\System Volume Information\r`, `E:\x\system volume information`} {
		if !windowsTargetBlocked(p, blocked) {
			t.Errorf("%s must be blocked", p)
		}
	}
	for _, p := range []string{`C:\Restow-Restore-1`, `C:\ProgramData\Other`, `C:\WindowsRestore`, `D:\Daten\R`, `C:\Users\anna\R`} {
		if windowsTargetBlocked(p, blocked) {
			t.Errorf("%s must be allowed", p)
		}
	}
}
