package fssnap

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"

	"github.com/restow-backup/restow/agent/internal/activity"
)

// maxMeasureFile bounds the files the helper hashes.
const maxMeasureFile = 256 << 20

// HandleMeasure hashes and measures the requested files (inside the
// helper, after the chroot into the tree, so the hashes are of the content
// that was backed up; docs/BAREMETAL.md 5.6). A file that is not a regular
// file or whose size differs from restic's is left out.
func HandleMeasure(req MeasureRequest) MeasureResponse {
	resp := MeasureResponse{Sample: []SampleFile{}, Activity: []activity.Sample{}}
	for _, s := range req.Sample {
		st, err := os.Lstat(s.Path)
		if err != nil || !st.Mode().IsRegular() || st.Size() != s.Size || st.Size() > maxMeasureFile {
			continue
		}
		f, err := os.Open(s.Path)
		if err != nil {
			continue
		}
		h := sha256.New()
		n, err := io.Copy(h, f)
		f.Close()
		if err != nil || n != s.Size {
			continue
		}
		resp.Sample = append(resp.Sample, SampleFile{Path: s.Path, Size: n, SHA256: hex.EncodeToString(h.Sum(nil))})
	}
	if len(req.Activity) > 0 {
		resp.Activity = activity.MeasureAll(req.Activity, func(p string) string { return p }, func() bool { return false })
		if resp.Activity == nil {
			resp.Activity = []activity.Sample{}
		}
	}
	return resp
}
