package recovery

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// TrustMode is how recover trusts the certificate of the instance (10.3).
type TrustMode string

// Trust modes.
const (
	// TrustSystem uses the system certificates of the ISO.
	TrustSystem TrustMode = "system"
	// TrustCAFile uses the instance's own CA (a PEM file or pasted).
	TrustCAFile TrustMode = "cafile"
	// TrustPinned trusts exactly the leaf certificate whose SPKI the
	// operator confirmed by typing the whole check value (R3).
	TrustPinned TrustMode = "pinned"
)

// TLSProbe is what one TLS handshake with the instance showed, before
// anything is sent.
type TLSProbe struct {
	Leaf *x509.Certificate
	// CertSHA256 and SPKISHA256 are lower-case hex.
	CertSHA256 string
	SPKISHA256 string
	// Check is the check value of the SPKI (XXXX-XXXX-XXXX-XXXX).
	Check string
	// SystemErr is the result of verifying the chain against the system
	// certificates (nil: trusted).
	SystemErr error
}

// TLS error classes (ClassifyTLSError).
const (
	TLSErrNone             = ""
	TLSErrExpired          = "expired"
	TLSErrNotYetValid      = "not_yet_valid"
	TLSErrUnknownAuthority = "unknown_authority"
	TLSErrHostname         = "hostname"
	TLSErrOther            = "other"
)

// ClassifyTLSError tells what kind of certificate problem err is; now is
// compared with the leaf's validity to tell "expired" from "not yet valid"
// (x509 reports both as Expired).
func ClassifyTLSError(err error, leaf *x509.Certificate, now time.Time) string {
	if err == nil {
		return TLSErrNone
	}
	var inv x509.CertificateInvalidError
	var ua x509.UnknownAuthorityError
	var hn x509.HostnameError
	var tv *tls.CertificateVerificationError
	if errors.As(err, &tv) && tv.Err != nil {
		err = tv.Err
	}
	switch {
	case errors.As(err, &inv) && inv.Reason == x509.Expired:
		c := leaf
		if c == nil {
			c = inv.Cert
		}
		if c != nil && now.Before(c.NotBefore) {
			return TLSErrNotYetValid
		}
		return TLSErrExpired
	case errors.As(err, &ua):
		return TLSErrUnknownAuthority
	case errors.As(err, &hn):
		return TLSErrHostname
	}
	return TLSErrOther
}

// SPKISHA256 is the hex SHA-256 of a certificate's SubjectPublicKeyInfo.
func SPKISHA256(c *x509.Certificate) string {
	sum := sha256.Sum256(c.RawSubjectPublicKeyInfo)
	return hex.EncodeToString(sum[:])
}

// CheckSPKI reports whether the operator typed the whole check value of
// the leaf's SPKI (a prefix is refused, SPKICheckMatches).
func CheckSPKI(leaf *x509.Certificate, typed string) bool {
	if leaf == nil {
		return false
	}
	check, err := SPKICheck(SPKISHA256(leaf))
	return err == nil && SPKICheckMatches(typed, check)
}

// ProbeTLS makes one TLS handshake with the instance (through the proxy
// when one is set) without verifying, sends nothing and closes the
// connection; the certificate is then shown and checked.
func ProbeTLS(ctx context.Context, origin, proxy string, roots *x509.CertPool) (*TLSProbe, error) {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, fmt.Errorf("probe: %q is not an https origin", origin)
	}
	host := u.Hostname()
	addr := u.Host
	if u.Port() == "" {
		addr = net.JoinHostPort(host, "443")
	}
	raw, err := dialThrough(ctx, addr, proxy)
	if err != nil {
		return nil, err
	}
	defer raw.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = raw.SetDeadline(dl)
	} else {
		_ = raw.SetDeadline(time.Now().Add(30 * time.Second))
	}
	tc := tls.Client(raw, &tls.Config{ServerName: host, InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}) // #nosec G402 -- only to show and pin the certificate; nothing is sent
	if err := tc.HandshakeContext(ctx); err != nil {
		return nil, fmt.Errorf("TLS handshake with %s: %w", addr, err)
	}
	state := tc.ConnectionState()
	if len(state.PeerCertificates) == 0 {
		return nil, errors.New("the instance sent no certificate")
	}
	leaf := state.PeerCertificates[0]
	sum := sha256.Sum256(leaf.Raw)
	p := &TLSProbe{Leaf: leaf, CertSHA256: hex.EncodeToString(sum[:]), SPKISHA256: SPKISHA256(leaf)}
	p.Check, _ = SPKICheck(p.SPKISHA256)
	inter := x509.NewCertPool()
	for _, c := range state.PeerCertificates[1:] {
		inter.AddCert(c)
	}
	_, p.SystemErr = leaf.Verify(x509.VerifyOptions{DNSName: host, Roots: roots, Intermediates: inter})
	return p, nil
}

