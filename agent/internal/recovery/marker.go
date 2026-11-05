package recovery

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"time"
)

// Marker of a recovery in progress (docs/BAREMETAL.md 10.18): written to
// the root file system of the target after the file systems exist,
// refreshed after every step and removed at the very end. It holds no
// secret.
const (
	MarkerPath   = "/.restow-recovery.json"
	MarkerFormat = "restow-recovery-marker-v1"
)

// Marker is the content of MarkerPath.
type Marker struct {
	Format       string    `json:"format"`
	SnapshotID   string    `json:"snapshotId"`
	LayoutSHA256 string    `json:"layoutSha256"`
	PlanSHA256   string    `json:"planSha256"`
	StartedAt    time.Time `json:"startedAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
	LastStep     int64     `json:"lastStep"`
	Phase        string    `json:"phase"`
	CleanStop    bool      `json:"cleanStop"`
}

// WriteMarker writes the marker (0600, root).
func WriteMarker(r Rootfs, m Marker) error {
	m.Format = MarkerFormat
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return r.WriteFileAtomic(MarkerPath, append(b, '\n'), 0o600, 0, 0, "")
}

// ReadMarker reads the marker; fs.ErrNotExist when there is none.
func ReadMarker(r Rootfs) (*Marker, error) {
	b, err := r.ReadFile(MarkerPath, 64<<10)
	if err != nil {
		return nil, err
	}
	var m Marker
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("marker: %v", err)
	}
	if m.Format != MarkerFormat {
		return nil, fmt.Errorf("marker: format %q", m.Format)
	}
	return &m, nil
}

// RemoveMarker removes the marker (missing is fine).
func RemoveMarker(r Rootfs) error {
	if err := r.Remove(MarkerPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// FindResumable returns the marker when it belongs to the same snapshot
// and layout (a recovery of this snapshot was started on these disks);
// nil when there is none or it belongs to another one.
func FindResumable(r Rootfs, snapshotID, layoutSHA256 string) (*Marker, error) {
	m, err := ReadMarker(r)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if m.SnapshotID != snapshotID || m.LayoutSHA256 != layoutSHA256 {
		return nil, nil
	}
	return m, nil
}

// ResumeMode is the planner's resume option for a marker: clean after a
// clean stop, unclean otherwise.
func ResumeMode(m *Marker) string {
	if m != nil && m.CleanStop {
		return "clean"
	}
	return "unclean"
}
