package recovery

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// selfSigned makes a leaf certificate for 127.0.0.1 valid in [from, to].
func selfSigned(t *testing.T, from, to time.Time, hosts ...string) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "restow test"},
		NotBefore: from, NotAfter: to, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
		} else {
			tmpl.DNSNames = append(tmpl.DNSNames, h)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(der)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}
}

func tlsServer(t *testing.T, cert tls.Certificate, hits *atomic.Int32) *httptest.Server {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Write([]byte("ok"))
	}))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv
}

func TestTLSModes(t *testing.T) {
	now := time.Now()
	cert := selfSigned(t, now.Add(-time.Hour), now.Add(time.Hour), "127.0.0.1")
	var hits atomic.Int32
	srv := tlsServer(t, cert, &hits)
	ctx := context.Background()

	probe, err := ProbeTLS(ctx, srv.URL, "", x509.NewCertPool())
	if err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 0 {
		t.Error("the probe sent a request")
	}
	if probe.SystemErr == nil || ClassifyTLSError(probe.SystemErr, probe.Leaf, now) != TLSErrUnknownAuthority {
		t.Errorf("system trust of a self-signed certificate: %v", probe.SystemErr)
	}
	if !CheckSPKI(probe.Leaf, probe.Check) || CheckSPKI(probe.Leaf, probe.Check[:9]) {
		t.Error("check value: the whole value is needed, a prefix fails")
	}

	// System mode with a pool that does not hold it fails; cafile mode
	// with the certificate passes; pinned mode passes.
	sys, _ := NewHTTPClient(TrustConfig{Mode: TrustSystem, Roots: x509.NewCertPool()})
	if _, err := sys.Get(srv.URL); err == nil || !IsTLSError(err) {
		t.Errorf("system: %v", err)
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]})
	ca, err := NewHTTPClient(TrustConfig{Mode: TrustCAFile, CAPEM: caPEM})
	if err != nil {
		t.Fatal(err)
	}
	if resp, err := ca.Get(srv.URL); err != nil {
		t.Errorf("cafile: %v", err)
	} else {
		resp.Body.Close()
	}
	pinned, err := NewHTTPClient(TrustConfig{Mode: TrustPinned, Leaf: probe.Leaf})
	if err != nil {
		t.Fatal(err)
	}
	if resp, err := pinned.Get(srv.URL); err != nil {
		t.Errorf("pinned: %v", err)
	} else {
		resp.Body.Close()
	}

	// Another key under the same name: the pinned client sends nothing.
	other := selfSigned(t, now.Add(-time.Hour), now.Add(time.Hour), "127.0.0.1")
	var hits2 atomic.Int32
	srv2 := tlsServer(t, other, &hits2)
	if _, err := pinned.Get(srv2.URL); err == nil {
		t.Error("the pinned client accepted another key")
	}
	if hits2.Load() != 0 {
		t.Error("a request reached the server with the wrong key")
	}

	// The leaf written for restic is a valid root for Go's verifier, with
	// the host name still checked.
	dir := t.TempDir()
	p, err := WritePinnedLeaf(dir, TrustConfig{Mode: TrustPinned, Leaf: probe.Leaf})
	if err != nil || filepath.Base(p) != "pinned.pem" {
		t.Fatalf("pinned leaf: %s %v", p, err)
	}
	// Only root may read it, on the ISO (Linux; recover is built for Linux
	// only). Windows has no such mode bits: Go reports 0666 for every file
	// there, and the file is protected by the ACL of its folder.
	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && st.Mode().Perm() != 0o600 {
		t.Errorf("mode %o", st.Mode().Perm())
	}
	b, _ := os.ReadFile(p)
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(b) {
		t.Fatal("pinned.pem holds no certificate")
	}
	if _, err := probe.Leaf.Verify(x509.VerifyOptions{Roots: pool, DNSName: "127.0.0.1"}); err != nil {
		t.Errorf("leaf as root: %v", err)
	}
	if _, err := probe.Leaf.Verify(x509.VerifyOptions{Roots: pool, DNSName: "evil.example"}); err == nil {
		t.Error("the host name is not checked")
	}
}

func TestTLSClockClassification(t *testing.T) {
	now := time.Now()
	expired := selfSigned(t, now.Add(-48*time.Hour), now.Add(-24*time.Hour), "127.0.0.1")
	future := selfSigned(t, now.Add(24*time.Hour), now.Add(48*time.Hour), "127.0.0.1")
	for _, c := range []struct {
		cert tls.Certificate
		want string
	}{{expired, TLSErrExpired}, {future, TLSErrNotYetValid}} {
		var hits atomic.Int32
		srv := tlsServer(t, c.cert, &hits)
		pool := x509.NewCertPool()
		pool.AddCert(c.cert.Leaf)
		probe, err := ProbeTLS(context.Background(), srv.URL, "", pool)
		if err != nil {
			t.Fatal(err)
		}
		if got := ClassifyTLSError(probe.SystemErr, probe.Leaf, now); got != c.want {
			t.Errorf("got %s, want %s (%v)", got, c.want, probe.SystemErr)
		}
		if d, err := DateHint(context.Background(), srv.URL, ""); err != nil || d.IsZero() {
			t.Errorf("date hint: %v", err)
		}
	}
	if _, err := ParseManualTime("2026-11-05 09:30"); err != nil {
		t.Error(err)
	}
	for _, bad := range []string{"05.11.2026", "1999-01-01 00:00", ""} {
		if _, err := ParseManualTime(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestProxyAndRedirect(t *testing.T) {
	for p, ok := range map[string]bool{"http://192.0.2.5:3128": true, "http://proxy:8080/": true, "https://p:1": false, "http://u:p@h:1": false, "http://h": false} {
		if (CheckProxy(p) == nil) != ok {
			t.Errorf("%s: %v", p, !ok)
		}
	}
	c, _ := NewHTTPClient(TrustConfig{Mode: TrustSystem})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://elsewhere.example/", http.StatusFound)
	}))
	defer srv.Close()
	resp, err := c.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound || !strings.Contains(resp.Header.Get("Location"), "elsewhere") {
		t.Errorf("a redirect was followed: %d", resp.StatusCode)
	}
}
