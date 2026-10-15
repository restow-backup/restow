package share

import (
	"context"
	"errors"
	"io/fs"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The walk (4.3): one pass over the include folders before restic runs. It
// counts files and bytes (the progress totals), captures the permissions
// into the sidecar, finds offline files and collects the sample candidates,
// skipping excluded subtrees with the same patterns restic gets. Several
// directory readers run in parallel; a folder's own entry is always written
// before anything below it, so the sidecar is in top-down order.

// PreviousEntry is what the previous sidecar recorded for a path (ACL reuse).
type PreviousEntry struct {
	CTime      int64
	Size       int64
	Descriptor *Descriptor
	Attrs      *uint32
	Created    *uint64
}

// WalkOptions configure one walk.
type WalkOptions struct {
	// Root is the share root (/share). Paths in the sidecar are relative to it.
	Root string
	// SnapshotRoot is how restic names Root (the same path; exclude patterns
	// are matched against SnapshotRoot + "/" + rel).
	SnapshotRoot string
	// Includes are folders relative to Root; empty walks everything.
	Includes []string
	Excludes *Matcher
	// Capture is nil when permissions are off.
	Capture *Capturer
	Sidecar *SidecarWriter
	// Previous enables the ACL reuse (SMB only, 4.3).
	Previous    map[string]PreviousEntry
	SkipOffline bool
	Readers     int
	// SampleBefore: only files modified before this are sample candidates.
	SampleBefore time.Time
	// SamplePool is how many candidates to keep (reservoir).
	SamplePool int
	Rand       *rand.Rand
	OnItem     func(Item)
	OnProgress func(files, bytes uint64, current string)
}

// SampleCandidate is a regular file the samples may pick.
type SampleCandidate struct {
	Rel   string
	Size  int64
	MTime time.Time
}

// WalkResult sums the walk up.
type WalkResult struct {
	Files, Dirs, Bytes uint64
	// Offline are the offline files (relative paths) the backup skips.
	Offline      []string
	OfflineCount int
	Reused       int
	ACLErrors    int
	ReadErrors   int
	Candidates   []SampleCandidate
}

type walkState struct {
	o     WalkOptions
	mu    sync.Mutex
	cond  *sync.Cond
	queue []string
	busy  int
	done  bool
	res   WalkResult
	seen  int
	ctx   context.Context
	err   error
}

// Walk walks the share. The returned error is a fatal one (the context ended,
// the sidecar could not be written); per-file problems are items.
func Walk(ctx context.Context, o WalkOptions) (WalkResult, error) {
	if o.Readers <= 0 {
		o.Readers = 8
	}
	if o.Rand == nil {
		o.Rand = rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), 7))
	}
	if o.SnapshotRoot == "" {
		o.SnapshotRoot = o.Root
	}
	s := &walkState{o: o, ctx: ctx}
	s.cond = sync.NewCond(&s.mu)

	// The root and the folders above every include get their entry (a restore
	// applies permissions top-down), but only the include folders are walked.
	starts := []string{""}
	if len(o.Includes) > 0 {
		starts = nil
		written := map[string]bool{}
		for _, inc := range o.Includes {
			inc = strings.Trim(inc, "/")
			parts := strings.Split(inc, "/")
			for i := 0; i < len(parts); i++ {
				anc := strings.Join(parts[:i], "/")
				if !written[anc] {
					written[anc] = true
					if err := s.entry(anc, true, nil); err != nil {
						return s.res, err
					}
				}
			}
			starts = append(starts, inc)
		}
	}
	for _, start := range starts {
		fi, err := os.Lstat(s.abs(start))
		if err != nil {
			return s.res, err
		}
		if err := s.entry(start, true, fi); err != nil {
			return s.res, err
		}
		s.res.Dirs++
		s.queue = append(s.queue, start)
	}

	var wg sync.WaitGroup
	for i := 0; i < o.Readers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.worker()
		}()
	}
	wg.Wait()
	if s.err != nil {
		return s.res, s.err
	}
	if err := ctx.Err(); err != nil {
		return s.res, err
	}
	return s.res, nil
}

func (s *walkState) abs(rel string) string {
	if rel == "" {
		return s.o.Root
	}
	return filepath.Join(s.o.Root, filepath.FromSlash(rel))
}

func (s *walkState) snapshotPath(rel string) string {
	if rel == "" {
		return s.o.SnapshotRoot
	}
	return strings.TrimRight(s.o.SnapshotRoot, "/") + "/" + rel
}

func (s *walkState) worker() {
	for {
		s.mu.Lock()
		for len(s.queue) == 0 && s.busy > 0 && !s.done {
			s.cond.Wait()
		}
		if s.done || len(s.queue) == 0 {
			s.done = true
			s.cond.Broadcast()
			s.mu.Unlock()
			return
		}
		// Depth first (LIFO) keeps the queue short.
		dir := s.queue[len(s.queue)-1]
		s.queue = s.queue[:len(s.queue)-1]
		s.busy++
		s.mu.Unlock()

		subdirs, err := s.readDir(dir)

		s.mu.Lock()
		s.busy--
		if err != nil && s.err == nil {
			s.err = err
			s.done = true
		}
		if s.ctx.Err() != nil {
			s.done = true
		}
		s.queue = append(s.queue, subdirs...)
		s.cond.Broadcast()
		s.mu.Unlock()
	}
}

func (s *walkState) item(rel, code string, err error) {
	if s.o.OnItem == nil {
		return
	}
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	s.o.OnItem(Item{Path: rel, Code: code, Message: msg, Phase: PhaseScan})
}

