package recovery

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// The countdown before an unattended erase (10.20), Ctrl+C before the
// execution, and the identities that confirm a disk.

// TestUIAnyKey: one byte without a line end is a key press; the wait ends
// with the context when nothing is typed; what was typed during the wait
// is no input of the next dialog.
func TestUIAnyKey(t *testing.T) {
	pr, pw := io.Pipe()
	defer pw.Close()
	var out syncWriter
	ui := &UI{In: pr, Out: &out, Lang: LangEN}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	start := time.Now()
	if ui.AnyKey(ctx) {
		t.Error("a key press without input")
	}
	cancel()
	if time.Since(start) < 100*time.Millisecond {
		t.Error("the wait ended early")
	}
	go func() {
		time.Sleep(50 * time.Millisecond)
		_, _ = pw.Write([]byte(" "))
	}()
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	start = time.Now()
	pressed := ui.AnyKey(ctx)
	cancel()
	if !pressed || time.Since(start) > 10*time.Second {
		t.Fatalf("one key without Enter: pressed %v after %s", pressed, time.Since(start))
	}
	go func() { _, _ = pw.Write([]byte("yes\n")) }()
	if l, err := ui.ReadLine(); err != nil || l != "yes" {
		t.Errorf("the line after the wait: %q %v", l, err)
	}
	// A line a dialog took before the wait began does not end the wait.
	go func() { _, _ = pw.Write([]byte("typed ahead\n")) }()
	if l, _ := ui.ReadLine(); l != "typed ahead" {
		t.Fatalf("line %q", l)
	}
	ctx, cancel = context.WithTimeout(context.Background(), 100*time.Millisecond)
	if ui.AnyKey(ctx) {
		t.Error("an earlier line counted as a key press")
	}
	cancel()
	// A line typed ahead that no dialog took (Enter pressed twice at the
	// last prompt): the reader holds it. The wait must not sit behind it
	// while keys go unread; it ends the wait like a key.
	wrote := make(chan struct{})
	go func() { _, _ = pw.Write([]byte("\n")); close(wrote) }()
	<-wrote
	time.Sleep(50 * time.Millisecond)
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	start = time.Now()
	pressed = ui.AnyKey(ctx)
	cancel()
	if !pressed || time.Since(start) > 10*time.Second {
		t.Errorf("a line typed ahead: pressed %v after %s", pressed, time.Since(start))
	}
	// And a key behind it is read.
	go func() { _, _ = pw.Write([]byte("x")) }()
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	if !ui.AnyKey(ctx) {
		t.Error("a key after a line typed ahead")
	}
	cancel()
}

