package dbrun

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
)

// db-stream (5.1): the command restic starts for a dump
// (restic backup --stdin-from-command -- restow-agent db-stream --spec <file>).
// It runs the program of the spec with its fixed arguments and its own
// environment, passes the output to restic, hashes and counts it, reads the
// archive's table of contents with pg_restore --list on the side, writes the
// statistics, and ends with a code other than 0 when the program failed, so
// restic keeps no snapshot.

// StreamSpec is the spec file of db-stream (0600, in memory).
type StreamSpec struct {
	Tool      string   `json:"tool"`
	Args      []string `json:"args"`
	Env       []string `json:"env"`
	ListTool  string   `json:"listTool"`
	StatsPath string   `json:"statsPath"`
	// CountMysql: count MySQL's and MariaDB's objects from the dump's statement
	// headers (16 "D4" M4).
	CountMysql bool `json:"countMysql,omitempty"`
	// InputFile: instead of a program, pass this file (0600 in the run's
	// private folder, written by the agent: MySQL's users and grants).
	InputFile string `json:"inputFile,omitempty"`
}

// StreamStats is what db-stream writes when the program ended.
type StreamStats struct {
	OK       bool           `json:"ok"`
	Bytes    int64          `json:"bytes"`
	SHA256   string         `json:"sha256"`
	Objects  map[string]int `json:"objects"`
	ExitCode int            `json:"exitCode"`
	Stderr   string         `json:"stderr"`
}

const stderrKeep = 4096

// listBufferMax: a lister that falls behind is not fed further (the table
// of contents is at the start of the archive).
const listBufferMax = 8 << 20

type tail struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > stderrKeep {
		t.buf = t.buf[len(t.buf)-stderrKeep:]
	}
	return len(p), nil
}

func (t *tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.TrimSpace(string(t.buf))
}

// Stream runs the spec and returns the exit code for restic.
func Stream(ctx context.Context, spec StreamSpec, out io.Writer) int {
	if spec.InputFile != "" {
		return streamFile(spec, out)
	}
	cmd := exec.CommandContext(ctx, spec.Tool, spec.Args...) // #nosec G204 -- fixed argument lists (tools.go)
	cmd.Env = spec.Env
	errs := &tail{}
	cmd.Stderr = errs
	stdout, err := cmd.StdoutPipe()
	stats := StreamStats{Objects: map[string]int{}, ExitCode: -1}
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		stats.Stderr = err.Error()
		writeStats(spec.StatsPath, stats)
		return 1
	}
	var lister *exec.Cmd
	var listIn io.WriteCloser
	var listing bytes.Buffer
	var listDone sync.WaitGroup
	fed := 0
	if spec.ListTool != "" {
		lister = exec.CommandContext(ctx, spec.ListTool, "--list") // #nosec G204 -- a fixed argument
		lister.Env = []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8"}
		lister.Stdout = &limited{w: &listing, left: 64 << 20}
		if in, perr := lister.StdinPipe(); perr == nil && lister.Start() == nil {
			listIn = in
			listDone.Add(1)
			go func() {
				defer listDone.Done()
				_ = lister.Wait()
			}()
		}
	}
	hash := sha256.New()
	var scanner *MysqlDumpScanner
	if spec.CountMysql {
		scanner = NewMysqlDumpScanner(false)
	}
	buf := make([]byte, 64<<10)
	var writeErr error
	for {
		n, rerr := stdout.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			hash.Write(chunk)
			stats.Bytes += int64(n)
			if scanner != nil {
				scanner.Push(chunk)
			}
			if listIn != nil {
				if fed+n > listBufferMax {
					_ = listIn.Close()
					listIn = nil
				} else if _, lerr := listIn.Write(chunk); lerr != nil {
					// The lister has the table of contents and stopped reading.
					_ = listIn.Close()
					listIn = nil
				} else {
					fed += n
				}
			}
			if _, werr := out.Write(chunk); werr != nil && writeErr == nil {
				writeErr = werr
				_ = cmd.Process.Kill()
			}
		}
		if rerr != nil {
			break
		}
	}
	if listIn != nil {
		_ = listIn.Close()
	}
	waitErr := cmd.Wait()
	listDone.Wait()
	stats.ExitCode = cmd.ProcessState.ExitCode()
	stats.OK = waitErr == nil && writeErr == nil && stats.ExitCode == 0
	stats.SHA256 = hex.EncodeToString(hash.Sum(nil))
	stats.Objects = CountListEntries(listing.String())
	if scanner != nil {
		stats.Objects = scanner.Counts
	}
	stats.Stderr = errs.String()
	writeStats(spec.StatsPath, stats)
	if !stats.OK {
		return 1
	}
	return 0
}

