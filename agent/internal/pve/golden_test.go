package pve

import (
	"bytes"
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"
)

// The wire formats are shared with the server (packages/core/src/pve/formats.ts,
// whose tests read the same golden files). Run with UPDATE_GOLDEN=1 to rewrite.
func TestGoldenFormats(t *testing.T) {
	h := NewHashList(2*BlockSize + 10)
	h.Flags[0] = FlagPresent
	h.Hashes[0] = sha256.Sum256([]byte("block zero"))
	h.Flags[1] = FlagZero
	h.Flags[2] = FlagPresent
	h.Hashes[2] = sha256.Sum256([]byte("short"))
	var frame bytes.Buffer
	if err := EncodeFrame(&frame, []FrameBlock{
		{Device: "drive-scsi0", Index: 2, Length: 5, Data: []byte("short"), SHA256: sha256.Sum256([]byte("short"))},
		{Device: "drive-scsi0", Index: 1, Zero: true, Length: BlockSize},
	}); err != nil {
		t.Fatal(err)
	}
	golden := map[string][]byte{"hashes.bin": h.Encode(), "frame.bin": frame.Bytes()}
	for name, got := range golden {
		path := filepath.Join("testdata", name)
		if os.Getenv("UPDATE_GOLDEN") == "1" {
			if err := os.WriteFile(path, got, 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		want, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("%s changed; the server's decoder must change with it", name)
		}
	}
}
