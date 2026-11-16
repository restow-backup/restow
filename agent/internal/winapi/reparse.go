package winapi

import (
	"encoding/binary"
	"errors"
	"unicode/utf16"
)

// Reparse tags the agent tells apart (winnt.h). A tag with the name-surrogate
// bit names another file or folder (link, junction, mount point); tags
// without it (deduplication, cloud files, WOF) are ordinary files to readers.
const (
	ReparseTagMountPoint    = 0xA0000003 // junction or volume mount point
	ReparseTagSymlink       = 0xA000000C
	ReparseTagNameSurrogate = 0x20000000
)

// ParseReparseData reads the tag and, for a mount point (junction or mounted
// volume) or a symbolic link, the substitute name (\??\C:\target,
// \??\Volume{guid}\) of a REPARSE_DATA_BUFFER as FSCTL_GET_REPARSE_POINT
// returns it
// (https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_reparse_data_buffer).
// Other tags come back without a name. It has no build tag, so it is tested
// on every system.
func ParseReparseData(buf []byte) (tag uint32, substitute string, err error) {
	if len(buf) < 8 {
		return 0, "", errors.New("reparse data too short")
	}
	tag = binary.LittleEndian.Uint32(buf)
	var pathStart int
	switch tag {
	case ReparseTagMountPoint:
		pathStart = 16
	case ReparseTagSymlink:
		pathStart = 20 // after the 4 bytes of Flags
	default:
		return tag, "", nil
	}
	if len(buf) < pathStart {
		return tag, "", errors.New("reparse data too short")
	}
	off := int(binary.LittleEndian.Uint16(buf[8:]))
	n := int(binary.LittleEndian.Uint16(buf[10:]))
	start, end := pathStart+off, pathStart+off+n
	if n%2 != 0 || end > len(buf) {
		return tag, "", errors.New("reparse data names a path outside the buffer")
	}
	u := make([]uint16, n/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(buf[start+2*i:])
	}
	return tag, string(utf16.Decode(u)), nil
}
