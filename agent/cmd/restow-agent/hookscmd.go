package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/restow-backup/restow/agent/internal/hooks"
	"github.com/restow-backup/restow/agent/internal/paths"
	"github.com/restow-backup/restow/agent/internal/state"
)

const hooksUsage = `usage: restow-agent hooks [status | off | scripts | any]

Hooks are commands the Restow server asks the agent to run before and after a
backup (for example a database dump). They run as root, so this machine
decides whether the server may define them:

  off       never run hooks from the server (the default)
  scripts   only run scripts that root put into %s,
            named in the server configuration (no shell, no arguments)
  any       run any shell command the server configures (as earlier pre-release
            agents did)

Only root on this machine can change the policy; the Restow server cannot.
The server learns it with the next heartbeat (within five minutes) and refuses
hook settings this machine would not run.
`

// describeHooks says in one line what a hook mode means here.
func describeHooks(mode string, layout paths.Layout) string {
	switch hooks.NormalizeMode(mode) {
	case hooks.ModeScripts:
		return "scripts only (" + layout.HooksDir() + ")"
	case hooks.ModeAny:
		return "any command (runs as root)"
	}
	return "off"
}

func cmdHooks(args []string, stdout, stderr io.Writer) int {
	layout := paths.Default()
	action := "status"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		action, args = args[0], args[1:]
	}
	fs := newFlagSet("hooks "+action, stderr)
	fs.Usage = func() { fmt.Fprintf(stderr, hooksUsage, layout.HooksDir()) }
	if err := parseFlags(fs, args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}
		return exitUsage
	}
	if !requireRoot("hooks", stderr) {
		return exitError
	}
	st, warnings, err := state.Load(layout.StateFile())
	for _, w := range warnings {
		fmt.Fprintln(stderr, "note: "+w)
	}
	if err != nil {
		if errors.Is(err, state.ErrNotEnrolled) {
			fmt.Fprintln(stderr, "This machine is not enrolled. Use the install command from the Restow UI; its --hooks option sets the policy.")
		} else {
			fmt.Fprintf(stderr, "Cannot read the enrollment: %v\n", err)
		}
		return exitError
	}
	if action == "status" {
		printHooks(stdout, st.Hooks, layout)
		return exitOK
	}
	mode, err := hooks.ParseMode(action)
	if err != nil {
		fmt.Fprintln(stderr, err)
		fmt.Fprintf(stderr, hooksUsage, layout.HooksDir())
		return exitUsage
	}
	if mode == hooks.ModeScripts {
		if err := os.MkdirAll(layout.HooksDir(), 0o700); err != nil {
			fmt.Fprintf(stderr, "Cannot create %s: %v\n", layout.HooksDir(), err)
			return exitError
		}
	}
	if hooks.NormalizeMode(st.Hooks) == mode {
		fmt.Fprintf(stdout, "Hooks are already set to %s.\n", describeHooks(mode, layout))
		printHooks(stdout, mode, layout)
		return exitOK
	}
	st.Hooks = mode
	if err := st.Save(layout.StateFile()); err != nil {
		fmt.Fprintf(stderr, "Cannot store the hook policy in %s: %v\n", layout.StateFile(), err)
		return exitError
	}
	fmt.Fprintf(stdout, "Hooks from the Restow server: %s.\n", describeHooks(mode, layout))
	printHooks(stdout, mode, layout)
	fmt.Fprintln(stdout, "The agent applies this to the next backup; the Restow server sees it with the next heartbeat (within five minutes).")
	return exitOK
}

func printHooks(w io.Writer, mode string, layout paths.Layout) {
	mode = hooks.NormalizeMode(mode)
	fmt.Fprintf(w, "Hook policy:  %s\n", describeHooks(mode, layout))
	switch mode {
	case hooks.ModeOff:
		fmt.Fprintln(w, "Hooks configured in the Restow UI are not run on this machine. Allow them with: restow-agent hooks scripts (or any)")
	case hooks.ModeScripts:
		names := hooks.ListScripts(layout.HooksDir())
		if len(names) == 0 {
			fmt.Fprintf(w, "No usable scripts in %s yet. Put executable scripts there (owner root, not writable by others)\nand enter their names as hooks in the Restow UI.\n", layout.HooksDir())
		} else {
			fmt.Fprintf(w, "Scripts:      %s\n", strings.Join(names, ", "))
		}
	case hooks.ModeAny:
		fmt.Fprintln(w, "Any command configured in the Restow UI runs as root here. Whoever can change this endpoint's settings in Restow can run commands as root on this machine.")
	}
}
