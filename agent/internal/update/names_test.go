package update

import "testing"

func TestFileNamesPerTarget(t *testing.T) {
	if fileName("windows-amd64", agentBase) != "restow-agent.exe" || fileName("windows-amd64", resticBase) != "restic.exe" {
		t.Fatal("windows names")
	}
	if fileName("linux-arm64", agentBase) != "restow-agent" || fileName("darwin-amd64", resticBase) != "restic" {
		t.Fatal("unix names")
	}
}

func TestIsLeftover(t *testing.T) {
	for name, want := range map[string]bool{
		".restic.new-0123456789abcdef":           true,
		".restow-agent.new-0123456789abcdef.exe": true,
		"restic.exe.old-0123456789abcdef":        true,
		"restow-agent.exe.old-0123456789abcdef":  true,
		"restow-agent.exe":                       false,
		"restow-agent.exe.prev":                  false,
		"restic":                                 false,
	} {
		if IsLeftover(name) != want {
			t.Errorf("%s: want %v", name, want)
		}
	}
}
