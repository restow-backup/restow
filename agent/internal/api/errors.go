package api

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"syscall"
	"time"
)

// APIError is an error answer of the server (application/problem+json).
type APIError struct {
	Method     string
	Path       string
	Status     int
	Type       string
	Title      string
	Detail     string
	RetryAfter time.Duration
}

func (e *APIError) Error() string {
	msg := fmt.Sprintf("%s %s: HTTP %d", e.Method, e.Path, e.Status)
	if e.Title != "" {
		msg += " " + e.Title
	}
	if e.Detail != "" {
		msg += ": " + e.Detail
	}
	return msg
}

// IsAuthError reports whether the server rejected the credentials.
func IsAuthError(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && (ae.Status == 401 || ae.Status == 403)
}

// IsNotFound reports HTTP 404.
func IsNotFound(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Status == 404
}

// IsServerReachable reports whether err proves that the server was reached
// (any HTTP answer, even an error status). Network-level failures are not.
func IsServerReachable(err error) bool {
	var ae *APIError
	return errors.As(err, &ae)
}

// IsNetworkError reports failures below HTTP: DNS, connect, TLS, timeouts.
func IsNetworkError(err error) bool {
	if err == nil || IsServerReachable(err) {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	var ue *url.Error
	var ne net.Error
	var op *net.OpError
	return errors.As(err, &ue) || errors.As(err, &ne) || errors.As(err, &op) ||
		errors.Is(err, context.DeadlineExceeded)
}

// Explain turns an error into a sentence that says what happened and what to
// do about it. It is what the agent writes to its log and to the run log.
func Explain(err error, serverURL string) string {
	if err == nil {
		return ""
	}
	host := serverURL
	if u, perr := url.Parse(serverURL); perr == nil && u.Host != "" {
		host = u.Host
	}
	var ae *APIError
	if errors.As(err, &ae) {
		switch {
		case ae.Status == 401 || ae.Status == 403:
			return fmt.Sprintf("The Restow instance rejected this agent's credentials (HTTP %d). "+
				"The endpoint was probably revoked or deleted. If that was not intended, create a new "+
				"server or client in the Restow UI (Endpoints) and run the install command again.", ae.Status)
		case ae.Status == 404:
			return fmt.Sprintf("The Restow instance answered 404 for %s. It may run a version without "+
				"endpoint backup support, or the server URL is wrong. Check the instance version and %s.", ae.Path, serverURL)
		case ae.Status == 429:
			return "The Restow instance is rate limiting this agent (HTTP 429). The agent backs off and retries."
		case ae.Status >= 500:
			return fmt.Sprintf("The Restow instance reported an internal error (HTTP %d). "+
				"The agent retries; if it persists, check the server logs.", ae.Status)
		default:
			return ae.Error()
		}
	}
	var unknownAuth x509.UnknownAuthorityError
	if errors.As(err, &unknownAuth) {
		return fmt.Sprintf("The TLS certificate of %s is not trusted by this machine. Install the CA "+
			"certificate that issued it into the operating system trust store, or use a publicly trusted certificate.", host)
	}
	var hostErr x509.HostnameError
	if errors.As(err, &hostErr) {
		return fmt.Sprintf("The TLS certificate presented by %s does not match its name. "+
			"Use the exact public URL of the Restow instance.", host)
	}
	var certErr x509.CertificateInvalidError
	if errors.As(err, &certErr) {
		return fmt.Sprintf("The TLS certificate of %s is not valid (%v). Check that it has not expired "+
			"and that this machine's clock is correct.", host, err)
	}
	var recErr tls.RecordHeaderError
	if errors.As(err, &recErr) {
		return fmt.Sprintf("%s does not speak HTTPS on this port. Use the https:// URL of the Restow instance.", host)
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return fmt.Sprintf("The name %q cannot be resolved. Check DNS and the network connection of this machine.", dnsErr.Name)
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return fmt.Sprintf("Connection to %s was refused. Check that the Restow instance is running and reachable "+
			"and that outbound HTTPS is allowed by the firewall or proxy.", host)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Sprintf("The request to %s timed out. Check the network connection, firewall and proxy "+
			"(outbound HTTPS to %s is required).", host, host)
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return fmt.Sprintf("The request to %s timed out. Check the network connection, firewall and proxy "+
			"(outbound HTTPS to %s is required).", host, host)
	}
	if IsNetworkError(err) {
		return fmt.Sprintf("Cannot reach %s: %v. Check the network connection, firewall and proxy "+
			"(outbound HTTPS to %s is required).", host, strings.TrimSpace(err.Error()), host)
	}
	return err.Error()
}
