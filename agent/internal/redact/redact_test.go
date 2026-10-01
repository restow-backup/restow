package redact

import (
	"bytes"
	"strings"
	"testing"
)

func TestRedactExactValues(t *testing.T) {
	r := &Redactor{}
	r.Add("s3cr3t-repository-password", "short")
	got := r.Redact("using password s3cr3t-repository-password now, short stays")
	if strings.Contains(got, "s3cr3t-repository-password") {
		t.Fatalf("secret leaked: %q", got)
	}
	if !strings.Contains(got, "short stays") {
		t.Fatalf("values below the minimum length must not be registered: %q", got)
	}
}

func TestRedactURLEncodedForm(t *testing.T) {
	r := &Redactor{}
	r.Add("pa ss/word+1234")
	got := r.Redact("https://u:pa%20ss%2Fword%2B1234@host/x and pa+ss%2Fword%2B1234")
	if strings.Contains(got, "word") {
		t.Fatalf("encoded secret leaked: %q", got)
	}
}

func TestRedactLongestFirst(t *testing.T) {
	r := &Redactor{}
	r.Add("abcdefgh", "abcdefghijkl")
	if got := r.Redact("x abcdefghijkl y"); got != "x "+Mask+" y" {
		t.Fatalf("got %q", got)
	}
}

func TestRedactPatterns(t *testing.T) {
	r := &Redactor{}
	cases := map[string]string{
		"enroll token rset_AbCdEfGhIjKlMnOp0123":            "enroll token " + Mask,
		"agent rsea_AbCdEfGhIjKlMnOp0123_-x used":           "agent " + Mask + " used",
		"Authorization: Basic dXNlcjpwYXNzd29yZC1sb25n":     "Authorization: Basic " + Mask,
		"Authorization: Bearer abc.def.ghi":                 "Authorization: Bearer " + Mask,
		"rest:https://ep123:hunter2hunter2@host/agent/":     "rest:https://ep123:" + Mask + "@host/agent/",
		"RESTIC_PASSWORD=hunter2 restic backup":             "RESTIC_PASSWORD=" + Mask + " restic backup",
		`{"password":"hunter2","user":"a"}`:                 `{"password":` + Mask + `,"user":"a"}`,
		"db_password: 'my pass' rest":                       "db_password: " + Mask + " rest",
		"AWS_SECRET_ACCESS_KEY=abcd1234 next":               "AWS_SECRET_ACCESS_KEY=" + Mask + " next",
		"nothing to see here, files: 12, token bucket full": "nothing to see here, files: 12, token bucket full",
	}
	for in, want := range cases {
		if got := r.Redact(in); got != want {
			t.Errorf("Redact(%q)\n got  %q\n want %q", in, got, want)
		}
	}
}

func TestWriterSplitSecret(t *testing.T) {
	r := &Redactor{}
	r.Add("topsecretvalue123")
	var out bytes.Buffer
	w := NewWriter(&out, r)
	_, _ = w.Write([]byte("line one topsecret"))
	_, _ = w.Write([]byte("value123 tail\nsecond\npartial"))
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	if strings.Contains(got, "topsecretvalue123") {
		t.Fatalf("split secret leaked: %q", got)
	}
	if !strings.Contains(got, "line one "+Mask+" tail\nsecond\npartial") {
		t.Fatalf("unexpected output: %q", got)
	}
}