// TestUIAbort: Abort ends the dialog that waits and every later one.
func TestUIAbort(t *testing.T) {
	pr, pw := io.Pipe()
	defer pw.Close()
	var out syncWriter
	ui := &UI{In: pr, Out: &out, Lang: LangEN}
	done := make(chan error, 1)
	go func() { _, err := ui.Input("Address", ""); done <- err }()
	time.Sleep(50 * time.Millisecond)
	ui.Abort()
	select {
	case err := <-done:
		if !errors.Is(err, ErrAborted) {
			t.Errorf("err %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the dialog did not end")
	}
	if _, err := ui.YesNo("Go on?", true); !errors.Is(err, ErrAborted) {
		t.Errorf("a dialog after the abort: %v", err)
	}
	if _, err := ui.ConfirmErase(); !errors.Is(err, ErrAborted) {
		t.Errorf("the erase word after the abort: %v", err)
	}
	ui.Abort()
}

type syncWriter struct {
	syncBuf strings.Builder
	mu      chan struct{}
}

func (w *syncWriter) lock() func() {
	if w.mu == nil {
		w.mu = make(chan struct{}, 1)
	}
	w.mu <- struct{}{}
	return func() { <-w.mu }
}

func (w *syncWriter) Write(p []byte) (int, error) {
	defer w.lock()()
	return w.syncBuf.Write(p)
}

func (w *syncWriter) String() string {
	defer w.lock()()
	return w.syncBuf.String()
}

func mediaRecover(in io.Reader, out io.Writer, confirm []string, countdown time.Duration) *Recover {
	return &Recover{UI: &UI{In: in, Out: out, Lang: LangEN}, Log: &LogBuffer{}, Countdown: countdown,
		Answers: &Answers{Source: SourceMedia, ConfirmErase: confirm, Medium: &AnswersMedium{Device: "/dev/sdz1", Disk: "sdz"}}}
}

// TestConfirmCountdown: from a medium the disks are shown for the
// countdown; only the full time without a key and without Ctrl+C erases.
func TestConfirmCountdown(t *testing.T) {
	target, _ := BuildTarget(twoDisks())
	plan := planMapping(baremetal.ActionErase, "t0", "identity")
	const id = "wwn.5000000000000001"

	// Nothing typed: the erase goes on after the countdown.
	pr, pw := io.Pipe()
	defer pw.Close()
	var out syncWriter
	r := mediaRecover(pr, &out, []string{id}, 200*time.Millisecond)
	start := time.Now()
	ok, err := r.confirm(context.Background(), plan, target, nil)
	if err != nil || !ok || time.Since(start) < 150*time.Millisecond {
		t.Fatalf("no key: ok %v err %v after %s", ok, err, time.Since(start))
	}
	if !strings.Contains(out.String(), "/dev/sda") || !strings.Contains(out.String(), id) {
		t.Errorf("the disks are not shown:\n%s", out.String())
	}

	// One key, no Enter.
	pr, pw2 := io.Pipe()
	defer pw2.Close()
	out = syncWriter{}
	r = mediaRecover(pr, &out, []string{id}, time.Minute)
	go func() {
		time.Sleep(100 * time.Millisecond)
		_, _ = pw2.Write([]byte{0x1b})
	}()
	start = time.Now()
	ok, err = r.confirm(context.Background(), plan, target, nil)
	if err != nil || ok || time.Since(start) > 20*time.Second {
		t.Fatalf("a key: ok %v err %v after %s", ok, err, time.Since(start))
	}

	// Ctrl+C: the countdown ends at once, nothing is confirmed, and the
	// console says so once.
	pr, pw3 := io.Pipe()
	defer pw3.Close()
	out = syncWriter{}
	r = mediaRecover(pr, &out, []string{id}, time.Minute)
	go func() {
		time.Sleep(100 * time.Millisecond)
		r.Interrupt()
		r.Interrupt()
	}()
	start = time.Now()
	ok, err = r.confirm(context.Background(), plan, target, nil)
	if err != nil || ok || time.Since(start) > 20*time.Second {
		t.Fatalf("Ctrl+C: ok %v err %v after %s", ok, err, time.Since(start))
	}
	time.Sleep(50 * time.Millisecond)
	if n := strings.Count(out.String(), T(LangEN, "ui.aborted")); n != 1 || !r.wasAborted() {
		t.Errorf("Ctrl+C: %d abort lines, aborted %v\n%s", n, r.wasAborted(), out.String())
	}

	// Ctrl+C before the countdown began: it does not start.
	pr, pw4 := io.Pipe()
	defer pw4.Close()
	out = syncWriter{}
	r = mediaRecover(pr, &out, []string{id}, time.Minute)
	r.Interrupt()
	start = time.Now()
	if ok, _ = r.confirm(context.Background(), plan, target, nil); ok || time.Since(start) > 20*time.Second {
		t.Errorf("Ctrl+C before the countdown: ok %v after %s", ok, time.Since(start))
	}

	// The run ends (its context) during the countdown: not confirmed.
	pr, pw5 := io.Pipe()
	defer pw5.Close()
	r = mediaRecover(pr, &syncWriter{}, []string{id}, time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if ok, _ = r.confirm(ctx, plan, target, nil); ok {
		t.Error("the countdown confirmed although the run was cancelled")
	}
}

// TestConfirmIdentityNamesOneDisk: confirmErase and the typed characters
// confirm a disk only through an identity that names it alone.
func TestConfirmIdentityNamesOneDisk(t *testing.T) {
	hw := HardwareInput{Blocks: []BlockInfo{
		{KName: "sda", SizeBytes: 1 << 40, Logical: 512, Physical: 512, Serial: "0123456789ABCDEF", ByPath: "pci-0000:00:14.0-usb-0:1:1.0-scsi-0:0:0:0"},
		{KName: "sdb", SizeBytes: 1 << 40, Logical: 512, Physical: 512, Serial: "0123456789ABCDEF", ByPath: "pci-0000:00:14.0-usb-0:2:1.0-scsi-0:0:0:0"},
		{KName: "sdc", SizeBytes: 1 << 40, Logical: 512, Physical: 512, Signatures: []baremetal.TargetSignature{{Kind: "fs", UUID: "11111111-2222-4333-8444-555555555555"}}},
	}}
	target, _ := BuildTarget(hw)
	shared := SharedIdentities(hw)
	const serial, pathB = "serial.0123456789ABCDEF", "path.pci-0000:00:14.0-usb-0:2:1.0-scsi-0:0:0:0"
	fwcfg := func(confirm ...string) (*Recover, *syncWriter) {
		out := &syncWriter{}
		return &Recover{UI: &UI{In: strings.NewReader(""), Out: out, Lang: LangEN}, Log: &LogBuffer{},
			Answers: &Answers{Source: SourceFWCfg, ConfirmErase: confirm}}, out
	}
	eraseB := planMapping(baremetal.ActionErase, "t1", "choice")
	// The serial both disks report confirms neither.
	r, out := fwcfg(serial)
	if ok, _ := r.confirm(context.Background(), eraseB, target, shared); ok {
		t.Fatal("confirmErase with an identity two disks report was accepted")
	}
	if !strings.Contains(out.String(), "/dev/sda is path.") || !strings.Contains(out.String(), "/dev/sdb is "+pathB) {
		t.Errorf("the refusal does not name the disks and their own identities:\n%s", out.String())
	}
	// The identity of the disk alone does.
	r, _ = fwcfg(pathB)
	if ok, _ := r.confirm(context.Background(), eraseB, target, shared); !ok {
		t.Error("confirmErase with the identity of the one disk was refused")
	}
	// Listed twice, or one more than is erased: no.
	for _, list := range [][]string{{pathB, pathB}, {pathB, "serial.OTHER"}, {}} {
		r, _ = fwcfg(list...)
		if ok, _ := r.confirm(context.Background(), eraseB, target, shared); ok {
			t.Errorf("confirmErase %v was accepted", list)
		}
	}
	// A disk without an identity is never confirmed: not by the answers,
	// and not at the console when it carries data.
	eraseC := planMapping(baremetal.ActionErase, "t2", "choice")
	if deref(target.Disks[2].Identity) != "" {
		t.Fatalf("fixture: %+v", target.Disks[2])
	}
	r, out = fwcfg()
	if ok, _ := r.confirm(context.Background(), eraseC, target, shared); ok || !strings.Contains(out.String(), "/dev/sdc") {
		t.Errorf("answers confirmed a disk without an identity:\n%s", out.String())
	}
	out = &syncWriter{}
	r = &Recover{UI: &UI{In: strings.NewReader("\n\n\nERASE\n"), Out: out, Lang: LangEN}, Log: &LogBuffer{}}
	if ok, _ := r.confirm(context.Background(), eraseC, target, shared); ok || strings.Contains(out.String(), T(LangEN, "ui.confirm_erase", "word", "ERASE")) {
		t.Errorf("the console confirmed a disk with data and without an identity:\n%s", out.String())
	}
	// The mapping of the answers: the shared serial is refused, the path
	// names the disk, an identity nobody has maps to missing.
	m := &baremetal.Manifest{Linux: &baremetal.LinuxLayout{}}
	r, _ = fwcfg()
	r.Answers.DiskMapping = DiskMapping{Map: map[string]string{"d0": serial}}
	if _, _, err := r.choices(m, target, shared); err == nil || !strings.Contains(err.Error(), "2 devices report the identity "+serial) {
		t.Errorf("diskMapping with the shared serial: %v", err)
	}
	r.Answers.DiskMapping = DiskMapping{Map: map[string]string{"d0": pathB, "d1": "serial.NOBODY"}}
	c, _, err := r.choices(m, target, shared)
	if err != nil || c.DiskMapping["d0"] != "t1" || c.DiskMapping["d1"] != "missing" {
		t.Errorf("diskMapping by path: %v %v", c.DiskMapping, err)
	}
	// Without the check of the scan a duplicate in the target is still no
	// match (a target from elsewhere).
	dup := *target
	dup.Disks = append([]baremetal.TargetDisk(nil), target.Disks...)
	dup.Disks[0].Identity = strPtrT(pathB)
	r.Answers.DiskMapping = DiskMapping{Map: map[string]string{"d0": pathB}}
	if _, _, err := r.choices(m, &dup, nil); err == nil {
		t.Error("an identity two target disks carry was mapped")
	}
	r, _ = fwcfg(pathB)
	if ok, _ := r.confirm(context.Background(), eraseB, &dup, nil); ok {
		t.Error("an identity two target disks carry was confirmed")
	}
}

// TestChooseSnapshotFromAnswers: a snapshot named in the answers is that
// snapshot or the run fails; never the snapshot of the code instead.
func TestChooseSnapshotFromAnswers(t *testing.T) {
	const a, b, code = "aaaaaaaa11111111", "aaaaaaaa22222222", "cccccccc33333333"
	creds := &api.RecoveryCredentials{SnapshotID: code, LayoutSHA256: "sha-code", Snapshots: []api.RecoverySnapshot{
		{ID: a, LayoutSHA256: "sha-a"}, {ID: b, LayoutSHA256: "sha-b"}, {ID: code, LayoutSHA256: "sha-code"}}}
	choose := func(id string) (string, string, error, string) {
		out := &syncWriter{}
		r := &Recover{UI: &UI{In: strings.NewReader(""), Out: out, Lang: LangEN}, Log: &LogBuffer{}, Answers: &Answers{Source: SourceFWCfg, SnapshotID: id}}
		gid, sha, err := r.chooseSnapshot(creds)
		return gid, sha, err, out.String()
	}
	if id, sha, err, _ := choose("aaaaaaaa1"); err != nil || id != a || sha != "sha-a" {
		t.Errorf("one match: %s %s %v", id, sha, err)
	}
	if id, sha, err, _ := choose(""); err != nil || id != code || sha != "sha-code" {
		t.Errorf("no snapshot in the answers: %s %s %v", id, sha, err)
	}
	for _, want := range []string{"deadbeef", "aaaaaaaa"} {
		id, sha, err, out := choose(want)
		if err == nil || id != "" || sha != "" {
			t.Errorf("snapshotId %s: %q %q %v", want, id, sha, err)
		}
		if !strings.Contains(out, want) {
			t.Errorf("snapshotId %s: the console does not say why:\n%s", want, out)
		}
	}
	// The snapshot of the code when the list does not carry it.
	only := &api.RecoveryCredentials{SnapshotID: code, LayoutSHA256: "sha-code"}
	r := &Recover{UI: &UI{In: strings.NewReader(""), Out: &syncWriter{}, Lang: LangEN}, Log: &LogBuffer{}, Answers: &Answers{SnapshotID: "cccccccc"}}
	if id, sha, err := r.chooseSnapshot(only); err != nil || id != code || sha != "sha-code" {
		t.Errorf("the snapshot of the code: %s %s %v", id, sha, err)
	}
	// At the console the end of the input chooses nothing.
	r = &Recover{UI: &UI{In: strings.NewReader(""), Out: &syncWriter{}, Lang: LangEN}, Log: &LogBuffer{}}
	if id, _, err := r.chooseSnapshot(creds); !errors.Is(err, ErrAborted) || id != "" {
		t.Errorf("the dialog ended: %q %v", id, err)
	}
}
