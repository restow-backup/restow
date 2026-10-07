package pve

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"sync"
	"time"

	"github.com/restow-backup/restow/agent/internal/nbd"
)

// BlockSource is what the VM backup needs of an NBD export (an *nbd.Client).
type BlockSource interface {
	Size() uint64
	ReadAt(p []byte, off uint64) error
	Context(name string) (uint32, bool)
	Extents(id uint32, off, length uint64) ([]nbd.Extent, error)
	CanTrim() bool
	Trim(off, length uint64) error
}

// BlockSink receives upload frames (the Restow server).
type BlockSink interface {
	PutBlocks(ctx context.Context, runID string, frame []byte) error
}

// DiskPlan is how one disk is backed up.
type DiskPlan struct {
	Device string
	Size   uint64
	// BitmapMode as PVE passes it: "reuse" (read only the dirty blocks),
	// "new" or "none" (read every block).
	BitmapMode string
	BitmapName string
	// Base are the block hashes of the restore point the server builds on
	// (nil: none, every block must be reported).
	Base *HashList
}

// DiskResult is what one disk backup did.
type DiskResult struct {
	CommitDevice
	// Hashes is the block list after this backup (base plus changes).
	Hashes *HashList
}

// RateLimiter limits upload bytes per second (0 = unlimited).
type RateLimiter struct {
	mu       sync.Mutex
	perSec   float64
	tokens   float64
	last     time.Time
	sleepFor func(time.Duration)
}

// NewRateLimiter creates a limiter of bytesPerSec (0 = none).
func NewRateLimiter(bytesPerSec uint64) *RateLimiter {
	return &RateLimiter{perSec: float64(bytesPerSec), last: time.Now(), sleepFor: time.Sleep}
}

// Wait blocks until n bytes may be sent.
func (r *RateLimiter) Wait(n int) {
	if r == nil || r.perSec <= 0 {
		return
	}
	r.mu.Lock()
	now := time.Now()
	r.tokens += now.Sub(r.last).Seconds() * r.perSec
	if r.tokens > r.perSec {
		r.tokens = r.perSec
	}
	r.last = now
	r.tokens -= float64(n)
	deficit := -r.tokens
	r.mu.Unlock()
	if deficit > 0 {
		r.sleepFor(time.Duration(deficit / r.perSec * float64(time.Second)))
	}
}

// dirtyBlocks lists the blocks to read: the dirty ones for "reuse", all others.
func dirtyBlocks(src BlockSource, plan DiskPlan) ([]bool, error) {
	n := BlockCount(plan.Size)
	read := make([]bool, n)
	if plan.BitmapMode != "reuse" {
		for i := range read {
			read[i] = true
		}
		return read, nil
	}
	if plan.BitmapName == "" {
		return nil, fmt.Errorf("%s: bitmap mode reuse without a bitmap name", plan.Device)
	}
	id, ok := src.Context(nbd.DirtyBitmapPrefix + plan.BitmapName)
	if !ok {
		return nil, fmt.Errorf("%s: the NBD export does not offer the dirty bitmap %q", plan.Device, plan.BitmapName)
	}
	if plan.Size == 0 {
		return read, nil
	}
	extents, err := src.Extents(id, 0, plan.Size)
	if err != nil {
		return nil, fmt.Errorf("%s: query the dirty bitmap: %w", plan.Device, err)
	}
	for _, e := range extents {
		if e.Flags&nbd.StateDirty == 0 {
			continue
		}
		end := e.Offset + e.Length
		if e.Offset%BlockSize != 0 || (end%BlockSize != 0 && end != plan.Size) {
			return nil, fmt.Errorf("%s: dirty extent %d+%d is not aligned to %d bytes; the bitmap granularity is not the one PVE uses",
				plan.Device, e.Offset, e.Length, BlockSize)
		}
		for b := e.Offset / BlockSize; b*BlockSize < end; b++ {
			read[b] = true
		}
	}
	return read, nil
}

