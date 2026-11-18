package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/restow-backup/restow/agent/internal/oneshot/payload"
)

// cmdOneshotPayload is hidden: it builds the kernel, the initrd and the
// command line a oneshot restore loads with kexec, from a recovery ISO and a
// session data file, into files (the CI test "start without medium",
// docs/BAREMETAL-ONESHOT.md 19.2). The real command builds the same in
// memory (restow-agent oneshot).
func cmdOneshotPayload(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("oneshot-payload", flag.ContinueOnError)
	fs.SetOutput(stderr)
	isoPath := fs.String("iso", "", "the recovery ISO (already checked against the signed checksums)")
	dataPath := fs.String("data", "", "the session data (JSON)")
	kernelOut := fs.String("kernel-out", "", "where the kernel goes")
	initrdOut := fs.String("initrd-out", "", "where the initrd goes")
	consoles := fs.String("consoles", "", "console= values of the kernel, comma-separated groups with ';' (ttyS0,115200n8;tty1)")
	keymap := fs.String("keymap", "us", "keyboard layout")
	if err := fs.Parse(args); err != nil || fs.NArg() > 0 || *isoPath == "" || *dataPath == "" || *kernelOut == "" || *initrdOut == "" {
		fmt.Fprintln(stderr, "usage: restow-agent oneshot-payload --iso <iso> --data <json> --kernel-out <file> --initrd-out <file> [--consoles 'ttyS0,115200n8;tty1'] [--keymap us]")
		return exitUsage
	}
	if err := buildPayload(*isoPath, *dataPath, *kernelOut, *initrdOut, *consoles, *keymap, stdout); err != nil {
		fmt.Fprintln(stderr, "oneshot-payload:", err)
		return exitError
	}
	return exitOK
}

func buildPayload(isoPath, dataPath, kernelOut, initrdOut, consoles, keymap string, stdout io.Writer) error {
	data, err := os.ReadFile(dataPath)
	if err != nil {
		return err
	}
	if !json.Valid(data) {
		return fmt.Errorf("%s is not JSON", dataPath)
	}
	var cs []string
	if consoles != "" {
		cs = strings.Split(consoles, ";")
	}
	cmdline, err := payload.Cmdline(cs, keymap)
	if err != nil {
		return err
	}
	f, err := os.Open(isoPath)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	iso, err := payload.OpenISO(f, st.Size())
	if err != nil {
		return err
	}
	lf, err := iso.LiveFiles()
	if err != nil {
		return err
	}
	if err := writeFrom(kernelOut, func(w io.Writer) error { _, err := io.Copy(w, lf.Kernel); return err }); err != nil {
		return err
	}
	if err := writeFrom(initrdOut, func(w io.Writer) error {
		_, err := payload.Assemble(w, lf.Initrd, lf.Squashfs, lf.Squashfs.Size(), data)
		return err
	}); err != nil {
		return err
	}
	fmt.Fprintln(stdout, cmdline)
	return nil
}

func writeFrom(p string, fill func(io.Writer) error) error {
	f, err := os.OpenFile(p, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if err := fill(f); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
