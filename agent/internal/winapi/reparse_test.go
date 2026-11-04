package winapi

import (
	"encoding/binary"
	"testing"
	"unicode/utf16"
)

// reparseBuffer builds a REPARSE_DATA_BUFFER as NTFS returns it: the
// substitute name first, then the print name, each without a NUL.
func reparseBuffer(tag uint32, substitute, print string) []byte {
	sub, pr := utf16.Encode([]rune(substitute)), utf16.Encode([]rune(print))
	head := 8
	if tag == ReparseTagSymlink {
		head = 12
	}
	data := make([]byte, head+2*len(sub)+2*len(pr))
	binary.LittleEndian.PutUint16(data[0:], 0)
	binary.LittleEndian.PutUint16(data[2:], uint16(2*len(sub)))
	binary.LittleEndian.PutUint16(data[4:], uint16(2*len(sub)))
	binary.LittleEndian.PutUint16(data[6:], uint16(2*len(pr)))
	for i, c := range append(sub, pr...) {
		binary.LittleEndian.PutUint16(data[head+2*i:], c)
	}
	buf := make([]byte, 8+len(data))
	binary.LittleEndian.PutUint32(buf, tag)
	binary.LittleEndian.PutUint16(buf[4:], uint16(len(data)))
	copy(buf[8:], data)
	return buf
}

func TestParseReparseData(t *testing.T) {
	cases := []struct {
		buf  []byte
		tag  uint32
		name string
	}{
		{reparseBuffer(ReparseTagMountPoint, `\??\D:\Daten`, `D:\Daten`), ReparseTagMountPoint, `\??\D:\Daten`},
		{reparseBuffer(ReparseTagMountPoint, `\??\Volume{1a2b3c4d-0000-0000-0000-100000000000}\`, ""), ReparseTagMountPoint, `\??\Volume{1a2b3c4d-0000-0000-0000-100000000000}\`},
		{reparseBuffer(ReparseTagSymlink, `\??\C:\Users\Größe`, `C:\Users\Größe`), ReparseTagSymlink, `\??\C:\Users\Größe`},
	}
	for _, tc := range cases {
		tag, name, err := ParseReparseData(tc.buf)
		if err != nil || tag != tc.tag || name != tc.name {
			t.Errorf("%#x %q %v, want %#x %q", tag, name, err, tc.tag, tc.name)
		}
	}
	other := make([]byte, 8)
	binary.LittleEndian.PutUint32(other, 0x80000013)
	if tag, name, err := ParseReparseData(other); err != nil || tag != 0x80000013 || name != "" {
		t.Errorf("dedup: %#x %q %v", tag, name, err)
	}
	broken := reparseBuffer(ReparseTagMountPoint, `\??\D:\Daten`, "")
	binary.LittleEndian.PutUint16(broken[10:], 999)
	if _, _, err := ParseReparseData(broken); err == nil {
		t.Error("a name outside the buffer was read")
	}
	if _, _, err := ParseReparseData([]byte{1, 2}); err == nil {
		t.Error("a short buffer was read")
	}
}