// BackupDisk reads the blocks of one disk, skips zero blocks the base already
// has as zero and blocks whose hash did not change, uploads the rest in
// frames, and discards (TRIM) every block once it is handled so the fleecing
// image on the PVE side does not grow. A block is trimmed only after the
// server acknowledged it. Any error ends the backup of the disk: PVE then
// keeps the dirty bitmap (it merges it back on failure).
func BackupDisk(ctx context.Context, src BlockSource, sink BlockSink, runID string, plan DiskPlan, limit *RateLimiter, logf func(string, ...any)) (DiskResult, error) {
	res := DiskResult{CommitDevice: CommitDevice{Device: plan.Device, Size: plan.Size, BitmapMode: plan.BitmapMode}}
	if src.Size() != plan.Size {
		return res, fmt.Errorf("%s: the NBD export has %d bytes, PVE announced %d", plan.Device, src.Size(), plan.Size)
	}
	base := plan.Base
	if base != nil && base.DiskSize != plan.Size {
		base = nil
	}
	if plan.BitmapMode == "reuse" && base == nil {
		return res, fmt.Errorf("%s: incremental backup without the block list of the base restore point", plan.Device)
	}
	hashes := NewHashList(plan.Size)
	if base != nil {
		copy(hashes.Flags, base.Flags)
		copy(hashes.Hashes, base.Hashes)
	}
	res.Hashes = hashes
	read, err := dirtyBlocks(src, plan)
	if err != nil {
		return res, err
	}
	canTrim := src.CanTrim()

	type pending struct {
		blocks []FrameBlock
		bytes  int
	}
	frames := make(chan pending, 2)
	uploadErr := make(chan error, 1)
	var trimMu sync.Mutex
	trim := func(index uint32) {
		if !canTrim {
			return
		}
		trimMu.Lock()
		defer trimMu.Unlock()
		// A failed discard costs fleecing space, not correctness.
		_ = src.Trim(uint64(index)*BlockSize, uint64(BlockLen(plan.Size, index)))
	}
	go func() {
		var firstErr error
		for f := range frames {
			if firstErr != nil {
				continue
			}
			var buf bytes.Buffer
			if err := EncodeFrame(&buf, f.blocks); err != nil {
				firstErr = err
				continue
			}
			limit.Wait(buf.Len())
			if err := sink.PutBlocks(ctx, runID, buf.Bytes()); err != nil {
				firstErr = fmt.Errorf("%s: upload blocks: %w", plan.Device, err)
				continue
			}
			for _, b := range f.blocks {
				trim(b.Index)
			}
		}
		uploadErr <- firstErr
	}()

	var batch pending
	flush := func() {
		if len(batch.blocks) > 0 {
			frames <- batch
			batch = pending{}
		}
	}
	buf := make([]byte, BlockSize)
	var readErr error
	started := time.Now()
	lastLog := started
	for i := uint32(0); i < uint32(len(read)); i++ {
		if !read[i] {
			continue
		}
		if err := ctx.Err(); err != nil {
			readErr = err
			break
		}
		n := BlockLen(plan.Size, i)
		p := buf[:n]
		if err := src.ReadAt(p, uint64(i)*BlockSize); err != nil {
			readErr = fmt.Errorf("%s: read block %d: %w", plan.Device, i, err)
			break
		}
		res.ReadBytes += uint64(n)
		if IsZero(p) {
			if hashes.Flags[i]&FlagZero != 0 {
				res.HashSkipped++
				trim(i)
				continue
			}
			hashes.Flags[i] = FlagZero
			hashes.Hashes[i] = [32]byte{}
			res.ZeroBlocks++
			batch.blocks = append(batch.blocks, FrameBlock{Device: plan.Device, Index: i, Zero: true, Length: n})
		} else {
			sum := sha256.Sum256(p)
			if hashes.Flags[i]&FlagPresent != 0 && hashes.Hashes[i] == sum {
				res.HashSkipped++
				trim(i)
				continue
			}
			hashes.Flags[i] = FlagPresent
			hashes.Hashes[i] = sum
			res.ChangedBlocks++
			res.UploadedBytes += uint64(n)
			data := make([]byte, n)
			copy(data, p)
			batch.blocks = append(batch.blocks, FrameBlock{Device: plan.Device, Index: i, Length: n, SHA256: sum, Data: data})
			batch.bytes += int(n)
		}
		if len(batch.blocks) >= MaxBlocksPerFrame {
			flush()
		}
		if logf != nil && time.Since(lastLog) > 30*time.Second {
			lastLog = time.Now()
			logf("%s: %d of %d blocks read, %d changed, %d MiB uploaded", plan.Device, i+1, len(read),
				res.ChangedBlocks, res.UploadedBytes>>20)
		}
	}
	if readErr == nil {
		flush()
	}
	close(frames)
	if err := <-uploadErr; err != nil {
		return res, err
	}
	if readErr != nil {
		return res, readErr
	}
	// Without a base every block must be known to the server: blocks never
	// read cannot be absent then (dirtyBlocks reads all without a base).
	if logf != nil {
		logf("%s: done in %s: %d MiB read, %d blocks changed, %d new zero blocks, %d unchanged",
			plan.Device, time.Since(started).Round(time.Second), res.ReadBytes>>20, res.ChangedBlocks, res.ZeroBlocks, res.HashSkipped)
	}
	return res, nil
}
