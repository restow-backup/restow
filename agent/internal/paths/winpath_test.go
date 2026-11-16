package paths

import "testing"

func TestSplitDrivePath(t *testing.T) {
	ok := map[string][]string{
		`C:\`:                       nil,
		`c:\Users\anna`:             {"Users", "anna"},
		`D:\Restow-Restore-2026`:    {"Restow-Restore-2026"},
		`C:\Program Files\Restow`:   {"Program Files", "Restow"},
		`C:\a\.hidden\x.txt`:        {"a", ".hidden", "x.txt"},
		`C:\Daten\CONFIG`:           {"Daten", "CONFIG"},
		`C:\Daten\[Projekt] Umlaut`: {"Daten", "[Projekt] Umlaut"},
	}
	for p, want := range ok {
		drive, parts, err := SplitDrivePath(p)
		if err != nil {
			t.Errorf("%s: %v", p, err)
			continue
		}
		if len(drive) != 2 || drive[0] < 'A' || drive[0] > 'Z' {
			t.Errorf("%s: drive %q", p, drive)
		}
		if len(parts) != len(want) {
			t.Errorf("%s: parts %q, want %q", p, parts, want)
		}
	}
	for _, p := range []string{
		``, `C:`, `C:foo`, `\\server\share\x`, `\\?\C:\x`, `\\.\PhysicalDrive0`, `C:/Users`, `C:\Users/anna`,
		`C:\a\..\b`, `C:\a\.\b`, `C:\a\\b`, `C:\a\`, `C:\a\b:stream`, `C:\a\b?`, `C:\a\b*`, `C:\a\<x>`, `C:\a\"x"`,
		`C:\a\b|c`, "C:\\a\\b\x01", `C:\a\b.`, `C:\a\b `, `C:\CON`, `C:\x\nul.txt`, `C:\x\COM1`, `C:\x\lpt9.log`,
		`1:\x`, `/etc/passwd`,
	} {
		if _, _, err := SplitDrivePath(p); err == nil {
			t.Errorf("%q: accepted", p)
		}
	}
}

func TestCleanFinalPath(t *testing.T) {
	for in, want := range map[string]string{
		`\\?\C:\Program Files\Restow`: `C:\Program Files\Restow`,
		`\\?\c:\x`:                    `C:\x`,
		`\\?\C:`:                      `C:\`,
		`\\?\UNC\server\share`:        `UNC\server\share`,
	} {
		if got := CleanFinalPath(in); got != want {
			t.Errorf("%s: %s, want %s", in, got, want)
		}
	}
}

func TestWinPathEqualOrBelow(t *testing.T) {
	if !WinPathEqualOrBelow(`C:\Windows\System32`, `c:\windows`) || !WinPathEqualOrBelow(`C:\Windows`, `C:\Windows\`) {
		t.Fatal("below")
	}
	if WinPathEqualOrBelow(`C:\WindowsApps`, `C:\Windows`) || WinPathEqualOrBelow(`C:\x`, ``) {
		t.Fatal("not below")
	}
}
