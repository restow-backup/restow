package sysinfo

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func write(t *testing.T, root, name, content string) {
	t.Helper()
	p := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mkdir(t *testing.T, root, name string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, name), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestDataFoldersReportsFoldersWithFiles(t *testing.T) {
	root := t.TempDir()
	write(t, root, "opt/paperless/paperless.conf", "x")
	// Docker's skeleton: empty dirs and its volume database count as nothing.
	mkdir(t, root, "opt/containerd/bin")
	write(t, root, "var/lib/docker/volumes/metadata.db", "x")
	mkdir(t, root, "var/lib/docker/volumes/empty/_data")
	// A Debian /usr/local: empty folders only.
	mkdir(t, root, "usr/local/bin")
	mkdir(t, root, "usr/local/lib/python3.11/dist-packages")
	write(t, root, "var/lib/postgresql/15/main/PG_VERSION", "15")
	mkdir(t, root, "srv")

	got := DataFolders(root)
	want := []string{"/opt", "/var/lib/postgresql"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("DataFolders = %v, want %v", got, want)
	}

	write(t, root, "var/lib/docker/volumes/db/_data/base/1", "x")
	if got := DataFolders(root); !reflect.DeepEqual(got, []string{"/opt", "/var/lib/docker/volumes", "/var/lib/postgresql"}) {
		t.Fatalf("with a volume: %v", got)
	}
}

func TestDataFoldersEmptyMachine(t *testing.T) {
	got := DataFolders(t.TempDir())
	if got == nil || len(got) != 0 {
		t.Fatalf("want an empty, non-nil list, got %#v", got)
	}
}

func TestDataFoldersDoesNotFollowLinks(t *testing.T) {
	root := t.TempDir()
	write(t, root, "elsewhere/file", "x")
	mkdir(t, root, "srv")
	if err := os.Symlink(filepath.Join(root, "elsewhere"), filepath.Join(root, "srv", "link")); err != nil {
		t.Skip("no symlinks:", err)
	}
	if got := DataFolders(root); len(got) != 0 {
		t.Fatalf("a link inside a candidate counted: %v", got)
	}
}

func TestDetectVirtualization(t *testing.T) {
	cases := []struct {
		name       string
		files      map[string]string
		kind, tech string
	}{
		{"bare metal", map[string]string{"sys/class/dmi/id/sys_vendor": "Dell Inc.", "proc/cpuinfo": "flags\t: fpu vme sse\n"}, VirtNone, ""},
		{"lxc via systemd", map[string]string{"run/systemd/container": "lxc\n", "sys/class/dmi/id/sys_vendor": "QEMU"}, VirtContainer, "lxc"},
		{"lxc via pid 1", map[string]string{"proc/1/environ": "PATH=/bin\x00container=lxc\x00"}, VirtContainer, "lxc"},
		{"docker", map[string]string{".dockerenv": ""}, VirtContainer, "docker"},
		{"proxmox vm", map[string]string{"sys/class/dmi/id/sys_vendor": "QEMU", "sys/class/dmi/id/product_name": "Standard PC (i440FX + PIIX, 1996)"}, VirtVM, "qemu"},
		{"hyper-v", map[string]string{"sys/class/dmi/id/sys_vendor": "Microsoft Corporation", "sys/class/dmi/id/product_name": "Virtual Machine"}, VirtVM, "microsoft"},
		{"vmware", map[string]string{"sys/class/dmi/id/sys_vendor": "VMware, Inc."}, VirtVM, "vmware"},
		{"cpu flag only", map[string]string{"proc/cpuinfo": "processor\t: 0\nflags\t\t: fpu hypervisor sse\n"}, VirtVM, "vm-other"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			root := t.TempDir()
			for name, content := range c.files {
				write(t, root, name, content)
			}
			kind, tech := detectVirtualization(root)
			if kind != c.kind || tech != c.tech {
				t.Fatalf("got %s/%s, want %s/%s", kind, tech, c.kind, c.tech)
			}
		})
	}
}

func TestDesktopAndMachine(t *testing.T) {
	root := t.TempDir()
	write(t, root, "run/systemd/container", "lxc")
	write(t, root, "opt/app/data", "x")
	m := detectMachine(root)
	want := Machine{Virtualization: VirtContainer, Technology: "lxc", DataFolders: []string{"/opt"}}
	if !reflect.DeepEqual(m, want) {
		t.Fatalf("machine = %#v", m)
	}
	write(t, root, "usr/share/wayland-sessions/gnome.desktop", "[Desktop Entry]")
	if !hasDesktop(root) {
		t.Fatal("desktop not found")
	}
}

func TestSanitizeTech(t *testing.T) {
	if got := sanitizeTech(" LXC\n"); got != "lxc" {
		t.Fatalf("%q", got)
	}
	if got := sanitizeTech("systemd-nspawn; rm -rf /"); got != "systemd-nspawnrm-rf" {
		t.Fatalf("%q", got)
	}
}
