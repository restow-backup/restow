package dbprobe

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"time"

	"github.com/restow-backup/restow/agent/internal/api"
)

// An SQLite database is a file recognised by its header "SQLite format 3\0"
// (docs/DATABASES.md 3.1). Its identity is its path, device and inode, and its
// birth time where the system has one (3.3): a replaced file is another
// database. The agent only reads the header here; the backup through the
// online backup API comes with D5.

var sqliteMagic = []byte("SQLite format 3\x00")

// errNotSQLite: the file is no SQLite database.
var errNotSQLite = errors.New("the file is not an SQLite 3 database")

// errNotRegular: the path is a link, a device, a pipe or a directory. The
// agent opens only a regular file: a link could lead it to a file the
// administrator did not name, and a pipe or device could block the probe.
var errNotRegular = errors.New("the path is not a regular file (links, devices and pipes are not opened)")

func probeSQLite(path string) (*api.DBSQLiteFacts, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() {
		return nil, errNotRegular
	}
	f, err := openNoFollow(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	// The file opened is the file looked at (not replaced in between).
	if !info.Mode().IsRegular() || !os.SameFile(before, info) {
		return nil, errNotRegular
	}
	header := make([]byte, 100)
	if _, err := io.ReadFull(f, header); err != nil {
		return nil, errNotSQLite
	}
	if !bytes.Equal(header[:16], sqliteMagic) {
		return nil, errNotSQLite
	}
	pageSize := int(binary.BigEndian.Uint16(header[16:18]))
	if pageSize == 1 {
		pageSize = 65536
	}
	facts := &api.DBSQLiteFacts{Path: path, SizeBytes: info.Size(), PageSize: pageSize}
	modified := info.ModTime().UTC().Format(time.RFC3339)
	facts.ModifiedAt = &modified
	facts.Inode, facts.Device, facts.CreatedAt = fileIdentity(f, info)
	return facts, nil
}
