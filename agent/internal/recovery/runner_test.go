package recovery

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/cmdrun"
)

// ckbcomp's keymap is input for loadkeys, some hundred long lines: logged in full at every
// start of recover it filled the log and the serial console and pushed the messages out.
func TestQuietOutputLogsOnlyTheSize(t *testing.T) {
	keymap := strings.Repeat("keycode 71 = KP_7 KP_7 Hex_7 KP_7\n", 300)
	fake := cmdrun.NewFake(t).
		Add([]string{"ckbcomp", "de"}, keymap, 0).
		Add([]string{"lspci", "-k"}, "00:01.0 x\n", 0)
	var logs []string
	exe := CmdExec{Runner: fake, Log: func(s string) { logs = append(logs, s) }}
	res, err := exe.Run(context.Background(), RunSpec{Argv: []string{"ckbcomp", "de"}, QuietOutput: true})
	if err != nil {
		t.Fatal(err)
	}
	if string(res.Output) != keymap {
		t.Fatal("the output still goes to the caller")
	}
	if strings.Contains(strings.Join(logs, "\n"), "keycode") {
		t.Fatalf("the keymap was logged: %q", logs[:2])
	}
	want := []string{"$ ckbcomp de", "  (" + strconv.Itoa(len(keymap)) + " bytes of output, not logged)"}
	if strings.Join(logs, "|") != strings.Join(want, "|") {
		t.Fatalf("logs = %q, want %q", logs, want)
	}
	logs = nil
	if _, err := exe.Run(context.Background(), RunSpec{Argv: []string{"lspci", "-k"}}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(logs, "|") != "$ lspci -k|  00:01.0 x" {
		t.Fatalf("other output is logged as before: %q", logs)
	}
}
