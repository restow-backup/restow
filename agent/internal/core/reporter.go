package core

import (
	"context"
	"sync"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
	"github.com/restow-backup/restow/agent/internal/restic"
)

// progressReporter forwards the latest progress of a run to the server at most
// once per interval. Updates come from restic's output reader; sending happens
// on its own goroutine so a slow server never stalls restic. Progress is
// best effort: failures are logged at debug level and dropped.
type progressReporter struct {
	srv      Server
	runID    api.Flex
	interval time.Duration
	onError  func(error)

	mu     sync.Mutex
	latest restic.Progress
	dirty  bool
	stop   chan struct{}
	done   chan struct{}
}

func newProgressReporter(srv Server, runID api.Flex, interval time.Duration, onError func(error)) *progressReporter {
	if interval <= 0 {
		interval = 10 * time.Second
	}
	return &progressReporter{srv: srv, runID: runID, interval: interval, onError: onError,
		stop: make(chan struct{}), done: make(chan struct{})}
}

// Update records the newest progress.
func (p *progressReporter) Update(pr restic.Progress) {
	p.mu.Lock()
	p.latest, p.dirty = pr, true
	p.mu.Unlock()
}

// Start launches the sender goroutine.
func (p *progressReporter) Start(ctx context.Context) {
	go func() {
		defer close(p.done)
		t := time.NewTicker(p.interval)
		defer t.Stop()
		for {
			select {
			case <-p.stop:
				return
			case <-ctx.Done():
				return
			case <-t.C:
				p.send(ctx)
			}
		}
	}()
}

func (p *progressReporter) send(ctx context.Context) {
	p.mu.Lock()
	if !p.dirty {
		p.mu.Unlock()
		return
	}
	pr := p.latest
	p.dirty = false
	p.mu.Unlock()

	body := api.Progress{FilesDone: pr.FilesDone, BytesDone: pr.BytesDone, CurrentPath: pr.CurrentPath}
	if pr.TotalFiles > 0 {
		v := pr.TotalFiles
		body.TotalFiles = &v
	}
	if pr.TotalBytes > 0 {
		v := pr.TotalBytes
		body.TotalBytes = &v
	}
	sctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := p.srv.SendProgress(sctx, p.runID, body); err != nil && p.onError != nil {
		p.onError(err)
	}
}

// Stop ends the sender and waits for it.
func (p *progressReporter) Stop() {
	select {
	case <-p.stop:
	default:
		close(p.stop)
	}
	<-p.done
}