// dialThrough opens a TCP connection to addr, through an HTTP CONNECT
// proxy when proxy is set.
func dialThrough(ctx context.Context, addr, proxy string) (net.Conn, error) {
	d := &net.Dialer{Timeout: 30 * time.Second}
	if proxy == "" {
		return d.DialContext(ctx, "tcp", addr)
	}
	pu, err := url.Parse(proxy)
	if err != nil || CheckProxy(proxy) != nil {
		return nil, fmt.Errorf("invalid proxy %q", proxy)
	}
	c, err := d.DialContext(ctx, "tcp", pu.Host)
	if err != nil {
		return nil, err
	}
	_ = c.SetDeadline(time.Now().Add(30 * time.Second))
	fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", addr, addr)
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		c.Close()
		return nil, fmt.Errorf("proxy: %w", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || br.Buffered() > 0 {
		c.Close()
		return nil, fmt.Errorf("proxy refused CONNECT %s: %s", addr, resp.Status)
	}
	_ = c.SetDeadline(time.Time{})
	return c, nil
}

// TrustConfig is the trust recover settled on.
type TrustConfig struct {
	Mode TrustMode
	// CAPEM is the instance's CA (TrustCAFile).
	CAPEM []byte
	// Leaf is the pinned certificate (TrustPinned).
	Leaf *x509.Certificate
	// Proxy is the http:// proxy, or "".
	Proxy string
	// Roots replaces the system pool (tests).
	Roots *x509.CertPool
}

// NewHTTPClient is the client of the recovery API for a trust mode. It
// follows no redirect. In pinned mode only the pinned leaf is a root, and
// the SPKI of the presented leaf must equal it.
func NewHTTPClient(tc TrustConfig) (*http.Client, error) {
	cfg := &tls.Config{MinVersion: tls.VersionTLS12}
	switch tc.Mode {
	case TrustSystem, "":
		cfg.RootCAs = tc.Roots
	case TrustCAFile:
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(tc.CAPEM) {
			return nil, errors.New("the CA file holds no PEM certificate")
		}
		cfg.RootCAs = pool
	case TrustPinned:
		if tc.Leaf == nil {
			return nil, errors.New("pinned trust without a certificate")
		}
		pool := x509.NewCertPool()
		pool.AddCert(tc.Leaf)
		cfg.RootCAs = pool
		want, _ := hex.DecodeString(SPKISHA256(tc.Leaf))
		cfg.VerifyPeerCertificate = func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 {
				return errors.New("no certificate")
			}
			c, err := x509.ParseCertificate(rawCerts[0])
			if err != nil {
				return err
			}
			got := sha256.Sum256(c.RawSubjectPublicKeyInfo)
			if subtle.ConstantTimeCompare(got[:], want) != 1 {
				return errors.New("the instance presented another key than the one confirmed with the check value")
			}
			return nil
		}
	default:
		return nil, fmt.Errorf("unknown trust mode %q", tc.Mode)
	}
	tr := &http.Transport{TLSClientConfig: cfg, ForceAttemptHTTP2: true, TLSHandshakeTimeout: 30 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second, IdleConnTimeout: 90 * time.Second, MaxIdleConns: 4}
	if tc.Proxy != "" {
		pu, err := url.Parse(tc.Proxy)
		if err != nil || CheckProxy(tc.Proxy) != nil {
			return nil, fmt.Errorf("invalid proxy %q", tc.Proxy)
		}
		tr.Proxy = http.ProxyURL(pu)
	}
	return &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, nil
}

// WritePinnedLeaf writes the pinned leaf (or the CA) as a PEM file for
// restic's RESTIC_CACERT (R3) on tmpfs and returns its path. restic then
// trusts exactly this certificate and still checks the host name.
func WritePinnedLeaf(dir string, tc TrustConfig) (string, error) {
	var data []byte
	switch tc.Mode {
	case TrustPinned:
		data = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: tc.Leaf.Raw})
	case TrustCAFile:
		data = tc.CAPEM
	default:
		return "", nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	name := "ca.pem"
	if tc.Mode == TrustPinned {
		name = "pinned.pem"
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, data, 0o600); err != nil {
		return "", err
	}
	return p, nil
}

// IsTLSError reports whether err comes from the certificate check.
func IsTLSError(err error) bool {
	var tv *tls.CertificateVerificationError
	var inv x509.CertificateInvalidError
	var ua x509.UnknownAuthorityError
	var hn x509.HostnameError
	return errors.As(err, &tv) || errors.As(err, &inv) || errors.As(err, &ua) || errors.As(err, &hn) ||
		strings.Contains(fmt.Sprint(err), "x509:")
}
