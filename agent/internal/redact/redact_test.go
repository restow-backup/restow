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

func TestRedactRecoveryValues(t *testing.T) {
	r := &Redactor{}
	hex64 := "61568a617301ffbaa5adccc54fa56a88dbc8dd4159bbe9b1404d22bda549942c"
	cases := map[string]string{
		"code RC-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS typed":    "code " + Mask + " typed",
		"code rc-7k3qx-m9p2d-h4tnv-8wrbc-j6fas typed":    "code " + Mask + " typed",
		"code RC7K3QXM9P2DH4TNV8WRBCJ6FAS typed":         "code " + Mask + " typed",
		"sessionSecret=" + hex64 + " next":               "sessionSecret=" + Mask + " next",
		"session: " + hex64:                              "session: " + Mask,
		`{"codeProof":"` + hex64 + `","x":1}`:            `{"codeProof":"` + Mask + `","x":1}`,
		"secret " + hex64:                                "secret " + hex64, // no = or :, nothing to tell it apart
		"layoutSha256: " + hex64:                         "layoutSha256: " + hex64,
		"snapshot " + hex64 + " restored":                "snapshot " + hex64 + " restored",
		"reconnect token rset_AbCdEfGhIjKlMnOp0123 used": "reconnect token " + Mask + " used",
		// Text that only looks a bit like a code stays as it is.
		"release RC-12345 of the firmware":             "release RC-12345 of the firmware",
		"see RC-7K3QX-M9P2D notes":                     "see RC-7K3QX-M9P2D notes",
		"RC-7K3QX-M9P2D-H4TNV-8WRBC is four groups":    "RC-7K3QX-M9P2D-H4TNV-8WRBC is four groups",
		"ARC-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS is no code": "ARC-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS is no code",
	}
	for in, want := range cases {
		if got := r.Redact(in); got != want {
			t.Errorf("Redact(%q)\n got  %q\n want %q", in, got, want)
		}
	}
	// A JSON session secret is masked whatever pattern catches it first.
	if got := r.Redact(`{"sessionSecretSha256":"` + hex64 + `"}`); strings.Contains(got, hex64) {
		t.Errorf("session secret hash leaked: %q", got)
	}
}

func TestKeyBlocksAcrossLines(t *testing.T) {
	r := &Redactor{}
	body := "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ"
	var k KeyBlocks
	var got []string
	for _, batch := range [][]string{
		{"key:", "-----BEGIN OPENSSH PRIVATE KEY-----", body},
		{body, "-----END OPENSSH PRIVATE KEY----- ok", "after"},
	} {
		for _, l := range batch {
			got = append(got, k.Line(r, l))
		}
	}
	want := []string{"key:", Mask, Mask, Mask, Mask + " ok", "after"}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("got %q, want %q", got, want)
	}
	if k.Open() {
		t.Fatal("the block was closed")
	}
	if got := k.Line(r, "a -----BEGIN RSA PRIVATE KEY-----x-----END RSA PRIVATE KEY----- b"); got != "a "+Mask+" b" {
		t.Fatalf("a block on one line: %q", got)
	}
	if got := r.Redact("x\n-----BEGIN PRIVATE KEY-----\n" + body + "\n-----END PRIVATE KEY-----\ny"); strings.Contains(got, body) {
		t.Fatalf("a block in one text leaked: %q", got)
	}
}
