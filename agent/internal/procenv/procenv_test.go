package procenv

import "testing"

func TestFilterDropsUnknownAndKeepsAllowed(t *testing.T) {
	in := []string{"PATH=/bin", "AWS_SECRET_ACCESS_KEY=x", "RESTOW_TOKEN=rset_x", "HTTPS_PROXY=http://p:3128", "RESTIC_PASSWORD=p", "HOME=/root"}
	out := Filter(in)
	got := map[string]bool{}
	for _, kv := range out {
		got[kv] = true
	}
	for _, want := range []string{"PATH=/bin", "HTTPS_PROXY=http://p:3128", "HOME=/root"} {
		if !got[want] {
			t.Errorf("missing %s in %v", want, out)
		}
	}
	for _, bad := range []string{"AWS_SECRET_ACCESS_KEY=x", "RESTOW_TOKEN=rset_x", "RESTIC_PASSWORD=p"} {
		if got[bad] {
			t.Errorf("%s must not be inherited", bad)
		}
	}
}

func TestFilterAddsDefaultPath(t *testing.T) {
	out := Filter([]string{"HOME=/root"})
	if v, ok := Get(out, "PATH"); !ok || v == "" {
		t.Fatalf("PATH not set: %v", out)
	}
}

func TestSet(t *testing.T) {
	env := []string{"A=1", "B=2"}
	env = Set(env, "A", "9")
	env = Set(env, "C", "3")
	if v, _ := Get(env, "A"); v != "9" {
		t.Fatal(env)
	}
	if v, _ := Get(env, "C"); v != "3" || len(env) != 3 {
		t.Fatal(env)
	}
}
