package core

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

// maxOutbox bounds the number of undelivered reports kept on disk.
const maxOutbox = 50

// outboxItem is a finish report that could not be delivered yet.
type outboxItem struct {
	RunID   api.Flex          `json:"runId"`
	Finish  api.FinishRequest `json:"finish"`
	Created time.Time         `json:"created"`
}

// outbox keeps run reports that could not be sent (server unreachable) so a
// finished backup is never lost from the server's view. Files are 0600 and
// contain only what would have been sent: the log tail is already redacted.
type outbox struct {
	dir    string
	logger *slog.Logger
}

func (o *outbox) put(runID api.Flex, f api.FinishRequest) error {
	if err := os.MkdirAll(o.dir, 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(outboxItem{RunID: runID, Finish: f, Created: time.Now().UTC()})
	if err != nil {
		return err
	}
	name := filepath.Join(o.dir, "finish-"+sanitize(runID.String())+".json")
	tmp := name + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, name); err != nil {
		return err
	}
	o.prune()
	return nil
}

func sanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	return b.String()
}

func (o *outbox) list() []string {
	entries, err := os.ReadDir(o.dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "finish-") && strings.HasSuffix(e.Name(), ".json") {
			names = append(names, filepath.Join(o.dir, e.Name()))
		}
	}
	sort.Strings(names)
	return names
}

func (o *outbox) prune() {
	names := o.list()
	for len(names) > maxOutbox {
		_ = os.Remove(names[0])
		names = names[1:]
	}
}

// flush delivers what is stored. A report the server no longer knows (404) or
// rejects as invalid (4xx other than auth) is dropped; network errors stop the
// flush so it is retried at the next heartbeat.
func (o *outbox) flush(ctx context.Context, srv Server) (delivered int) {
	for _, name := range o.list() {
		raw, err := os.ReadFile(name)
		if err != nil {
			continue
		}
		var item outboxItem
		if json.Unmarshal(raw, &item) != nil {
			_ = os.Remove(name)
			continue
		}
		err = srv.FinishRun(ctx, item.RunID, item.Finish)
		if err == nil {
			_ = os.Remove(name)
			delivered++
			continue
		}
		var ae *api.APIError
		if errors.As(err, &ae) && ae.Status >= 400 && ae.Status < 500 && ae.Status != 401 && ae.Status != 403 && ae.Status != 429 {
			if o.logger != nil {
				o.logger.Warn("dropping an undeliverable run report", "run", item.RunID.String(), "error", err)
			}
			_ = os.Remove(name)
			continue
		}
		return delivered
	}
	return delivered
}
