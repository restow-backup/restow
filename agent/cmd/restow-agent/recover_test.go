//go:build linux

package main

import (
	"bytes"
	"sort"
	"strings"
	"testing"
)

func TestRecoverListTools(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"recover", "--list-tools"}, &out, &errOut); code != exitOK {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) < 30 || !sort.StringsAreSorted(lines) {
		t.Fatalf("list: %v", lines)
	}
	for _, want := range []string{"cryptsetup cryptsetup-bin", "sfdisk fdisk", "ckbcomp console-setup", "mokutil mokutil"} {
		if !strings.Contains(out.String(), want+"\n") {
			t.Errorf("missing %q", want)
		}
	}
	if code := run([]string{"recover", "extra"}, &out, &errOut); code != exitUsage {
		t.Errorf("extra argument: exit %d", code)
	}
	if code := run([]string{"chroot-exec", "--spec", "4"}, &out, &errOut); code != 2 {
		t.Errorf("chroot-exec with a bad fd: exit %d", code)
	}
}
