package restic

import (
	"context"
	"reflect"
	"testing"
)

func TestParseDiffChange(t *testing.T) {
	c, ok := ParseDiffChange([]byte(`{"message_type":"change","path":"/srv/a.txt","modifier":"M"}`))
	if !ok || c != (DiffChange{Path: "/srv/a.txt", Modifier: "M"}) {
		t.Fatalf("%+v %v", c, ok)
	}
	for _, line := range []string{
		`{"message_type":"statistics","changed_files":1}`,
		`{"message_type":"change","path":"","modifier":"+"}`,
		`not json`,
	} {
		if _, ok := ParseDiffChange([]byte(line)); ok {
			t.Fatalf("parsed %s", line)
		}
	}
	if got := DiffArgs("a", "b"); !reflect.DeepEqual(got, []string{"diff", "--json", "--no-lock", "a", "b"}) {
		t.Fatalf("args %v", got)
	}
	if err := (&Runner{}).Diff(context.Background(), "", "b", func(DiffChange) {}); err == nil {
		t.Fatal("a diff needs two snapshots")
	}
}
