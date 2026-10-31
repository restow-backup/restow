// Package procenv builds the environment of child processes (restic, hooks).
// The agent runs as root (SYSTEM on Windows) with whatever environment the
// service manager gave it; children only inherit a short allowlist, so
// nothing unexpected (cloud credentials, tokens) leaks into hooks or into
// restic's process. On Windows variable names are compared without regard to
// case, as Windows does (Path, PATH and path are one variable).
package procenv

import (
	"os"
	"runtime"
	"strings"
)

var allowedUnix = map[string]bool{
	"PATH": true, "HOME": true, "LANG": true, "LC_ALL": true, "LC_CTYPE": true, "TZ": true,
	"TMPDIR": true, "USER": true, "LOGNAME": true, "SHELL": true,
}

// allowedWindows holds upper-case names (docs/WINDOWS-AGENT.md, section 12.4).
var allowedWindows = map[string]bool{
	"PATH": true, "PATHEXT": true, "SYSTEMROOT": true, "WINDIR": true, "SYSTEMDRIVE": true, "COMSPEC": true,
	"TEMP": true, "TMP": true, "PROGRAMDATA": true, "PROGRAMFILES": true, "PROGRAMFILES(X86)": true,
	"PROGRAMW6432": true, "COMMONPROGRAMFILES": true, "COMMONPROGRAMW6432": true, "ALLUSERSPROFILE": true,
	"USERPROFILE": true, "APPDATA": true, "LOCALAPPDATA": true, "COMPUTERNAME": true,
	"NUMBER_OF_PROCESSORS": true, "PROCESSOR_ARCHITECTURE": true, "PSMODULEPATH": true,
}

// Network: proxies and custom CA bundles, on every system.
var allowedNetwork = map[string]bool{
	"HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true, "ALL_PROXY": true,
	"http_proxy": true, "https_proxy": true, "no_proxy": true, "all_proxy": true,
	"SSL_CERT_FILE": true, "SSL_CERT_DIR": true,
}

const defaultPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

var isWindows = runtime.GOOS == "windows"

// Base returns the allowlisted variables of the current environment as
// KEY=value pairs, with PATH guaranteed.
func Base() []string {
	return Filter(os.Environ())
}

// Filter applies the allowlist of this system to environ.
func Filter(environ []string) []string { return filter(environ, isWindows) }

func filter(environ []string, windows bool) []string {
	var out []string
	hasPath := false
	for _, kv := range environ {
		k, _, ok := strings.Cut(kv, "=")
		if !ok || k == "" || !allowedName(k, windows) {
			continue
		}
		if sameName(k, "PATH", windows) {
			hasPath = true
		}
		out = append(out, kv)
	}
	if !hasPath {
		out = append(out, defaultPathEntry(environ, windows))
	}
	return out
}

func allowedName(k string, windows bool) bool {
	if windows {
		up := strings.ToUpper(k)
		return allowedWindows[up] || allowedNetwork[up] || allowedNetwork[strings.ToLower(k)]
	}
	return allowedUnix[k] || allowedNetwork[k]
}

func sameName(a, b string, windows bool) bool {
	if windows {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// defaultPathEntry is the PATH a child gets when the agent has none: the
// standard folders, on Windows below %SystemRoot%.
func defaultPathEntry(environ []string, windows bool) string {
	if !windows {
		return "PATH=" + defaultPath
	}
	root, ok := get(environ, "SystemRoot", true)
	if !ok || root == "" {
		root = `C:\Windows`
	}
	return "Path=" + root + `\System32;` + root + ";" + root + `\System32\Wbem;` + root + `\System32\WindowsPowerShell\v1.0`
}

// Set returns env with key=value added, replacing an existing entry.
func Set(env []string, key, value string) []string { return set(env, key, value, isWindows) }

func set(env []string, key, value string, windows bool) []string {
	for i, kv := range env {
		if k, _, ok := strings.Cut(kv, "="); ok && sameName(k, key, windows) {
			env[i] = key + "=" + value
			return env
		}
	}
	return append(env, key+"="+value)
}

// Get returns the value of key in env.
func Get(env []string, key string) (string, bool) { return get(env, key, isWindows) }

func get(env []string, key string, windows bool) (string, bool) {
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok && sameName(k, key, windows) {
			return v, true
		}
	}
	return "", false
}
