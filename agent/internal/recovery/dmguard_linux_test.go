//go:build linux

package recovery

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// TestLinuxOpsDMMappings reads name, UUID and slaves of every dm device
// from a fake sysfs; a device without dm/uuid has an empty UUID.
func TestLinuxOpsDMMappings(t *testing.T) {
	dir := t.TempDir()
	fsys := fakeSys{root: filepath.Join(dir, "sys")}
	fsys.dm("dm-0", "nvme0n1p3_crypt", "CRYPT-LUKS2-abc-nvme0n1p3_crypt", "dm-1")
	fsys.dm("dm-1", "vg0-root", "LVM-xyz")
	fsys.dm("dm-7", "old_crypt", "CRYPT-LUKS1-def-old_crypt")
	fsys.dev("dm-9", "253:9", false)
	_ = os.MkdirAll(filepath.Join(fsys.root, "class/block/dm-9/dm"), 0o755)
	_ = os.WriteFile(filepath.Join(fsys.root, "class/block/dm-9/dm/name"), []byte("raw\n"), 0o644)
	for dm, slaves := range map[string][]string{"dm-0": {"nvme0n1p3"}, "dm-1": {"dm-0"}, "dm-7": {"sdb2"}} {
		for _, s := range slaves {
			_ = os.MkdirAll(filepath.Join(fsys.root, "class/block", dm, "slaves", s), 0o755)
		}
	}
	fsys.dev("sdb", "8:16", false)
	o := &LinuxOps{SysRoot: fsys.root, DevRoot: filepath.Join(dir, "dev")}
	got := o.DMMappings()
	want := []DMMapping{
		{Node: "dm-0", Name: "nvme0n1p3_crypt", UUID: "CRYPT-LUKS2-abc-nvme0n1p3_crypt", Slaves: []string{"nvme0n1p3"}},
		{Node: "dm-1", Name: "vg0-root", UUID: "LVM-xyz", Slaves: []string{"dm-0"}},
		{Node: "dm-7", Name: "old_crypt", UUID: "CRYPT-LUKS1-def-old_crypt", Slaves: []string{"sdb2"}},
		{Node: "dm-9", Name: "raw"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("mappings\n got %+v\nwant %+v", got, want)
	}
	f := foreignKeyMappings(got, []string{"/dev/dm-0", "/dev/dm-1", "/dev/mapper/nvme0n1p3_crypt"}, nil)
	if len(f) != 2 || f[0].Node != "dm-7" || f[1].Node != "dm-9" {
		t.Errorf("foreign %+v", f)
	}
}

// shellEnv closes the foreign mapping when the operator's shell ends.
type shellEnv struct {
	*testEnv
	onShell func()
}

func (e *shellEnv) Shell(ctx context.Context) error { e.note("shell"); e.onShell(); return nil }

// TestRecoverAwaitForeignMappings: on the console recover names the
// mapping, offers a shell and checks again when it ends; "no" and an
// unattended run stop with foreign_mapping_open.
func TestRecoverAwaitForeignMappings(t *testing.T) {
	h := newHarness(t, "debian12-uefi-luks-lvm.same", "debian12-uefi-luks-lvm")
	h.ops.stack = goldenStack
	h.ops.setDM(oldCrypt)
	env := &shellEnv{testEnv: &testEnv{t: t}, onShell: func() { h.ops.setDM() }}
	ui, out := newTestUI("y\n")
	r := &Recover{UI: ui, Env: env, Log: &LogBuffer{}}
	if err := r.awaitForeignMappings(context.Background(), h.x); err != nil {
		t.Fatalf("after the shell: %v", err)
	}
	if strings.Join(env.actions, ",") != "shell" {
		t.Errorf("actions %v", env.actions)
	}
	if !strings.Contains(out.String(), "/dev/mapper/old_crypt (dm-7 on sdb2)") || !strings.Contains(out.String(), "cryptsetup close old_crypt") {
		t.Errorf("console:\n%s", out.String())
	}

	h.ops.setDM(oldCrypt)
	ui, _ = newTestUI("n\n")
	env = &shellEnv{testEnv: &testEnv{t: t}, onShell: func() {}}
	r = &Recover{UI: ui, Env: env, Log: &LogBuffer{}}
	err := r.awaitForeignMappings(context.Background(), h.x)
	if err == nil || !strings.Contains(err.Error(), "old_crypt") || len(env.actions) != 0 {
		t.Errorf("no: %v %v", err, env.actions)
	}

	ui, _ = newTestUI("")
	r = &Recover{UI: ui, Env: env, Log: &LogBuffer{}, Answers: &Answers{}}
	if err := r.awaitForeignMappings(context.Background(), h.x); err == nil {
		t.Error("unattended run went on")
	}
	if !strings.Contains(strings.Join(r.Log.All(), "\n"), "old_crypt") {
		t.Error("not logged")
	}
}
