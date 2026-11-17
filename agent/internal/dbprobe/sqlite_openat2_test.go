package dbprobe

import (
	"go/build"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The number of openat2 differs on MIPS (4437 o32, 5437 n64): every Linux
// architecture Go builds, and every one the release builds (agent/build.sh),
// takes exactly one file with the constant, and the MIPS ones their own.
func TestOpenat2NumberForEveryLinuxArchitecture(t *testing.T) {
	files, err := filepath.Glob("sqlite_openat2_*.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("no constant files: %v", err)
	}
	var constants []string
	for _, f := range files {
		if !strings.HasSuffix(f, "_test.go") {
			constants = append(constants, f)
		}
	}
	want := map[string]string{
		"386": "437", "amd64": "437", "arm": "437", "arm64": "437", "loong64": "437",
		"ppc64": "437", "ppc64le": "437", "riscv64": "437", "s390x": "437",
		"mips": "4437", "mipsle": "4437", "mips64": "5437", "mips64le": "5437",
	}
	// The release targets: each Linux architecture must be one of the above.
	script, err := os.ReadFile(filepath.Join("..", "..", "build.sh"))
	if err != nil {
		t.Fatal(err)
	}
	targets := regexp.MustCompile(`(?m)^TARGETS="([^"]*)"`).FindSubmatch(script)
	if targets == nil {
		t.Fatal("build.sh names no TARGETS")
	}
	for _, target := range strings.Fields(string(targets[1])) {
		if arch, ok := strings.CutPrefix(target, "linux-"); ok {
			if _, known := want[arch]; !known {
				t.Errorf("release target %s has no expected openat2 number in this test", target)
			}
		}
	}
	number := regexp.MustCompile(`const sysOpenat2 = (\d+)`)
	for arch, expected := range want {
		ctx := build.Default
		ctx.GOOS, ctx.GOARCH, ctx.CgoEnabled = "linux", arch, false
		var got []string
		for _, f := range constants {
			ok, err := ctx.MatchFile(".", f)
			if err != nil {
				t.Fatal(err)
			}
			if ok {
				src, err := os.ReadFile(f)
				if err != nil {
					t.Fatal(err)
				}
				m := number.FindSubmatch(src)
				if m == nil {
					t.Fatalf("%s defines no sysOpenat2", f)
				}
				got = append(got, string(m[1]))
			}
		}
		if len(got) != 1 || got[0] != expected {
			t.Errorf("linux/%s: openat2 numbers %v, want exactly [%s]", arch, got, expected)
		}
	}
}
