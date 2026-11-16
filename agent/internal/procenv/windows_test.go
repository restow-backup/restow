package procenv

import (
	"slices"
	"testing"
)

func TestFilterWindows(t *testing.T) {
	in := []string{"Path=C:\\Windows\\system32;C:\\Tools", "SystemRoot=C:\\Windows", "TEMP=C:\\Windows\\TEMP",
		"AWS_SECRET_ACCESS_KEY=x", "HTTPS_PROXY=http://proxy:3128", "https_proxy=http://p2", "ProgramFiles(x86)=C:\\PF86",
		"=C:=C:\\Windows", "PSModulePath=x", "HOME=C:\\x", "RESTOW_TOKEN=secret"}
	got := filter(in, true)
	want := []string{"Path=C:\\Windows\\system32;C:\\Tools", "SystemRoot=C:\\Windows", "TEMP=C:\\Windows\\TEMP",
		"HTTPS_PROXY=http://proxy:3128", "https_proxy=http://p2", "ProgramFiles(x86)=C:\\PF86", "PSModulePath=x"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}

func TestFilterWindowsDefaultPath(t *testing.T) {
	got := filter([]string{"SystemRoot=D:\\Win"}, true)
	if v, ok := get(got, "PATH", true); !ok || v != `D:\Win\System32;D:\Win;D:\Win\System32\Wbem;D:\Win\System32\WindowsPowerShell\v1.0` {
		t.Fatalf("%q", got)
	}
	got = filter(nil, true)
	if v, _ := get(got, "Path", true); v == "" || v[:10] != `C:\Windows` {
		t.Fatalf("%q", got)
	}
}

func TestSetGetCaseOnWindows(t *testing.T) {
	env := []string{"Path=a", "Tmp=x"}
	env = set(env, "TMP", "y", true)
	env = set(env, "TEMP", "z", true)
	if !slices.Equal(env, []string{"Path=a", "TMP=y", "TEMP=z"}) {
		t.Fatalf("%q", env)
	}
	if v, ok := get(env, "path", true); !ok || v != "a" {
		t.Fatal(v)
	}
	// Unix stays case-sensitive.
	if _, ok := get(env, "path", false); ok {
		t.Fatal("unix lookup must be case-sensitive")
	}
}
