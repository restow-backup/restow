//go:build unix

package svc

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/paths"
)

type recorder struct {
	calls   []string
	respond func(call string) (string, error)
}

func (r *recorder) run(name string, args ...string) (string, error) {
	call := name + " " + strings.Join(args, " ")
	r.calls = append(r.calls, call)
	if r.respond != nil {
		return r.respond(call)
	}
	return "", nil
}

func TestValidateExePath(t *testing.T) {
	if err := validateSystemdExe("/opt/restow-agent/bin/restow-agent"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"restow-agent", "/opt/my agent/x", "/opt/a\"b", "/opt/a%h", "/opt/a$b", "/opt/x\ny", "/opt/a;b"} {
		if err := validateSystemdExe(bad); err == nil {
			t.Errorf("%q must be rejected", bad)
		}
	}
	// macOS installs below /Library/Application Support: a space is fine in a plist.
	if err := validateLaunchdExe("/Library/Application Support/Restow/bin/restow-agent"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"relative", "/a\nb", "/a\x00b"} {
		if err := validateLaunchdExe(bad); err == nil {
			t.Errorf("%q must be rejected", bad)
		}
	}
}

func TestSystemdUnitContent(t *testing.T) {
	unit := renderSystemdUnit("/opt/restow-agent/bin/restow-agent")
	for _, want := range []string{
		"ExecStart=/opt/restow-agent/bin/restow-agent run", "Restart=always", "KillMode=mixed", "Nice=10",
		"After=network-online.target", "WantedBy=multi-user.target", "StartLimitBurst=10",
		// Hardening that backups of arbitrary paths and restores anywhere still allow.
		"NoNewPrivileges=yes", "ProtectKernelTunables=yes", "ProtectKernelLogs=yes", "ProtectControlGroups=yes",
		"RestrictNamespaces=yes", "LockPersonality=yes", "UMask=0077", "CapabilityBoundingSet=~CAP_SYS_MODULE",
		"SystemCallFilter=~@module", "SystemCallErrorNumber=EPERM", "RestrictRealtime=yes", "SystemCallArchitectures=native",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("unit lacks %q:\n%s", want, unit)
		}
	}
	// These would make backups incomplete or restores impossible.
	for _, never := range []string{"ProtectSystem", "ProtectHome", "PrivateTmp", "ReadOnlyPaths", "ProtectKernelModules", "PrivateDevices", "ProtectClock", "DeviceAllow"} {
		if strings.Contains(unit, never) {
			t.Errorf("unit must not set %s", never)
		}
	}
	if strings.Contains(unit, "{{") {
		t.Fatal("unresolved placeholder")
	}
}

func TestSystemdRefreshAndProgram(t *testing.T) {
	dir := t.TempDir()
	rec := &recorder{}
	s := &systemd{run: rec.run, unitPath: filepath.Join(dir, "restow-agent.service")}
	// No unit: a manual run, nothing to refresh.
	if changed, err := s.Refresh("/opt/restow-agent/bin/restow-agent"); changed || err != nil || len(rec.calls) != 0 {
		t.Fatalf("no unit: %v %v %v", changed, err, rec.calls)
	}
	// A 0.1.0 unit pointing below /usr/local is rewritten and systemd reloaded.
	_ = os.WriteFile(s.unitPath, []byte("[Service]\nExecStart=/usr/local/bin/restow-agent run\n"), 0o644)
	if p, err := s.Program(); err != nil || p != "/usr/local/bin/restow-agent" {
		t.Fatalf("program: %q %v", p, err)
	}
	changed, err := s.Refresh("/opt/restow-agent/bin/restow-agent")
	if !changed || err != nil || strings.Join(rec.calls, "|") != "systemctl daemon-reload" {
		t.Fatalf("refresh: %v %v %v", changed, err, rec.calls)
	}
	if p, _ := s.Program(); p != "/opt/restow-agent/bin/restow-agent" {
		t.Fatalf("program after refresh: %q", p)
	}
	// Unchanged: no write, no reload.
	rec.calls = nil
	if changed, err := s.Refresh("/opt/restow-agent/bin/restow-agent"); changed || err != nil || len(rec.calls) != 0 {
		t.Fatalf("second refresh: %v %v %v", changed, err, rec.calls)
	}
	if exitNow, err := s.ReloadFromInside(); !exitNow || err != nil {
		t.Fatal("systemd restarts the new ExecStart when the agent exits")
	}
}

