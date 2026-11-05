package recovery

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DateHint fetches the Date header of the instance (without checking its
// certificate and without sending anything but a HEAD request for /), to
// show it as a hint when TLS fails because of the clock (10.3). The clock
// is never set from it: whoever sits in the network could otherwise make
// an expired certificate valid again.
func DateHint(ctx context.Context, origin, proxy string) (time.Time, error) {
	tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}} // #nosec G402 -- the Date header is only shown
	if proxy != "" {
		pu, err := url.Parse(proxy)
		if err != nil {
			return time.Time{}, err
		}
		tr.Proxy = http.ProxyURL(pu)
	}
	defer tr.CloseIdleConnections()
	c := &http.Client{Transport: tr, Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, strings.TrimRight(origin, "/")+"/", nil)
	if err != nil {
		return time.Time{}, err
	}
	resp, err := c.Do(req)
	if err != nil {
		return time.Time{}, err
	}
	resp.Body.Close()
	d := resp.Header.Get("Date")
	if d == "" {
		return time.Time{}, errors.New("no Date header")
	}
	return http.ParseTime(d)
}

// ParseManualTime reads the time the operator typed (UTC,
// 2006-01-02 15:04).
func ParseManualTime(s string) (time.Time, error) {
	t, err := time.ParseInLocation("2006-01-02 15:04", strings.TrimSpace(s), time.UTC)
	if err != nil {
		return time.Time{}, fmt.Errorf("%q is not YYYY-MM-DD HH:MM", s)
	}
	if t.Year() < 2024 || t.Year() > 2100 {
		return time.Time{}, fmt.Errorf("%q is out of range", s)
	}
	return t, nil
}
