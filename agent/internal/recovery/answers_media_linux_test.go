//go:build linux

package recovery

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeSysBlock builds /sys/class/block and /sys/block for the disks
// (kernel name -> removable, on USB) and their partitions.
func fakeSysBlock(t *testing.T, disks map[string][2]bool, parts map[string]string) string {
	t.Helper()
	sys := t.TempDir()
	devs := filepath.Join(sys, "devices")
	for _, d := range []string{"class/block", "block"} {
		if err := os.MkdirAll(filepath.Join(sys, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for k, v := range disks {
		bus := "pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/block"
		if v[1] {
			bus = "pci0000:00/0000:00:14.0/usb1/1-1/1-1:1.0/host6/target6:0:0/6:0:0:0/block"
		}
		dir := filepath.Join(devs, bus, k)
		if err := os.MkdirAll(filepath.Join(dir, "device"), 0o755); err != nil {
			t.Fatal(err)
		}
		rm := "0"
		if v[0] {
			rm = "1"
		}
		_ = os.WriteFile(filepath.Join(dir, "removable"), []byte(rm+"\n"), 0o644)
		_ = os.WriteFile(filepath.Join(dir, "device/model"), []byte("Model "+k+"\n"), 0o644)
		_ = os.Symlink(dir, filepath.Join(sys, "block", k))
		_ = os.Symlink(dir, filepath.Join(sys, "class/block", k))
	}
	for p, d := range parts {
		disk, _ := filepath.EvalSymlinks(filepath.Join(sys, "block", d))
		dir := filepath.Join(disk, p)
		_ = os.MkdirAll(dir, 0o755)
		_ = os.WriteFile(filepath.Join(dir, "partition"), []byte("1\n"), 0o644)
		_ = os.Symlink(dir, filepath.Join(sys, "class/block", p))
	}
	return sys
}

// TestFindAnswersMedium: the answers are read only from exactly one
// device labelled RESTOWANS on a removable or USB disk that is not the
// ISO's; a RESTOWANS file system on a disk of the machine (one the backup
// created) is never taken for the operator's medium.
func TestFindAnswersMedium(t *testing.T) {
	sys := fakeSysBlock(t, map[string][2]bool{"sda": {false, false}, "sdb": {true, false}, "sdc": {false, true}, "sdd": {true, true}},
		map[string]string{"sda1": "sda", "sda2": "sda", "sdb1": "sdb", "sdc1": "sdc", "sdd1": "sdd", "sdd2": "sdd"})
	for _, c := range []struct {
		name, blkid, live, disk, err string
	}{
		{"stick", "/dev/sdb1\n", "", "sdb", ""},
		{"usb disk", "/dev/sdc1\n", "", "sdc", ""},
		{"whole stick", "/dev/sdb\n", "", "sdb", ""},
		{"target and stick", "/dev/sda2\n/dev/sdb1\n", "", "", "2 devices are labelled RESTOWANS"},
		{"target only", "/dev/sda2\n", "", "", "neither removable nor on USB"},
		{"none", "", "", "", "no medium labelled RESTOWANS"},
		{"iso stick", "/dev/sdd2\n", "sdd", "", "the disk the ISO started from"},
		{"dm", "/dev/mapper/evil\n", "", "", "not a partition or disk"},
		{"md", "/dev/md127\n", "", "", "not a partition or disk"},
		{"loop", "/dev/loop0\n", "", "", "not a partition or disk"},
	} {
		x := newFakeExec()
		x.output = func(argv []string) (string, bool) {
			if argv[0] == "blkid" {
				return c.blkid, true
			}
			return "", false
		}
		m, err := findAnswersMedium(context.Background(), x, sys, c.live)
		if c.err != "" {
			if err == nil || !strings.Contains(err.Error(), c.err) {
				t.Errorf("%s: %+v %v, want %q", c.name, m, err, c.err)
			}
			continue
		}
		if err != nil || m.Disk != c.disk || m.Model != "Model "+c.disk {
			t.Errorf("%s: %+v %v", c.name, m, err)
		}
		if got := x.lines(); !strings.Contains(got, "blkid -c /dev/null -t LABEL=RESTOWANS -o device") {
			t.Errorf("%s: %s", c.name, got)
		}
	}
}

// TestBuildTargetAnswersMedium: the disk the answers came from is never a
// target, nor one of the others.
func TestBuildTargetAnswersMedium(t *testing.T) {
	in := HardwareInput{Blocks: []BlockInfo{
		{KName: "sda", SizeBytes: 1 << 40, Logical: 512, Physical: 512, Serial: "TARGET"},
		{KName: "sdb", SizeBytes: 16 << 30, Logical: 512, Physical: 512, Serial: "STICK", Removable: true, Transport: "usb"},
	}, AnswersMedium: "sdb"}
	tg, notes := BuildTarget(in)
	if len(tg.Disks) != 1 || tg.Disks[0].Path != "/dev/sda" || len(tg.Others) != 0 {
		t.Errorf("disks %+v others %+v", tg.Disks, tg.Others)
	}
	if len(notes) != 1 || notes[0].Reason != NoteAnswersMedium {
		t.Errorf("notes %+v", notes)
	}
}

// TestRecoverMediaNeedsMedium: answers from a medium without a known disk
// are refused before anything is asked or sent.
func TestRecoverMediaNeedsMedium(t *testing.T) {
	a, err := LoadAnswers(SourceMedia, []byte(`{"format":"restow-answers-v1","instanceUrl":"https://restow.example","diskMapping":"auto","confirmErase":[]}`), false)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	r := &Recover{UI: &UI{In: strings.NewReader(""), Out: &out, Lang: LangEN}, Env: &testEnv{t: t}, Answers: a, Version: "0.5.0", Log: &LogBuffer{}}
	if _, err := r.run(context.Background()); err == nil || !strings.Contains(err.Error(), "answers medium") {
		t.Fatalf("run: %v\n%s", err, out.String())
	}
}