func TestSystemdInstallSequence(t *testing.T) {
	dir := t.TempDir()
	rec := &recorder{}
	s := &systemd{run: rec.run, unitPath: filepath.Join(dir, "restow-agent.service")}
	if err := s.Install("/opt/restow-agent/bin/restow-agent"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(s.unitPath)
	if err != nil || !strings.Contains(string(b), "ExecStart=/opt/restow-agent/bin/restow-agent run") {
		t.Fatalf("unit file: %v %s", err, b)
	}
	want := []string{"systemctl daemon-reload", "systemctl enable restow-agent.service"}
	if strings.Join(rec.calls, "|") != strings.Join(want, "|") {
		t.Fatalf("calls: %v", rec.calls)
	}
	// Installing again overwrites (repair) without error.
	if err := s.Install("/opt/restow-agent/bin/restow-agent"); err != nil {
		t.Fatalf("re-install: %v", err)
	}
	if err := s.Install("relative/path"); err == nil {
		t.Fatal("relative exe path must be rejected")
	}
}

func TestSystemdStatus(t *testing.T) {
	dir := t.TempDir()
	unit := filepath.Join(dir, "restow-agent.service")
	rec := &recorder{}
	s := &systemd{run: rec.run, unitPath: unit}
	if got := s.Status(); got.State != NotInstalled {
		t.Fatalf("no unit file: %+v", got)
	}
	_ = os.WriteFile(unit, []byte("x"), 0o644)
	rec.respond = func(string) (string, error) { return "ActiveState=active\nSubState=running\nMainPID=4242\n", nil }
	if got := s.Status(); got.State != Running || got.PID != 4242 {
		t.Fatalf("running: %+v", got)
	}
	rec.respond = func(string) (string, error) { return "ActiveState=inactive\nSubState=dead\nMainPID=0\n", nil }
	if got := s.Status(); got.State != Stopped {
		t.Fatalf("stopped: %+v", got)
	}
	rec.respond = func(string) (string, error) { return "", errors.New("boom") }
	if got := s.Status(); got.State != Unknown {
		t.Fatalf("unknown: %+v", got)
	}
}

func TestSystemdUninstallSequences(t *testing.T) {
	dir := t.TempDir()
	unit := filepath.Join(dir, "restow-agent.service")
	_ = os.WriteFile(unit, []byte("x"), 0o644)
	rec := &recorder{}
	s := &systemd{run: rec.run, unitPath: unit}
	if err := s.Uninstall(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(unit); err == nil {
		t.Fatal("unit file must be removed")
	}
	if rec.calls[0] != "systemctl stop restow-agent.service" {
		t.Fatalf("stop must come first: %v", rec.calls)
	}

	// From inside the service the stop must be the very last step and non-blocking.
	_ = os.WriteFile(unit, []byte("x"), 0o644)
	rec = &recorder{}
	s = &systemd{run: rec.run, unitPath: unit}
	if err := s.UninstallFromInside(); err != nil {
		t.Fatal(err)
	}
	last := rec.calls[len(rec.calls)-1]
	if last != "systemctl stop --no-block restow-agent.service" {
		t.Fatalf("calls: %v", rec.calls)
	}
	for _, c := range rec.calls[:len(rec.calls)-1] {
		if strings.Contains(c, " stop") {
			t.Fatalf("the service must not be stopped before the uninstall is done: %v", rec.calls)
		}
	}
}

func TestLaunchdPlistContent(t *testing.T) {
	exe := "/Library/Application Support/Restow/bin/restow-agent"
	p := renderLaunchdPlist(exe)
	for _, want := range []string{
		"<string>com.restowbackup.agent</string>", "<string>" + exe + "</string>", "<string>run</string>",
		"<key>KeepAlive</key>\n\t<true/>", "<key>RunAtLoad</key>\n\t<true/>", "<key>Nice</key>",
		"<key>Umask</key>\n\t<integer>63</integer>",
	} {
		if !strings.Contains(p, want) {
			t.Errorf("plist lacks %q", want)
		}
	}
	if strings.Contains(p, "{{") {
		t.Fatal("unresolved placeholder")
	}
	// Markup in a path is escaped, never interpreted.
	if q := renderLaunchdPlist("/opt/a&b<c>"); !strings.Contains(q, "<string>/opt/a&amp;b&lt;c&gt;</string>") {
		t.Fatalf("not escaped:\n%s", q)
	}
}

func TestLaunchdRefreshProgramAndReloadFromInside(t *testing.T) {
	dir := t.TempDir()
	plist := filepath.Join(dir, "com.restowbackup.agent.plist")
	reload := filepath.Join(dir, "com.restowbackup.agent.reload.plist")
	rec := &recorder{}
	l := &launchd{run: rec.run, plistPath: plist, reloadPath: reload}
	if changed, err := l.Refresh("/x"); changed || err != nil {
		t.Fatal("no plist: nothing to refresh")
	}
	_ = os.WriteFile(plist, []byte(renderLaunchdPlist("/usr/local/bin/restow-agent")), 0o644)
	if p, err := l.Program(); err != nil || p != "/usr/local/bin/restow-agent" {
		t.Fatalf("program: %q %v", p, err)
	}
	exe := "/Library/Application Support/Restow/bin/restow-agent"
	if changed, err := l.Refresh(exe); !changed || err != nil {
		t.Fatalf("refresh: %v %v", changed, err)
	}
	if p, _ := l.Program(); p != exe {
		t.Fatalf("program after refresh: %q", p)
	}
	// Refresh never unloads the running job (that would end this process).
	for _, c := range rec.calls {
		if strings.Contains(c, "bootout system/com.restowbackup.agent") && !strings.Contains(c, ".reload") {
			t.Fatalf("refresh unloaded the agent: %v", rec.calls)
		}
	}
	rec.calls = nil
	exitNow, err := l.ReloadFromInside()
	if err != nil || exitNow {
		t.Fatalf("reload: %v %v", exitNow, err)
	}
	if last := rec.calls[len(rec.calls)-1]; last != "launchctl bootstrap system "+reload {
		t.Fatalf("the reload runs as its own job: %v", rec.calls)
	}
	b, _ := os.ReadFile(reload)
	for _, want := range []string{"<string>com.restowbackup.agent.reload</string>", "bootout system/com.restowbackup.agent;", "bootstrap system /Library/LaunchDaemons/com.restowbackup.agent.plist", "<key>LaunchOnlyOnce</key>"} {
		if !strings.Contains(string(b), want) {
			t.Errorf("reload job lacks %q", want)
		}
	}
	l.CleanupReload()
	if _, err := os.Stat(reload); err == nil {
		t.Fatal("reload job not removed")
	}
}

func TestParseLaunchdPrint(t *testing.T) {
	running := "system/com.restowbackup.agent = {\n\tactive count = 1\n\tpath = /Library/LaunchDaemons/com.restowbackup.agent.plist\n\tstate = running\n\n\tprogram = /usr/local/bin/restow-agent\n\tpid = 812\n}\n"
	if got := parseLaunchdPrint(running); got.State != Running || got.PID != 812 {
		t.Fatalf("running: %+v", got)
	}
	waiting := "system/com.restowbackup.agent = {\n\tstate = waiting\n}\n"
	if got := parseLaunchdPrint(waiting); got.State != Stopped {
		t.Fatalf("waiting: %+v", got)
	}
	if got := parseLaunchdPrint("nothing useful"); got.State != Unknown {
		t.Fatalf("garbage: %+v", got)
	}
}

func TestLaunchdSequences(t *testing.T) {
	dir := t.TempDir()
	plist := filepath.Join(dir, "com.restowbackup.agent.plist")
	_ = os.WriteFile(plist, []byte("x"), 0o644)
	loaded := false
	rec := &recorder{}
	rec.respond = func(call string) (string, error) {
		if strings.HasPrefix(call, "launchctl print") {
			if loaded {
				return "state = running\npid = 5\n", nil
			}
			return "Could not find service", errors.New("exit status 113")
		}
		if strings.HasPrefix(call, "launchctl bootstrap") {
			loaded = true
		}
		if strings.HasPrefix(call, "launchctl bootout") {
			loaded = false
		}
		return "", nil
	}
	l := &launchd{run: rec.run, plistPath: plist}
	if got := l.Status(); got.State != Stopped {
		t.Fatalf("not loaded: %+v", got)
	}
	if err := l.Start(); err != nil {
		t.Fatal(err)
	}
	if !loaded {
		t.Fatalf("start must bootstrap the daemon: %v", rec.calls)
	}
	if got := l.Status(); got.State != Running || got.PID != 5 {
		t.Fatalf("loaded: %+v", got)
	}
	if err := l.Restart(); err != nil || !loaded {
		t.Fatalf("restart: %v %v", err, rec.calls)
	}
	if err := l.Stop(); err != nil || loaded {
		t.Fatalf("stop: %v %v", err, rec.calls)
	}
	// From inside: bootout is the last call and the plist is gone before it.
	loaded = true
	rec.calls = nil
	if err := l.UninstallFromInside(); err != nil {
		t.Fatal(err)
	}
	if last := rec.calls[len(rec.calls)-1]; last != "launchctl bootout system/com.restowbackup.agent" {
		t.Fatalf("calls: %v", rec.calls)
	}
	if _, err := os.Stat(plist); err == nil {
		t.Fatal("plist not removed")
	}
	if got := l.Status(); got.State != NotInstalled {
		t.Fatalf("after uninstall: %+v", got)
	}
}

type fakeManager struct{ calls []string }

func (f *fakeManager) Name() string         { return "fake" }
func (f *fakeManager) Install(string) error { f.calls = append(f.calls, "install"); return nil }
func (f *fakeManager) Start() error         { f.calls = append(f.calls, "start"); return nil }
func (f *fakeManager) Stop() error          { f.calls = append(f.calls, "stop"); return nil }
func (f *fakeManager) Restart() error       { f.calls = append(f.calls, "restart"); return nil }
func (f *fakeManager) Status() Info         { return Info{State: Running} }
func (f *fakeManager) Uninstall() error     { f.calls = append(f.calls, "uninstall"); return nil }
func (f *fakeManager) UninstallFromInside() error {
	f.calls = append(f.calls, "uninstall-inside")
	return nil
}
func (f *fakeManager) Refresh(string) (bool, error)    { return false, nil }
func (f *fakeManager) ReloadFromInside() (bool, error) { return true, nil }
func (f *fakeManager) Program() (string, error)        { return "", nil }

func TestUninstallRemovesEverythingInOrder(t *testing.T) {
	root := t.TempDir()
	layout := paths.Layout{StateDir: filepath.Join(root, "etc", "restow-agent"), DataDir: filepath.Join(root, "var", "restow-agent"),
		LogDir: filepath.Join(root, "log", "restow-agent")}
	for _, d := range []string{layout.StateDir, layout.DataDir, layout.LogDir, filepath.Join(layout.DataDir, "cache", "locked")} {
		_ = os.MkdirAll(d, 0o755)
	}
	_ = os.WriteFile(filepath.Join(layout.StateDir, "state.json"), []byte("secret"), 0o600)
	_ = os.Chmod(filepath.Join(layout.DataDir, "cache", "locked"), 0o500)
	bin := filepath.Join(root, "bin", "restow-agent")
	restic := filepath.Join(root, "bin", "restic")
	legacyRestic := filepath.Join(root, "lib", "restow-agent", "restic")
	for _, f := range []string{bin, bin + ".prev", restic, legacyRestic} {
		_ = os.MkdirAll(filepath.Dir(f), 0o755)
		_ = os.WriteFile(f, []byte("x"), 0o755)
	}
	foreign := filepath.Join(root, "lib", "someone-else")
	_ = os.MkdirAll(foreign, 0o755)
	_ = os.WriteFile(filepath.Join(foreign, "keep"), []byte("x"), 0o644)
	files := []string{bin + ".prev", restic, legacyRestic, bin}
	dirs := []string{filepath.Dir(bin), filepath.Dir(legacyRestic), foreign}
	fm := &fakeManager{}
	var out strings.Builder
	err := Uninstall(UninstallOptions{Layout: layout, Files: files, Dirs: dirs, Out: &out, Manager: fm})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(foreign, "keep")); err != nil {
		t.Fatal("a folder that is not empty must stay")
	}
	for _, p := range []string{layout.StateDir, layout.DataDir, layout.LogDir, bin, bin + ".prev", restic, filepath.Dir(bin), legacyRestic, filepath.Dir(legacyRestic)} {
		if _, err := os.Lstat(p); err == nil {
			t.Errorf("%s still exists", p)
		}
	}
	if strings.Join(fm.calls, ",") != "stop,uninstall" {
		t.Fatalf("manager calls: %v", fm.calls)
	}
	// Second run is a no-op, not an error.
	fm.calls = nil
	if err := Uninstall(UninstallOptions{Layout: layout, Files: files, Dirs: dirs, Out: &out, Manager: fm}); err != nil {
		t.Fatalf("idempotent uninstall: %v", err)
	}
}

func TestUninstallFromServiceOrderAndKeepLogs(t *testing.T) {
	root := t.TempDir()
	layout := paths.Layout{StateDir: filepath.Join(root, "s"), DataDir: filepath.Join(root, "d"), LogDir: filepath.Join(root, "l")}
	for _, d := range []string{layout.StateDir, layout.DataDir, layout.LogDir} {
		_ = os.MkdirAll(d, 0o755)
	}
	fm := &fakeManager{}
	err := Uninstall(UninstallOptions{Layout: layout, Files: []string{filepath.Join(root, "a"), filepath.Join(root, "r")}, Dirs: []string{},
		FromService: true, KeepLogs: true, Manager: fm})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(fm.calls, ",") != "uninstall-inside" {
		t.Fatalf("the service must not be stopped first: %v", fm.calls)
	}
	if _, err := os.Stat(layout.LogDir); err != nil {
		t.Fatal("logs must be kept with KeepLogs")
	}
	if _, err := os.Stat(layout.StateDir); err == nil {
		t.Fatal("state must be removed")
	}
}

func TestDefaultUninstallCoversBothLayouts(t *testing.T) {
	files := strings.Join(DefaultFiles(), "|")
	for _, want := range []string{paths.InstalledAgentBinary(), paths.InstalledResticBinary(), paths.InstalledNotices(), paths.LegacyResticBinary, paths.LegacyAgentBinary + ".prev"} {
		if !strings.Contains(files, want) {
			t.Errorf("uninstall does not remove %s", want)
		}
	}
	if last := DefaultFiles()[len(DefaultFiles())-1]; last != paths.InstalledAgentBinary() {
		t.Fatalf("the agent binary must be removed last: %s", last)
	}
	if strings.Join(DefaultDirs(), "|") != paths.BinDir()+"|"+paths.InstallDir()+"|"+paths.LegacyLibDir {
		t.Fatalf("dirs: %v", DefaultDirs())
	}
}

func TestSafeToRemove(t *testing.T) {
	for _, bad := range []string{"", "relative", "/", "/etc", "/var/lib", "/usr/local", "/Users", "/root", "/opt", "/Library/Application Support"} {
		if safeToRemove(bad) == nil {
			t.Errorf("%q must be protected", bad)
		}
	}
	for _, ok := range []string{"/etc/restow-agent", "/var/lib/restow-agent", "/var/log/restow-agent", "/tmp/x/y"} {
		if err := safeToRemove(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	// A misconfigured layout does not delete system directories.
	err := Uninstall(UninstallOptions{Layout: paths.Layout{StateDir: "/etc", DataDir: "/var/lib", LogDir: "/var/log"},
		Files: []string{"/nonexistent/a"}, Dirs: []string{"/opt", "/usr/local/lib"}, Manager: &fakeManager{}})
	if err == nil {
		t.Fatal("removing protected directories must fail")
	}
}
