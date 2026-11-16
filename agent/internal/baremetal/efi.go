package baremetal

import (
	"bytes"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode/utf16"
)

// GUIDs of the EFI variables the capture reads (docs/BAREMETAL.md, 4.1:
// an allow-list; nothing else under efivars is read).
const (
	EFIGlobalGUID    = "8be4df61-93ca-11d2-aa0d-00e098032b8c"
	EFISecDBGUID     = "d719b2cb-3d3a-4596-a3bc-dad00e67656f"
	ShimLockGUID     = "605dab50-e046-4300-abb6-3dd810dd8b23"
	certX509GUID     = "a5c059a1-94e4-4aa7-87b5-ab155c2bf072"
	certSHA256GUID   = "c1c41626-504c-4092-aca9-41f936934328"
	loadOptionActive = 0x00000001
)

// ParseEFIVar splits an efivarfs file into its attributes and value.
func ParseEFIVar(b []byte) (uint32, []byte, error) {
	if len(b) < 4 {
		return 0, nil, errors.New("efi variable: shorter than its attributes")
	}
	return binary.LittleEndian.Uint32(b[:4]), b[4:], nil
}

// LoadOption is a decoded EFI_LOAD_OPTION (a Boot#### variable).
type LoadOption struct {
	Attributes  uint32
	Description string
	PartNumber  uint32
	PartUUID    string
	// Path is the file path node, as the firmware stores it (\EFI\...).
	Path string
}

// Active reports LOAD_OPTION_ACTIVE.
func (o LoadOption) Active() bool { return o.Attributes&loadOptionActive != 0 }

// ParseLoadOption decodes EFI_LOAD_OPTION (UEFI 2.10, 3.1.3): attributes,
// the length of the device path list, the UTF-16 description, then device
// path nodes; of those the hard drive node (partition number and GPT
// signature) and the file path node are kept.
func ParseLoadOption(b []byte) (LoadOption, error) {
	var o LoadOption
	if len(b) < 6 {
		return o, errors.New("load option: too short")
	}
	o.Attributes = binary.LittleEndian.Uint32(b[0:4])
	fpLen := int(binary.LittleEndian.Uint16(b[4:6]))
	i := 6
	var desc []uint16
	for {
		if i+2 > len(b) {
			return o, errors.New("load option: unterminated description")
		}
		c := binary.LittleEndian.Uint16(b[i : i+2])
		i += 2
		if c == 0 {
			break
		}
		desc = append(desc, c)
	}
	o.Description = string(utf16.Decode(desc))
	if i+fpLen > len(b) {
		return o, errors.New("load option: device path beyond the variable")
	}
	dp := b[i : i+fpLen]
	for j := 0; j+4 <= len(dp); {
		typ, sub := dp[j], dp[j+1]
		n := int(binary.LittleEndian.Uint16(dp[j+2 : j+4]))
		if n < 4 || j+n > len(dp) {
			return o, errors.New("load option: bad device path node")
		}
		node := dp[j+4 : j+n]
		switch {
		case typ == 0x7f && sub == 0xff:
			return o, nil
		case typ == 0x04 && sub == 0x01 && len(node) >= 38:
			// Hard drive: number, start, size, signature, MBR type, signature type.
			o.PartNumber = binary.LittleEndian.Uint32(node[0:4])
			if node[37] == 0x02 {
				o.PartUUID = guidString(node[20:36])
			}
		case typ == 0x04 && sub == 0x04:
			o.Path = utf16String(node)
		}
		j += n
	}
	return o, nil
}

// Attributes of EFI variables (UEFI 2.10, 8.2).
const (
	EFIVarNonVolatile       = 0x00000001
	EFIVarBootserviceAccess = 0x00000002
	EFIVarRuntimeAccess     = 0x00000004
	// LoadOptionActive is LOAD_OPTION_ACTIVE of a Boot#### variable.
	LoadOptionActive = loadOptionActive
)

