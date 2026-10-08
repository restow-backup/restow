package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestProviderProtocolErrors(t *testing.T) {
	t.Setenv("RESTOW_PVE_ROOT", t.TempDir())
	var out, errOut bytes.Buffer
	// Not enrolled: a JSON error and exit code 1, never plain text on stdout.
	code := run([]string{"provider", "backup-init"}, strings.NewReader(`{"storeid":"restow","vmid":101}`), &out, &errOut)
	var resp struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if code != 1 || json.Unmarshal(out.Bytes(), &resp) != nil || resp.OK || !strings.Contains(resp.Error, "not enrolled") {
		t.Fatalf("code %d, out %q", code, out.String())
	}
	out.Reset()
	// Cache-only verbs work without enrollment and never block.
	if code := run([]string{"provider", "storage-status"}, strings.NewReader(`{}`), &out, &errOut); code != 0 || !strings.Contains(out.String(), `"ok":true`) {
		t.Fatalf("storage-status: %d %q", code, out.String())
	}
	out.Reset()
	if code := run([]string{"provider", "backup-init"}, strings.NewReader(`{nope`), &out, &errOut); code != 1 || !strings.Contains(out.String(), "invalid request") {
		t.Fatalf("bad JSON: %d %q", code, out.String())
	}
	if code := run([]string{"bogus"}, nil, &out, &errOut); code != 2 {
		t.Fatal("unknown command")
	}
}
