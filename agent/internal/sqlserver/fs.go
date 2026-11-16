package sqlserver

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf16"
)

// FS is what the flows need from the file system. The Windows implementation
// (fs_windows.go) sets real DACLs; the tests use sqlfake.FS.
type FS interface {
	// FreeBytes is what the agent may still write on the volume of path
	// (GetDiskFreeSpaceExW); path or one of its parents must exist.
	FreeBytes(path string) (uint64, error)
	// MkdirWithSIDs creates dir and its parents and gives dir a protected
	// DACL: full control for SYSTEM and the Administrators, Modify for each
	// SID in modify, inherited by everything below.
	MkdirWithSIDs(dir string, modify []string) error
	// SetReadSIDs gives an existing folder a protected DACL with full control
	// for SYSTEM and the Administrators and Read for each SID in read,
	// inherited by everything below (SQL Server reads a fetched backup).
	SetReadSIDs(dir string, read []string) error
	// PrepareStagingRoot makes a job's own staging folder the agent's (its
	// parent trusted, the folder created by the agent or empty, owner and
	// DACL trusted, the marker file in it) and returns its resolved path;
	// a folder that holds files without the marker is refused.
	PrepareStagingRoot(root string) (string, error)
	// RemoveAll removes path and everything below it.
	RemoveAll(path string) error
	// SHA256File hashes a file (hex) and returns its size.
	SHA256File(ctx context.Context, path string) (string, int64, error)
	// ReadFile and WriteFile read and replace a small file of the agent (the
	// journal); WriteFile replaces it atomically. ReadFile of a missing file
	// returns an error that matches os.ErrNotExist.
	ReadFile(path string) ([]byte, error)
	WriteFile(path string, data []byte) error
	// Volume describes the volume of path and the first reparse point on
	// its way.
	Volume(path string) (VolumeFacts, error)
}

// StagingMarker is the file that marks a job's staging folder as the
// agent's; StagingMarkerText is its content.
const (
	StagingMarker     = ".restow-sql-staging"
	StagingMarkerText = "This folder is the SQL Server staging folder of the Restow agent. The agent deletes what it writes here.\r\n"
)

// ServiceSID is the SID Windows gives a service (NT SERVICE\<name>):
// S-1-5-80 followed by the SHA-1 of the upper-case name in UTF-16LE, as five
// little-endian 32-bit numbers. It needs no lookup, so the DACL of a staging
// folder can be set before the service ever ran.
func ServiceSID(service string) (string, error) {
	if service == "" || strings.ContainsAny(service, `\/`) || len(service) > 256 {
		return "", fmt.Errorf("invalid service name %q", service)
	}
	u := utf16.Encode([]rune(strings.ToUpper(service)))
	b := make([]byte, 2*len(u))
	for i, c := range u {
		binary.LittleEndian.PutUint16(b[2*i:], c)
	}
	sum := sha1.Sum(b)
	parts := []string{"S-1-5-80"}
	for i := 0; i < 5; i++ {
		parts = append(parts, fmt.Sprint(binary.LittleEndian.Uint32(sum[4*i:])))
	}
	return strings.Join(parts, "-"), nil
}

// sidRe-free check of a SID in SDDL: S-1- and digits and dashes only.
func validSID(sid string) bool {
	if !strings.HasPrefix(sid, "S-1-") || len(sid) > 184 {
		return false
	}
	for _, c := range sid[4:] {
		if (c < '0' || c > '9') && c != '-' {
			return false
		}
	}
	return true
}

// Access masks of the staging DACLs.
const (
	// accessModify is Modify (read, write, execute, delete; no change of
	// permissions or owner).
	accessModify = "0x1301bf"
	// accessReadExecute is Read and Execute (list, traverse, read).
	accessReadExecute = "0x1200a9"
)

// StagingSDDL is the protected DACL of a staging folder: full control for
// SYSTEM and the Administrators, the given access for each SID, all
// inherited by files and folders below.
func StagingSDDL(access string, sids []string) (string, error) {
	var b strings.Builder
	b.WriteString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	for _, sid := range sids {
		if !validSID(sid) {
			return "", fmt.Errorf("invalid SID %q", sid)
		}
		fmt.Fprintf(&b, "(A;OICI;%s;;;%s)", access, sid)
	}
	return b.String(), nil
}

// ModifySDDL and ReadSDDL are StagingSDDL for SQL Server writing and
// reading backup files.
func ModifySDDL(sids []string) (string, error) { return StagingSDDL(accessModify, sids) }

// ReadSDDL is the DACL of a folder with fetched backups.
func ReadSDDL(sids []string) (string, error) { return StagingSDDL(accessReadExecute, sids) }

// hashFile is the SHA-256 of a local file, stopping when ctx ends.
func hashFile(ctx context.Context, path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	buf := make([]byte, 1<<20)
	var n int64
	for {
		if err := ctx.Err(); err != nil {
			return "", 0, err
		}
		k, rerr := f.Read(buf)
		if k > 0 {
			h.Write(buf[:k])
			n += int64(k)
		}
		if errors.Is(rerr, io.EOF) {
			break
		}
		if rerr != nil {
			return "", 0, rerr
		}
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}
