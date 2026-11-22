package recovery

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/buildinfo"
	"github.com/restow-backup/restow/agent/internal/redact"
)

// Paths of a oneshot restore (docs/BAREMETAL-ONESHOT.md 6.2, 6.4).
const (
	OneshotExchangePath = "/agent/v1/recovery/oneshot"
	oneshotChecksPath   = CurrentPath + "/oneshot/checks"
	oneshotBootedPath   = CurrentPath + "/oneshot/booted"
	oneshotISOPath      = CurrentPath + "/iso"
)

// ExchangeOneshot redeems the proof of a oneshot code (OneshotCodeProof with
// the origin of BaseURL) with what the command measured. On success the
// session id is set; the session waits for its release.
func (s *Session) ExchangeOneshot(ctx context.Context, req api.RecoveryOneshotExchangeRequest) (*api.RecoveryExchangeResponse, error) {
	if s.Secret == "" {
		return nil, errors.New("the session has no secret")
	}
	if !isHex64(req.CodeProof) {
		return nil, errors.New("the code proof must be 64 lower-case hexadecimal characters")
	}
	sha := s.SecretSHA256()
	req.SessionSecretSHA256 = sha
	var out api.RecoveryExchangeResponse
	if err := s.do(ctx, http.MethodPost, OneshotExchangePath, req, &out, false); err != nil {
		return nil, err
	}
	switch {
	case out.SessionID == "" || strings.ContainsAny(out.SessionID, "/:?#%") || out.SessionID != strings.TrimSpace(out.SessionID):
		return nil, errors.New("the instance answered without a usable session id")
	case out.MatchCode != MatchCode(sha):
		return nil, fmt.Errorf("the instance answered with match code %s, but this session's is %s",
			FormatMatchCode(out.MatchCode), FormatMatchCode(MatchCode(sha)))
	case out.Oneshot == nil:
		return nil, errors.New("the instance answered no oneshot exchange (is it older than 0.5.1?)")
	}
	s.ID = out.SessionID
	return &out, nil
}

// OneshotChecks reports the checks after the test load (while the session
// waits for its release).
func (s *Session) OneshotChecks(ctx context.Context, c api.OneshotChecks) error {
	c.KexecError = isoField(c.KexecError, 500)
	return s.do(ctx, http.MethodPost, oneshotChecksPath, c, nil, true)
}

// OneshotBooted reports from the recovery environment after the switch.
func (s *Session) OneshotBooted(ctx context.Context, hw api.RecoveryHardware) error {
	return s.do(ctx, http.MethodPost, oneshotBootedPath, struct {
		Hardware api.RecoveryHardware `json:"hardware"`
	}{hw}, nil, true)
}

// OneshotISOFile names the files of the ISO route: the image, its signed
// checksums and their signature.
type OneshotISOFile string

const (
	OneshotISOImage     OneshotISOFile = ""
	OneshotISOSums      OneshotISOFile = "/sums"
	OneshotISOSignature OneshotISOFile = "/signature"
)

// FetchOneshotISO writes one file of the ISO route to w, at most max bytes.
// No redirect is followed (the session secret would go along), no retry
// (the image counts against three downloads per session).
func (s *Session) FetchOneshotISO(ctx context.Context, file OneshotISOFile, w io.Writer, max int64) (int64, error) {
	base, err := s.base()
	if err != nil {
		return 0, err
	}
	if s.ID == "" || s.Secret == "" {
		return 0, errors.New("no recovery session: exchange the code first")
	}
	s.registerSecret()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+oneshotISOPath+string(file), nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", buildinfo.UserAgent())
	req.Header.Set("Cache-Control", "no-store")
	req.SetBasicAuth(s.ID, s.Secret)
	resp, err := s.httpClient().Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return 0, &api.APIError{Method: http.MethodGet, Path: oneshotISOPath + string(file), Status: resp.StatusCode,
			Title: http.StatusText(resp.StatusCode), Detail: redact.Redact(strings.TrimSpace(string(data)))}
	}
	if resp.ContentLength > max {
		return 0, fmt.Errorf("%s: %d bytes announced, more than %d", oneshotISOPath+string(file), resp.ContentLength, max)
	}
	n, err := io.Copy(w, io.LimitReader(resp.Body, max+1))
	if err != nil {
		return n, err
	}
	if n > max {
		return n, fmt.Errorf("%s: more than %d bytes", oneshotISOPath+string(file), max)
	}
	return n, nil
}
