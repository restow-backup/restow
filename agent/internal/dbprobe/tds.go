package dbprobe

import (
	"encoding/binary"
	"fmt"
)

// SQL Server is recognised by its answer to a TDS PRELOGIN: a packet of type
// 0x12 with the options VERSION, ENCRYPTION, INSTOPT, THREADID and MARS; the
// server answers with type 0x04 and its own VERSION and ENCRYPTION. Nothing
// signs in here: the sign-in to SQL Server stays with the native backup of
// the agent on its machine until it moves into the module (D5).

const (
	tdsPrelogin      = 0x12
	tdsTabularResult = 0x04
	tdsTerminator    = 0xff
	tdsEncryptNotSup = 0x02
)

func tdsPreloginPacket() []byte {
	options := []struct {
		token byte
		data  []byte
	}{
		{0x00, []byte{0, 0, 0, 0, 0, 0}},
		{0x01, []byte{tdsEncryptNotSup}},
		{0x02, []byte{0}},
		{0x03, []byte{0, 0, 0, 0}},
		{0x04, []byte{0}},
	}
	headerLen := len(options)*5 + 1
	header := make([]byte, headerLen)
	var data []byte
	off := headerLen
	for i, o := range options {
		header[i*5] = o.token
		binary.BigEndian.PutUint16(header[i*5+1:], uint16(off))
		binary.BigEndian.PutUint16(header[i*5+3:], uint16(len(o.data)))
		off += len(o.data)
		data = append(data, o.data...)
	}
	header[headerLen-1] = tdsTerminator
	payload := append(header, data...)
	packet := []byte{tdsPrelogin, 0x01, 0, 0, 0, 0, 0x01, 0x00}
	binary.BigEndian.PutUint16(packet[2:], uint16(len(payload)+8))
	return append(packet, payload...)
}

var tdsEncryption = []string{"off", "on", "not_supported", "required"}

// parseTDSPrelogin reads a PRELOGIN answer (header included); ok false when it is none.
func parseTDSPrelogin(packet []byte) (version, encryption string, ok bool) {
	if len(packet) < 9 || packet[0] != tdsTabularResult {
		return "", "", false
	}
	n := int(binary.BigEndian.Uint16(packet[2:4]))
	if n < 9 || n > len(packet) {
		return "", "", false
	}
	payload := packet[8:n]
	for i := 0; i < len(payload); i += 5 {
		token := payload[i]
		if token == tdsTerminator {
			break
		}
		if i+5 > len(payload) {
			return "", "", false
		}
		off := int(binary.BigEndian.Uint16(payload[i+1:]))
		size := int(binary.BigEndian.Uint16(payload[i+3:]))
		if off+size > len(payload) {
			return "", "", false
		}
		data := payload[off : off+size]
		switch {
		case token == 0x00 && size >= 4:
			version = fmt.Sprintf("%d.%d.%d", data[0], data[1], binary.BigEndian.Uint16(data[2:4]))
			ok = true
		case token == 0x01 && size >= 1 && int(data[0]) < len(tdsEncryption):
			encryption = tdsEncryption[data[0]]
		}
	}
	return version, encryption, ok
}
