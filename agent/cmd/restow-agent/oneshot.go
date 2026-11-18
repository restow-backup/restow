//go:build linux

package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/oneshot"
)

// cmdOneshot is restow-agent oneshot: the bare metal restore onto a fresh
// machine without an ISO (docs/BAREMETAL-ONESHOT.md 8). The command
// oneshot.sh of the instance starts it with the code on stdin.
func cmdOneshot(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("oneshot", flag.ContinueOnError)
	fs.SetOutput(stderr)
	instance := fs.String("instance", "", "the address of the Restow instance (https://...)")
	codeStdin := fs.Bool("code-stdin", false, "read the one-time code (OS-...) from the first line of standard input")
	answers := fs.String("answers", "", "answers for an unattended run (restow-oneshot-answers-v1: confirmErase, passphrase)")
	lang := fs.String("lang", "", "language of the console: de or en (default from LANG)")
	keymap := fs.String("keymap", "", "keyboard layout of the recovery environment (us, de, ch, at, fr; default us)")
	direct := fs.Bool("direct", false, "in the provider's rescue system: restore from here instead of switching with kexec")
	resticBin := fs.String("restic", "", "the checked restic (with --direct; oneshot.sh downloads it)")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "Usage: echo <code> | restow-agent oneshot --instance <url> --code-stdin [--answers <file>] [--lang de|en] [--keymap us]")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if fs.NArg() > 0 {
		fs.Usage()
		return exitUsage
	}
	return oneshot.Main(oneshot.MainOptions{Instance: *instance, CodeStdin: *codeStdin, AnswersFile: *answers,
		Lang: *lang, Direct: *direct, ResticBin: *resticBin, Keymap: *keymap, Version: buildinfo.Version,
		Stdin: os.Stdin, Stdout: stdout, Stderr: stderr})
}
