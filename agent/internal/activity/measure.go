package activity

import (
	"errors"
	"io"
	"os"
)

// SampleBytes is the size of the windows measured at the start and the end.
const SampleBytes = 64 << 10

// Measure reads the first and the last SampleBytes of a regular file (local
// is where it is on disk, report how the snapshot names it). Nothing else of
// the file is read.
func Measure(local, report string) (Sample, error) {
	f, err := os.Open(local)
	if err != nil {
		return Sample{}, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return Sample{}, err
	}
	if !fi.Mode().IsRegular() {
		return Sample{}, errors.New("not a regular file")
	}
	size := fi.Size()
	if size == 0 {
		return Sample{}, errors.New("empty file")
	}
	head := make([]byte, min(size, SampleBytes))
	if _, err := io.ReadFull(f, head); err != nil {
		return Sample{}, err
	}
	s := Sample{Path: report, Ext: Ext(report), Size: size, Head: Entropy(head)}
	if size > SampleBytes {
		tail := make([]byte, min(size-SampleBytes, SampleBytes))
		if _, err := f.ReadAt(tail, size-int64(len(tail))); err != nil && !errors.Is(err, io.EOF) {
			return Sample{}, err
		}
		t := Entropy(tail)
		s.Tail = &t
	}
	return s, nil
}

// MeasureAll measures the candidates, local maps a snapshot path to the file
// on disk; files that cannot be read are skipped. stop ends early (a
// cancelled run).
func MeasureAll(candidates []string, local func(string) string, stop func() bool) []Sample {
	out := []Sample{}
	for _, p := range candidates {
		if len(out) >= EntropySamples || (stop != nil && stop()) {
			break
		}
		if s, err := Measure(local(p), p); err == nil {
			out = append(out, s)
		}
	}
	return out
}
