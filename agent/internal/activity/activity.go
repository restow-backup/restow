// Package activity summarises what a backup changed for the ransomware
// signals of the server (docs/RANSOMWARE.md): counts of added, modified,
// removed and extension-renamed files from `restic diff` of the previous and
// the new snapshot (metadata only), the most frequent extensions, the
// note-like names of new files, and the Shannon entropy of the first and last
// 64 KiB of a handful of new or changed files.
//
// The report is the agent protocol's `activity` (version 1), sent with the
// finish of a backup run by the endpoint agent and the file share runner. It
// is a summary, never a file list: the server matches the names against its
// own, versioned signatures, so the agent needs no list update when they
// change. A server that does not know the field ignores it.
package activity

import (
	"math"
	"math/rand/v2"
	"path"
	"sort"
	"strings"

	"github.com/restow-backup/restow/agent/internal/restic"
)

// Version of the report format.
const Version = 1

// Bounds of a report and of the work behind it.
const (
	MaxExtensions = 40
	MaxNames      = 40
	// MaxTracked bounds the removed and added paths kept for the rename
	// matching (and the distinct names counted); beyond it Truncated is set.
	MaxTracked = 100_000
	// EntropySamples is how many files are measured at most, picked at
	// random from a pool of candidates.
	EntropySamples = 8
	candidatePool  = 32
)

// Count is one counted value.
type Count struct {
	Value string `json:"value"`
	Count uint64 `json:"count"`
}

// Sample is one measured file. Tail is nil for a file of one window or less.
type Sample struct {
	Path string   `json:"path"`
	Ext  string   `json:"ext"`
	Size int64    `json:"size"`
	Head float64  `json:"head"`
	Tail *float64 `json:"tail,omitempty"`
}

// Report is the activity of one backup.
type Report struct {
	V          int      `json:"v"`
	Added      uint64   `json:"added"`
	Modified   uint64   `json:"modified"`
	Removed    uint64   `json:"removed"`
	Renamed    uint64   `json:"renamed"`
	Extensions []Count  `json:"extensions"`
	Names      []Count  `json:"names"`
	Entropy    []Sample `json:"entropy"`
	Truncated  bool     `json:"truncated,omitempty"`
}

// noteExtensions are the types ransom notes are written as; the names of new
// files of these types are counted (the server decides which are notes).
var noteExtensions = map[string]bool{"txt": true, "html": true, "htm": true, "hta": true, "rtf": true, "url": true}

// compressed are formats whose entropy says nothing; they are not measured.
// The server keeps the authoritative list (packages/core ransomware/entropy.ts).
var compressed = map[string]bool{}

func init() {
	for _, e := range strings.Fields(`zip gz tgz bz2 xz 7z rar zst lz4 lzma cab jar war apk ipa msi msix appx
		docx xlsx pptx docm xlsm pptm odt ods odp epub jpg jpeg png gif webp heic heif avif mp3 m4a aac ogg
		opus flac mp4 m4v mov mkv avi wmv webm pdf dmg iso vhd vhdx vmdk qcow2 kdbx gpg pgp age enc p12 pfx
		pst ost nupkg whl deb rpm`) {
		compressed[e] = true
	}
}

// Ext is the extension of a path's last segment, lower case, without the dot.
func Ext(p string) string {
	base := path.Base(p)
	dot := strings.LastIndexByte(base, '.')
	if dot <= 0 || dot == len(base)-1 {
		return ""
	}
	return strings.ToLower(base[dot+1:])
}

func stem(base string) string {
	dot := strings.LastIndexByte(base, '.')
	if dot <= 0 {
		return base
	}
	return base[:dot]
}

// Collector builds a report from the changes of `restic diff`.
type Collector struct {
	// Within, when set, says whether a removed path counts: one below a
	// folder that is no longer backed up is not a deletion.
	Within func(p string) bool
	// Skip, when set, leaves paths out entirely (the runner's own files).
	Skip func(p string) bool

	r          Report
	extensions map[string]uint64
	names      map[string]uint64
	removed    map[string]bool // dir/name of removed files
	stems      map[string]int  // dir/stem of removed files
	added      []string
	pool       []string
	seen       int
	rng        *rand.Rand
}

