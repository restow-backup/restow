package recovery

import "strings"

// ISOKeymaps are the keyboard layouts of the boot menu (restow.keymap=).
var ISOKeymaps = []string{"de", "us", "ch", "at", "fr"}

// CmdlineOptions are the parameters recover reads from /proc/cmdline
// (contract C-M4-2); anything else is ignored.
type CmdlineOptions struct {
	// Console is /dev/ttyS0 or /dev/ttyS1 (restow.console=ttyS0|ttyS1),
	// else empty.
	Console string
	// Keymap is one of ISOKeymaps (restow.keymap=), else empty.
	Keymap string
	// AnswersMedia is restow.answers=media.
	AnswersMedia bool
}

// ParseCmdline reads the restow.* parameters of a kernel command line.
func ParseCmdline(s string) CmdlineOptions {
	var o CmdlineOptions
	for _, f := range strings.Fields(s) {
		k, v, ok := strings.Cut(f, "=")
		if !ok {
			continue
		}
		switch k {
		case "restow.console":
			if v == "ttyS0" || v == "ttyS1" {
				o.Console = "/dev/" + v
			}
		case "restow.keymap":
			if oneOfStr(v, ISOKeymaps...) {
				o.Keymap = v
			}
		case "restow.answers":
			o.AnswersMedia = v == "media"
		}
	}
	return o
}