// LoadOptionPartition is the partition a Boot#### entry points to: its
// number, start and size in LBA of the disk, and either the GPT PARTUUID
// or the 32-bit MBR disk signature.
type LoadOptionPartition struct {
	Number   int64
	StartLBA uint64
	SizeLBA  uint64
	PartUUID string
	MBRSig   *uint32
}

// BuildLoadOption encodes an EFI_LOAD_OPTION (UEFI 2.10, 3.1.3): the
// attributes, the length of the device path list, the description as
// NUL-terminated UTF-16LE, then a hard drive node (type 4, subtype 1), a
// file path node (4/4) with the loader path in back-slash form and an end
// node. recover writes it as Boot#### (efivars_linux.go); ParseLoadOption
// reads it back.
func BuildLoadOption(attrs uint32, label string, part LoadOptionPartition, loaderPath string) ([]byte, error) {
	hd := make([]byte, 42)
	hd[0], hd[1] = 0x04, 0x01
	binary.LittleEndian.PutUint16(hd[2:4], 42)
	if part.Number <= 0 || part.Number > 0xffffffff {
		return nil, fmt.Errorf("load option: partition number %d", part.Number)
	}
	binary.LittleEndian.PutUint32(hd[4:8], uint32(part.Number))
	binary.LittleEndian.PutUint64(hd[8:16], part.StartLBA)
	binary.LittleEndian.PutUint64(hd[16:24], part.SizeLBA)
	switch {
	case part.PartUUID != "":
		g, err := encodeGUID(part.PartUUID)
		if err != nil {
			return nil, err
		}
		copy(hd[24:40], g)
		hd[40], hd[41] = 0x02, 0x02 // GPT, GUID signature
	case part.MBRSig != nil:
		binary.LittleEndian.PutUint32(hd[24:28], *part.MBRSig)
		hd[40], hd[41] = 0x01, 0x01 // MBR, 32-bit signature
	default:
		return nil, errors.New("load option: neither a PARTUUID nor an MBR signature")
	}
	p := strings.ReplaceAll(loaderPath, "/", `\`)
	if !strings.HasPrefix(p, `\`) {
		p = `\` + p
	}
	if strings.ContainsRune(p, 0) || strings.Contains(p, `\..\`) {
		return nil, fmt.Errorf("load option: invalid loader path %q", loaderPath)
	}
	fp := utf16Z(p)
	file := make([]byte, 4, 4+len(fp))
	file[0], file[1] = 0x04, 0x04
	binary.LittleEndian.PutUint16(file[2:4], uint16(4+len(fp)))
	file = append(file, fp...)
	end := []byte{0x7f, 0xff, 0x04, 0x00}
	dp := append(append(append([]byte{}, hd...), file...), end...)
	if len(dp) > 0xffff || len(label) > 1024 {
		return nil, errors.New("load option: too long")
	}
	out := make([]byte, 6, 6+2*len(label)+2+len(dp))
	binary.LittleEndian.PutUint32(out[0:4], attrs)
	binary.LittleEndian.PutUint16(out[4:6], uint16(len(dp)))
	out = append(out, utf16Z(label)...)
	return append(out, dp...), nil
}

// utf16Z is s as UTF-16LE with a terminating NUL.
func utf16Z(s string) []byte {
	u := utf16.Encode([]rune(s))
	b := make([]byte, 0, 2*len(u)+2)
	for _, c := range u {
		b = binary.LittleEndian.AppendUint16(b, c)
	}
	return append(b, 0, 0)
}

// guidBytes encodes a GUID the way guidString reads it.
func encodeGUID(s string) ([]byte, error) {
	raw, err := hex.DecodeString(strings.ReplaceAll(s, "-", ""))
	if err != nil || len(raw) != 16 || len(s) != 36 {
		return nil, fmt.Errorf("invalid GUID %q", s)
	}
	out := make([]byte, 16)
	binary.LittleEndian.PutUint32(out[0:4], binary.BigEndian.Uint32(raw[0:4]))
	binary.LittleEndian.PutUint16(out[4:6], binary.BigEndian.Uint16(raw[4:6]))
	binary.LittleEndian.PutUint16(out[6:8], binary.BigEndian.Uint16(raw[6:8]))
	copy(out[8:], raw[8:])
	return out, nil
}

// EncodeBootOrder encodes BootOrder (a list of UINT16).
func EncodeBootOrder(order []int64) []byte {
	b := make([]byte, 0, 2*len(order))
	for _, n := range order {
		b = binary.LittleEndian.AppendUint16(b, uint16(n))
	}
	return b
}

func utf16String(b []byte) string {
	u := make([]uint16, 0, len(b)/2)
	for k := 0; k+1 < len(b); k += 2 {
		c := binary.LittleEndian.Uint16(b[k : k+2])
		if c == 0 {
			break
		}
		u = append(u, c)
	}
	return string(utf16.Decode(u))
}

// guidString formats an EFI GUID (the first three fields little endian).
func guidString(b []byte) string {
	if len(b) < 16 {
		return ""
	}
	return fmt.Sprintf("%08x-%04x-%04x-%x-%x", binary.LittleEndian.Uint32(b[0:4]), binary.LittleEndian.Uint16(b[4:6]),
		binary.LittleEndian.Uint16(b[6:8]), b[8:10], b[10:16])
}

// ParseBootOrder decodes BootOrder (a list of UINT16).
func ParseBootOrder(b []byte) []int64 {
	out := []int64{}
	for i := 0; i+1 < len(b); i += 2 {
		out = append(out, int64(binary.LittleEndian.Uint16(b[i:i+2])))
	}
	return out
}

// SignatureList is what a signature database (db, dbx, MokListRT) holds.
type SignatureList struct {
	// Certs are the X.509 certificates: subject and SHA-256 of the DER.
	Certs []CertRef
	// Hashes are the EFI_CERT_SHA256 entries, lower-case hex.
	Hashes []string
}

// ParseSignatureList decodes a sequence of EFI_SIGNATURE_LIST (UEFI 2.10,
// 32.4.1).
func ParseSignatureList(b []byte) (SignatureList, error) {
	var out SignatureList
	for len(b) > 0 {
		if len(b) < 28 {
			return out, errors.New("signature list: truncated header")
		}
		typ := guidString(b[0:16])
		listSize := int(binary.LittleEndian.Uint32(b[16:20]))
		hdrSize := int(binary.LittleEndian.Uint32(b[20:24]))
		sigSize := int(binary.LittleEndian.Uint32(b[24:28]))
		if listSize < 28 || listSize > len(b) || sigSize < 16 || 28+hdrSize > listSize {
			return out, errors.New("signature list: bad sizes")
		}
		body := b[28+hdrSize : listSize]
		for k := 0; k+sigSize <= len(body); k += sigSize {
			data := body[k+16 : k+sigSize]
			switch typ {
			case certX509GUID:
				sum := sha256.Sum256(data)
				subject := ""
				if c, err := x509.ParseCertificate(data); err == nil {
					subject = c.Subject.String()
				}
				out.Certs = append(out.Certs, CertRef{Subject: cleanString(subject, maxStringBytes), SHA256: hex.EncodeToString(sum[:])})
			case certSHA256GUID:
				out.Hashes = append(out.Hashes, hex.EncodeToString(data))
			}
		}
		b = b[listSize:]
	}
	return out, nil
}

// HashListSHA256 is the SHA-256 over the sorted 32-byte hashes (dbxSha256):
// two machines with the same revocation list have the same value.
func HashListSHA256(hashes []string) string {
	sorted := append([]string(nil), hashes...)
	sort.Strings(sorted)
	h := sha256.New()
	for _, x := range sorted {
		if raw, err := hex.DecodeString(x); err == nil {
			h.Write(raw)
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

// ParseSbatLevel splits SbatLevelRT into its lines (empty lines and NUL
// padding dropped; the schema keeps one entry per line).
func ParseSbatLevel(b []byte) []string {
	b = bytes.TrimRight(b, "\x00")
	out := []string{}
	for _, l := range strings.Split(string(b), "\n") {
		if l = strings.TrimSpace(strings.Trim(l, "\x00")); l != "" {
			out = append(out, cleanString(l, maxSbatBytes))
		}
	}
	return out
}
