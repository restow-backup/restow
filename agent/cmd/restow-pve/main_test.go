package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/pve"
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

func TestCheckPVETokenNamesTheToken(t *testing.T) {
	var perms string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "PVEAPIToken=restow@pve!pve1=secret" {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/api2/json/version":
			_, _ = w.Write([]byte(`{"data":{"version":"9.2.1"}}`))
		case "/api2/json/access/permissions":
			_, _ = w.Write([]byte(`{"data":` + perms + `}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	api, err := pve.NewPVEAPI(srv.URL, "restow@pve!pve1", "secret", "", "")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// Every privilege on "/", one of them without propagation (flag 0): fine.
	perms = `{"/":{"VM.Audit":1,"VM.Backup":1,"Datastore.Audit":1,"Datastore.AllocateSpace":0,"Sys.Audit":1}}`
	if v, err := checkPVEToken(ctx, api, "restow@pve!pve1"); err != nil || v != "9.2.1" {
		t.Fatalf("all privileges: %q %v", v, err)
	}

	// Missing privileges: the error names the token and what it lacks.
	perms = `{"/":{"VM.Audit":1}}`
	_, err = checkPVEToken(ctx, api, "restow@pve!pve1")
	if err == nil || !strings.Contains(err.Error(), "restow@pve!pve1 lacks VM.Backup, Datastore.Audit, Datastore.AllocateSpace, Sys.Audit on /") {
		t.Fatalf("missing privileges: %v", err)
	}

	// A token PVE does not accept: named as well.
	wrong, _ := pve.NewPVEAPI(srv.URL, "root@pam!restow", "nope", "", "")
	_, err = checkPVEToken(ctx, wrong, "root@pam!restow")
	if err == nil || !strings.Contains(err.Error(), "does not accept the API token root@pam!restow") {
		t.Fatalf("rejected token: %v", err)
	}
}
