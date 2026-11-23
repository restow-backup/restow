package recovery

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/restow-backup/restow/agent/internal/api"
)

func oneshotServer(t *testing.T, handler http.HandlerFunc) *Session {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	s, err := NewSession(srv.URL, true, srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	s.MaxAttempts = 1
	return s
}

func TestExchangeOneshotChecksTheAnswer(t *testing.T) {
	proof := strings.Repeat("a", 64)
	for name, tc := range map[string]struct {
		answer func(sha string) api.RecoveryExchangeResponse
		want   string
	}{
		"ok": {func(sha string) api.RecoveryExchangeResponse {
			return api.RecoveryExchangeResponse{SessionID: "rs_1", MatchCode: MatchCode(sha), Oneshot: &api.OneshotExchangeExtras{}}
		}, ""},
		"no oneshot part": {func(sha string) api.RecoveryExchangeResponse {
			return api.RecoveryExchangeResponse{SessionID: "rs_1", MatchCode: MatchCode(sha)}
		}, "older than 0.5.1"},
		"other match code": {func(string) api.RecoveryExchangeResponse {
			return api.RecoveryExchangeResponse{SessionID: "rs_1", MatchCode: "000000", Oneshot: &api.OneshotExchangeExtras{}}
		}, "match code"},
		"session id with a path": {func(sha string) api.RecoveryExchangeResponse {
			return api.RecoveryExchangeResponse{SessionID: "../x", MatchCode: MatchCode(sha), Oneshot: &api.OneshotExchangeExtras{}}
		}, "session id"},
	} {
		t.Run(name, func(t *testing.T) {
			var s *Session
			s = oneshotServer(t, func(w http.ResponseWriter, r *http.Request) {
				var req api.RecoveryOneshotExchangeRequest
				_ = json.NewDecoder(r.Body).Decode(&req)
				if r.URL.Path != OneshotExchangePath || req.CodeProof != proof || req.SessionSecretSHA256 != s.SecretSHA256() || r.Header.Get("Authorization") != "" {
					t.Errorf("request %s %+v", r.URL.Path, req)
				}
				w.WriteHeader(http.StatusAccepted)
				_ = json.NewEncoder(w).Encode(tc.answer(req.SessionSecretSHA256))
			})
			_, err := s.ExchangeOneshot(context.Background(), api.RecoveryOneshotExchangeRequest{RecoveryExchangeRequest: api.RecoveryExchangeRequest{CodeProof: proof}})
			if tc.want == "" {
				if err != nil || s.ID != "rs_1" {
					t.Fatalf("%v, id %q", err, s.ID)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) || s.ID != "" {
				t.Fatalf("err %v, id %q", err, s.ID)
			}
		})
	}
	s := oneshotServer(t, func(http.ResponseWriter, *http.Request) { t.Error("a malformed proof was sent") })
	if _, err := s.ExchangeOneshot(context.Background(), api.RecoveryOneshotExchangeRequest{RecoveryExchangeRequest: api.RecoveryExchangeRequest{CodeProof: "RC-1"}}); err == nil {
		t.Error("a malformed proof was accepted")
	}
}

func TestFetchOneshotISO(t *testing.T) {
	var s *Session
	s = oneshotServer(t, func(w http.ResponseWriter, r *http.Request) {
		id, secret, ok := r.BasicAuth()
		if !ok || id != "rs_1" || secret != s.Secret {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case CurrentPath + "/iso/sums":
			_, _ = io.WriteString(w, "list")
		case CurrentPath + "/iso":
			_, _ = w.Write(bytes.Repeat([]byte("i"), 100))
		case CurrentPath + "/iso/signature":
			// A redirect is not followed: the Basic credentials would go along.
			http.Redirect(w, r, "https://elsewhere.example/sig", http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	})
	var buf bytes.Buffer
	if _, err := s.FetchOneshotISO(context.Background(), OneshotISOSums, &buf, 10); err == nil {
		t.Fatal("fetched without a session")
	}
	s.ID = "rs_1"
	if n, err := s.FetchOneshotISO(context.Background(), OneshotISOSums, &buf, 10); err != nil || n != 4 || buf.String() != "list" {
		t.Fatalf("%d %v %q", n, err, buf.String())
	}
	buf.Reset()
	if _, err := s.FetchOneshotISO(context.Background(), OneshotISOImage, &buf, 99); err == nil || !strings.Contains(err.Error(), "more than 99") {
		t.Errorf("an image larger than announced: %v", err)
	}
	if _, err := s.FetchOneshotISO(context.Background(), OneshotISOImage, io.Discard, 100); err != nil {
		t.Errorf("image: %v", err)
	}
	if _, err := s.FetchOneshotISO(context.Background(), OneshotISOSignature, io.Discard, 100); err == nil || !strings.Contains(err.Error(), "302") {
		t.Errorf("redirect: %v", err)
	}
}
