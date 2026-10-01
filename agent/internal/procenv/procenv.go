// Package procenv builds the environment of child processes (restic, hooks).
// The agent runs as root with whatever environment the service manager gave
// it; children only inherit a short allowlist, so nothing unexpected (cloud
// credentials, tokens) leaks into hooks or into restic's process.
package procenv

import (
	"os"
	"strings"
)

var allowed = map[string]bool{
	"PATH": true, "HOME": true, "LANG": true, "LC_ALL": true, "LC_CTYPE": true, "TZ": true,
	"TMPDIR": true, "USER": true, "LOGNAME": true, "SHELL": true,
	// Network: proxies and custom CA bundles.
	"HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true, "ALL_PROXY": true,
	"http_proxy": true, "https_proxy": true, "no_proxy": true, "all_proxy": true,
	"SSL_CERT_FILE": true, "SSL_CERT_DIR": true,
}

const defaultPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// Base returns the allowlisted variables of the current environment as
// KEY=value pairs, with PATH guaranteed.
func Base() []string {
	return Filter(os.Environ())
}

// Filter applies the allowlist to environ.
func Filter(environ []string) []string {
	var out []string
	hasPath := false
	for _, kv := range environ {
		k, _, ok := strings.Cut(kv, "=")
		if !ok || !allowed[k] {
			continue
		}
		if k == "PATH" {
			hasPath = true
		}
		out = append(out, kv)
	}
	if !hasPath {
		out = append(out, "PATH="+defaultPath)
	}
	return out
}

// Set returns env with key=value added, replacing an existing entry.
func Set(env []string, key, value string) []string {
	prefix := key + "="
	for i, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}

// Get returns the value of key in env.
func Get(env []string, key string) (string, bool) {
	prefix := key + "="
	for _, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			return kv[len(prefix):], true
		}
	}
	return "", false
}
