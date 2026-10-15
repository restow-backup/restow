package share

import (
	"reflect"
	"testing"
)

func TestMatcherFollowsResticSemantics(t *testing.T) {
	m := NewMatcher([]string{"*.tmp", "/share/Archive", "cache/**/x", "Thumbs.db", "  ", "price$list"}, false)
	cases := map[string]bool{
		"/share/a.tmp":             true,
		"/share/deep/er/b.tmp":     true,
		"/share/a.tmpx":            false,
		"/share/Archive":           true,
		"/share/Archive/2020/f":    true,
		"/share/x/Archive":         false,
		"/share/cache/a/b/x":       true,
		"/share/cache/x":           true,
		"/share/y/Thumbs.db":       true,
		"/share/thumbs.db":         false,
		"/share/price$list":        true,
		"/share/Finance/Q3.xlsx":   false,
		"/share/Finance/~$Q3.xlsx": false,
	}
	for p, want := range cases {
		if got := m.Match(p); got != want {
			t.Errorf("%s: got %v want %v", p, got, want)
		}
	}
	ci := NewMatcher(SystemFilesPreset, true)
	for _, p := range []string{"/share/THUMBS.DB", "/share/a/~$Q3.xlsx", "/share/$Recycle.Bin/x", "/share/x/@eaDir/y",
		"/share/System Volume Information", "/share/#recycle/a"} {
		if !ci.Match(p) {
			t.Errorf("%s should be excluded case-insensitively", p)
		}
	}
	if ci.Match("/share/Finance/Q3.xlsx") {
		t.Error("a normal file was excluded")
	}
	if !(*Matcher)(nil).Empty() || NewMatcher(nil, false).Match("/x") {
		t.Error("an empty matcher matches nothing")
	}
}

func TestExcludeLinesEscapesLiteralPaths(t *testing.T) {
	lines, dropped := ExcludeLines([]string{"*.tmp", "#recycle", "", "price$x", "bad\nline"},
		[]string{"/share/Tiered/report[1].pst", "/share/a*b?.doc", `/share/back\slash`})
	want := []string{"*.tmp", `\#recycle`, "price$$x", `/share/Tiered/report\[1].pst`, `/share/a\*b\?.doc`, `/share/back\\slash`}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("lines %q", lines)
	}
	if !reflect.DeepEqual(dropped, []string{"bad\nline"}) {
		t.Fatalf("dropped %q", dropped)
	}
	// The walk's matcher treats an escaped literal as that exact name.
	m := NewMatcher([]string{`/share/Tiered/report\[1].pst`}, false)
	if !m.Match("/share/Tiered/report[1].pst") || m.Match("/share/Tiered/report1.pst") {
		t.Fatal("escaped literal")
	}
}