// NewCollector returns an empty collector; rng picks the entropy candidates.
func NewCollector(rng *rand.Rand) *Collector {
	if rng == nil {
		rng = rand.New(rand.NewPCG(rand.Uint64(), rand.Uint64()))
	}
	return &Collector{extensions: map[string]uint64{}, names: map[string]uint64{},
		removed: map[string]bool{}, stems: map[string]int{}, rng: rng}
}

func (c *Collector) count(m map[string]uint64, key string) {
	if _, ok := m[key]; !ok && len(m) >= MaxTracked {
		c.r.Truncated = true
		return
	}
	m[key]++
}

func (c *Collector) candidate(p string) {
	if compressed[Ext(p)] {
		return
	}
	c.seen++
	if len(c.pool) < candidatePool {
		c.pool = append(c.pool, p)
		return
	}
	if j := c.rng.IntN(c.seen); j < candidatePool {
		c.pool[j] = p
	}
}

// Add takes one change of `restic diff`. Directories and metadata-only
// changes do not count.
func (c *Collector) Add(ch restic.DiffChange) {
	p := ch.Path
	if strings.HasSuffix(p, "/") || (c.Skip != nil && c.Skip(p)) {
		return
	}
	switch {
	case ch.Modifier == "+":
		c.r.Added++
		if e := Ext(p); e != "" {
			c.count(c.extensions, e)
			if noteExtensions[e] {
				c.count(c.names, path.Base(p))
			}
		}
		if len(c.added) < MaxTracked {
			c.added = append(c.added, p)
		} else {
			c.r.Truncated = true
		}
		c.candidate(p)
	case ch.Modifier == "-":
		if c.Within != nil && !c.Within(p) {
			return
		}
		c.r.Removed++
		if len(c.removed) < MaxTracked {
			dir, base := path.Split(p)
			c.removed[dir+base] = true
			c.stems[dir+stem(base)]++
		} else {
			c.r.Truncated = true
		}
	case strings.ContainsAny(ch.Modifier, "MT"):
		c.r.Modified++
		if e := Ext(p); e != "" {
			c.count(c.extensions, e)
		}
		c.candidate(p)
	}
}

// renames pairs added files with removed ones in the same folder whose name
// got an extension appended (a.docx -> a.docx.locked) or replaced
// (a.docx -> a.crypt). Each removed file pairs once.
func (c *Collector) renames() uint64 {
	var n uint64
	for _, p := range c.added {
		dir, base := path.Split(p)
		if before := dir + stem(base); stem(base) != base && c.removed[before] {
			delete(c.removed, before)
			if k := dir + stem(stem(base)); c.stems[k] > 0 {
				c.stems[k]--
			}
			n++
			continue
		}
		key := dir + stem(base)
		if c.stems[key] > 0 && !c.removed[dir+base] {
			c.stems[key]--
			n++
		}
	}
	return n
}

func top(m map[string]uint64, limit int) []Count {
	out := make([]Count, 0, len(m))
	for v, n := range m {
		out = append(out, Count{Value: v, Count: n})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Value < out[j].Value
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// Candidates are the paths to measure: at most EntropySamples of the new or
// changed files, picked at random, compressed formats left out.
func (c *Collector) Candidates() []string {
	pool := append([]string(nil), c.pool...)
	c.rng.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
	return pool
}

// Report is the summary; samples are the measured files.
func (c *Collector) Report(samples []Sample) Report {
	r := c.r
	r.V = Version
	r.Renamed = c.renames()
	r.Extensions = top(c.extensions, MaxExtensions)
	r.Names = top(c.names, MaxNames)
	if samples == nil {
		samples = []Sample{}
	}
	if len(samples) > EntropySamples {
		samples = samples[:EntropySamples]
	}
	r.Entropy = samples
	return r
}

// Entropy is the Shannon entropy of data in bits per byte (0 to 8).
func Entropy(data []byte) float64 {
	if len(data) == 0 {
		return 0
	}
	var counts [256]int
	for _, b := range data {
		counts[b]++
	}
	n := float64(len(data))
	var bits float64
	for _, k := range counts {
		if k > 0 {
			p := float64(k) / n
			bits -= p * math.Log2(p)
		}
	}
	return math.Round(bits*1000) / 1000
}