// readDir reads one folder; it returns the subfolders to walk and only fatal errors.
func (s *walkState) readDir(dir string) ([]string, error) {
	entries, err := os.ReadDir(s.abs(dir))
	if err != nil {
		s.mu.Lock()
		s.res.ReadErrors++
		s.mu.Unlock()
		s.item(dir, ItemReadError, err)
		return nil, nil
	}
	var subdirs []string
	for _, de := range entries {
		if s.ctx.Err() != nil {
			return nil, nil
		}
		rel := de.Name()
		if dir != "" {
			rel = dir + "/" + de.Name()
		}
		if s.o.Excludes.Match(s.snapshotPath(rel)) {
			continue
		}
		fi, err := de.Info()
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				s.mu.Lock()
				s.res.ReadErrors++
				s.mu.Unlock()
				s.item(rel, ItemReadError, err)
			}
			continue
		}
		switch {
		case fi.IsDir():
			if err := s.entry(rel, true, fi); err != nil {
				return nil, err
			}
			s.mu.Lock()
			s.res.Dirs++
			s.mu.Unlock()
			subdirs = append(subdirs, rel)
		case fi.Mode().IsRegular():
			if err := s.file(rel, fi); err != nil {
				return nil, err
			}
		case fi.Mode()&fs.ModeSymlink != 0:
			// restic stores the link; its permissions are the target's business.
			s.mu.Lock()
			s.res.Files++
			s.mu.Unlock()
		}
	}
	return subdirs, nil
}

func (s *walkState) file(rel string, fi os.FileInfo) error {
	captured, err := s.capture(rel, false, fi)
	if err != nil {
		return err
	}
	if captured.Attrs != nil && IsOffline(*captured.Attrs) && s.o.SkipOffline {
		s.mu.Lock()
		s.res.OfflineCount++
		s.res.Offline = append(s.res.Offline, rel)
		s.mu.Unlock()
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.res.Files++
	s.res.Bytes += uint64(fi.Size())
	if s.o.SamplePool > 0 && fi.Size() > 0 && fi.ModTime().Before(s.o.SampleBefore) {
		s.seen++
		c := SampleCandidate{Rel: rel, Size: fi.Size(), MTime: fi.ModTime()}
		if len(s.res.Candidates) < s.o.SamplePool {
			s.res.Candidates = append(s.res.Candidates, c)
		} else if j := s.o.Rand.IntN(s.seen); j < s.o.SamplePool {
			s.res.Candidates[j] = c
		}
	}
	if s.o.OnProgress != nil {
		s.o.OnProgress(s.res.Files, s.res.Bytes, rel)
	}
	return nil
}

// entry captures the permissions of a folder (fi may be nil for an ancestor
// of an include folder that is not walked).
func (s *walkState) entry(rel string, isDir bool, fi os.FileInfo) error {
	_, err := s.capture(rel, isDir, fi)
	return err
}

// capture reads the permissions and DOS attributes of one path and writes
// its sidecar entry. Only a failure to write the sidecar is returned. With
// permissions off (Capture.Xattr none, no sidecar) it still reads the DOS
// attributes, which the offline check needs.
func (s *walkState) capture(rel string, isDir bool, fi os.FileInfo) (Captured, error) {
	if s.o.Capture == nil {
		return Captured{}, nil
	}
	var ctime, size int64
	if fi != nil {
		ctime = ctimeOf(fi)
		if !isDir {
			size = fi.Size()
		}
	}
	if s.o.Sidecar != nil {
		if prev, ok := s.o.Previous[rel]; ok && fi != nil && ctime != 0 && prev.CTime == ctime && prev.Size == size {
			captured := Captured{Descriptor: prev.Descriptor, Attrs: prev.Attrs, Created: prev.Created}
			s.mu.Lock()
			s.res.Reused++
			s.mu.Unlock()
			return captured, s.o.Sidecar.Entry(SidecarEntry{Path: rel, Descriptor: captured.Descriptor,
				Attrs: captured.Attrs, Created: captured.Created, CTime: ctime, Size: size})
		}
	}
	captured, err := s.o.Capture.Capture(s.abs(rel), isDir)
	if s.o.Sidecar == nil {
		return captured, nil
	}
	if err != nil {
		s.mu.Lock()
		s.res.ACLErrors++
		s.mu.Unlock()
		s.item(rel, ItemACLUnreadable, err)
		name := errnoName(err)
		if name == "" {
			name = "EIO"
		}
		if werr := s.o.Sidecar.Error(rel, name); werr != nil {
			return captured, werr
		}
	}
	return captured, s.o.Sidecar.Entry(SidecarEntry{Path: rel, Descriptor: captured.Descriptor, Attrs: captured.Attrs,
		Created: captured.Created, CTime: ctime, Size: size})
}

// LoadPrevious reads a previous sidecar into the reuse map. Only entries
// with a change time can be reused.
func LoadPrevious(read func(func(SidecarRecord) error) (SidecarResult, error)) (map[string]PreviousEntry, error) {
	out := map[string]PreviousEntry{}
	_, err := read(func(r SidecarRecord) error {
		if r.Entry != nil && r.Entry.CTime != 0 {
			out[r.Entry.Path] = PreviousEntry{CTime: r.Entry.CTime, Size: r.Entry.Size,
				Descriptor: r.Entry.Descriptor, Attrs: r.Entry.Attrs, Created: r.Entry.Created}
		}
		return nil
	})
	return out, err
}
