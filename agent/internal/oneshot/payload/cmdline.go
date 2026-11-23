package payload

import (
	"fmt"
	"regexp"
	"strings"
)

// MaxCmdline is the kernel command line limit on x86 (COMMAND_LINE_SIZE,
// with the terminating NUL).
const MaxCmdline = 2048

// liveParams are the parameters of the recovery ISO's boot menu entries
// for a start without medium: live-boot takes the live file system from the
// directory in the initramfs.
var liveParams = []string{
	"boot=live", "components", "live-media=/" + MediumDir, "live-media-timeout=30",
	"noswap", "nopersistence", "modprobe.blacklist=amdgpu,radeon,nouveau,xe",
	"restow.oneshot=1",
}

// reConsole is a console= value of the running kernel that the recovery
// kernel may take over: a virtual terminal or a serial port with its
// settings. Anything else (netconsole, hvc of other platforms) is left out.
var reConsole = regexp.MustCompile(`^(tty[0-9]{1,2}|ttyS[0-3](,[0-9]{3,7}(n8)?)?)$`)

// Consoles returns the console= values of a kernel command line that
// Cmdline accepts, in their order (the last one is the kernel's main console).
func Consoles(cmdline string) []string {
	var out []string
	for _, f := range strings.Fields(cmdline) {
		if v, ok := strings.CutPrefix(f, "console="); ok && reConsole.MatchString(v) {
			out = append(out, v)
		}
	}
	return out
}

// ConsoleDevice is the device name of a console= value (ttyS0,115200n8 -> ttyS0).
func ConsoleDevice(v string) string {
	d, _, _ := strings.Cut(v, ",")
	return d
}

// Cmdline is the command line of the recovery kernel. consoles are the
// console= values of the running kernel (Consoles); with none, tty0 is
// used. restow.console names the last serial console of ttyS0 and ttyS1, the
// one recover talks on (the others get a copy of its output). The command
// line carries no secret: every process may read /proc/cmdline.
func Cmdline(consoles []string, keymap string) (string, error) {
	parts := append([]string(nil), liveParams...)
	if !reKeymap.MatchString(keymap) {
		return "", fmt.Errorf("keymap %q", keymap)
	}
	parts = append(parts, "restow.keymap="+keymap)
	if len(consoles) == 0 {
		consoles = []string{"tty0"}
	}
	serial := ""
	for _, c := range consoles {
		if !reConsole.MatchString(c) {
			return "", fmt.Errorf("console %q is not a terminal or serial port", c)
		}
		parts = append(parts, "console="+c)
		if d := ConsoleDevice(c); d == "ttyS0" || d == "ttyS1" {
			serial = d
		}
	}
	if serial != "" {
		parts = append(parts, "restow.console="+serial)
	}
	s := strings.Join(parts, " ")
	if len(s)+1 > MaxCmdline {
		return "", fmt.Errorf("kernel command line of %d bytes is too long", len(s))
	}
	return s, nil
}

var reKeymap = regexp.MustCompile(`^(de|us|ch|at|fr)$`)