// streamFile passes a file the agent wrote (InputFile).
func streamFile(spec StreamSpec, out io.Writer) int {
	stats := StreamStats{Objects: map[string]int{}, ExitCode: -1}
	f, err := os.Open(spec.InputFile)
	if err != nil {
		stats.Stderr = err.Error()
		writeStats(spec.StatsPath, stats)
		return 1
	}
	defer f.Close()
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(out, hash), f)
	stats.Bytes = n
	stats.SHA256 = hex.EncodeToString(hash.Sum(nil))
	stats.OK = err == nil
	if err != nil {
		stats.Stderr = err.Error()
	} else {
		stats.ExitCode = 0
	}
	writeStats(spec.StatsPath, stats)
	if !stats.OK {
		return 1
	}
	return 0
}

type limited struct {
	w    io.Writer
	left int
}

func (l *limited) Write(p []byte) (int, error) {
	if l.left <= 0 {
		return len(p), nil
	}
	take := p
	if len(take) > l.left {
		take = take[:l.left]
	}
	l.left -= len(take)
	_, _ = l.w.Write(take)
	return len(p), nil
}

func writeStats(path string, stats StreamStats) {
	if path == "" {
		return
	}
	b, _ := json.Marshal(stats)
	_ = os.WriteFile(path, b, 0o600)
}

var listLine = regexp.MustCompile(`^\d+;\s+\d+\s+\d+\s+(.+)$`)

var multiWordKinds = func() [][]string {
	kinds := []string{"MATERIALIZED VIEW DATA", "PUBLICATION TABLES IN SCHEMA", "TEXT SEARCH CONFIGURATION", "TEXT SEARCH DICTIONARY", "TEXT SEARCH TEMPLATE", "TEXT SEARCH PARSER", "FOREIGN DATA WRAPPER", "SEQUENCE OWNED BY", "MATERIALIZED VIEW", "PUBLICATION TABLE", "DATABASE PROPERTIES", "CHECK CONSTRAINT", "LARGE OBJECTS", "LARGE OBJECT", "BLOB METADATA", "FK CONSTRAINT", "EVENT TRIGGER", "FOREIGN TABLE", "OPERATOR CLASS", "OPERATOR FAMILY", "ROW SECURITY", "SEQUENCE SET", "USER MAPPING", "DEFAULT ACL", "TABLE DATA", "ACCESS METHOD", "PROCEDURAL LANGUAGE", "TABLE ATTACH", "INDEX ATTACH"}
	out := make([][]string, len(kinds))
	for i, kind := range kinds {
		out[i] = strings.Fields(kind)
	}
	return out
}()

// CountListEntries counts pg_restore --list entries by kind (5.5), like
// packages/core databases/pg-tools.ts countPgListEntries.
func CountListEntries(listing string) map[string]int {
	counts := map[string]int{}
	for _, raw := range strings.Split(listing, "\n") {
		m := listLine.FindStringSubmatch(strings.TrimSpace(raw))
		if m == nil {
			continue
		}
		words := strings.Fields(m[1])
		kind := ""
		for _, multi := range multiWordKinds {
			if len(words) >= len(multi) && strings.Join(words[:len(multi)], " ") == strings.Join(multi, " ") {
				kind = strings.Join(multi, " ")
				break
			}
		}
		if kind == "" && len(words) > 0 {
			kind = words[0]
		}
		if kind != "" {
			counts[kind]++
		}
	}
	return counts
}
