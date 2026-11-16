package baremetal

import (
	"bytes"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"debug/pe"
	"encoding/asn1"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
)

// maxLoaderBytes bounds the PE files the capture reads (a UKI with its
// initrd is rarely above 128 MiB).
const maxLoaderBytes = 256 << 20

// LoaderInfo is what InspectLoader reads from a PE file.
type LoaderInfo struct {
	Bytes              int64
	Sections           []string
	AuthenticodeSha256 string
	Signer             *Signer
	Sbat               []string
	UKI                bool
	// UKICmdline is the embedded .cmdline, redacted.
	UKICmdline string
	// OSRelease is the embedded .osrel (UKI), as key=value text.
	OSRelease string
}

// InspectLoader reads a PE/COFF image (shim, GRUB, systemd-boot, a UKI, a
// signed kernel): its sections, the Authenticode SHA-256 (the PE image hash
// that Secure Boot compares: the checksum field, the certificate table
// entry and the certificate data are not hashed), the signer from the
// PKCS#7 SignedData in WIN_CERTIFICATE, and the .sbat, .linux and .cmdline
// sections of a UKI.
func InspectLoader(r io.ReaderAt, size int64) (LoaderInfo, error) {
	info := LoaderInfo{Bytes: size}
	if size > maxLoaderBytes {
		return info, fmt.Errorf("PE file of %d bytes is larger than %d", size, maxLoaderBytes)
	}
	f, err := pe.NewFile(io.NewSectionReader(r, 0, size))
	if err != nil {
		return info, fmt.Errorf("not a PE file: %w", err)
	}
	defer f.Close()
	for _, s := range f.Sections {
		info.Sections = append(info.Sections, s.Name)
		switch s.Name {
		case ".linux":
			info.UKI = true
		case ".sbat":
			if b, err := sectionData(s, 1<<20); err == nil {
				info.Sbat = sbatLines(b)
			}
		case ".cmdline":
			if b, err := sectionData(s, 64<<10); err == nil {
				info.UKICmdline = RedactCmdline(strings.TrimSpace(string(bytes.TrimRight(b, "\x00"))))
			}
		case ".osrel":
			if b, err := sectionData(s, 64<<10); err == nil {
				info.OSRelease = string(bytes.TrimRight(b, "\x00"))
			}
		}
	}
	sum, certOff, certSize, err := authenticodeHash(r, size, f)
	if err != nil {
		return info, err
	}
	info.AuthenticodeSha256 = sum
	if certSize > 0 {
		if s, err := signerOf(r, certOff, certSize); err == nil {
			info.Signer = s
		}
	}
	return info, nil
}

func sectionData(s *pe.Section, max int) ([]byte, error) {
	n := int(s.Size)
	if s.VirtualSize > 0 && int(s.VirtualSize) < n {
		n = int(s.VirtualSize)
	}
	if n > max {
		n = max
	}
	b := make([]byte, n)
	_, err := s.ReadAt(b, 0)
	if err != nil && err != io.EOF {
		return nil, err
	}
	return b, nil
}

func sbatLines(b []byte) []string {
	out := []string{}
	for _, l := range strings.Split(string(bytes.TrimRight(b, "\x00")), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, cleanString(l, maxStringBytes))
		}
	}
	return out
}

// authenticodeHash computes the PE image hash (Windows Authenticode PE
// specification, "Calculating the PE Image Hash").
func authenticodeHash(r io.ReaderAt, size int64, f *pe.File) (string, int64, int64, error) {
	var lfanew [4]byte
	if _, err := r.ReadAt(lfanew[:], 0x3c); err != nil {
		return "", 0, 0, err
	}
	peOff := int64(binary.LittleEndian.Uint32(lfanew[:]))
	optOff := peOff + 4 + 20
	var checksumOff, certEntryOff int64
	var sizeOfHeaders uint32
	var certVA, certLen uint32
	switch oh := f.OptionalHeader.(type) {
	case *pe.OptionalHeader32:
		checksumOff, certEntryOff, sizeOfHeaders = optOff+64, optOff+128, oh.SizeOfHeaders
		if oh.NumberOfRvaAndSizes > 4 {
			certVA, certLen = oh.DataDirectory[4].VirtualAddress, oh.DataDirectory[4].Size
		} else {
			certEntryOff = -1
		}
	case *pe.OptionalHeader64:
		checksumOff, certEntryOff, sizeOfHeaders = optOff+64, optOff+144, oh.SizeOfHeaders
		if oh.NumberOfRvaAndSizes > 4 {
			certVA, certLen = oh.DataDirectory[4].VirtualAddress, oh.DataDirectory[4].Size
		} else {
			certEntryOff = -1
		}
	default:
		return "", 0, 0, errors.New("PE file without optional header")
	}
	h := sha256.New()
	hashRange := func(from, to int64) error {
		if to < from {
			return errors.New("PE file: overlapping ranges")
		}
		if to > size {
			return errors.New("PE file: range beyond the end")
		}
		_, err := io.Copy(h, io.NewSectionReader(r, from, to-from))
		return err
	}
	if certEntryOff < 0 {
		if err := hashRange(0, checksumOff); err != nil {
			return "", 0, 0, err
		}
		if err := hashRange(checksumOff+4, int64(sizeOfHeaders)); err != nil {
			return "", 0, 0, err
		}
	} else {
		if err := hashRange(0, checksumOff); err != nil {
			return "", 0, 0, err
		}
		if err := hashRange(checksumOff+4, certEntryOff); err != nil {
			return "", 0, 0, err
		}
		if err := hashRange(certEntryOff+8, int64(sizeOfHeaders)); err != nil {
			return "", 0, 0, err
		}
	}
	hashed := int64(sizeOfHeaders)
	secs := append([]*pe.Section(nil), f.Sections...)
	sort.Slice(secs, func(i, j int) bool { return secs[i].Offset < secs[j].Offset })
	for _, s := range secs {
		if s.Size == 0 {
			continue
		}
		from, to := int64(s.Offset), int64(s.Offset)+int64(s.Size)
		if err := hashRange(from, to); err != nil {
			return "", 0, 0, err
		}
		hashed += int64(s.Size)
	}
	// Data after the sections, without the certificate table.
	end := size
	if certLen > 0 && int64(certVA)+int64(certLen) <= size {
		end = size - int64(certLen)
	}
	if end > hashed {
		if err := hashRange(hashed, end); err != nil {
			return "", 0, 0, err
		}
	}
	return hex.EncodeToString(h.Sum(nil)), int64(certVA), int64(certLen), nil
}

// signerOf reads the first WIN_CERTIFICATE of type PKCS_SIGNED_DATA and
// returns the certificate that signed it.
func signerOf(r io.ReaderAt, off, n int64) (*Signer, error) {
	if n < 8 || n > 1<<20 {
		return nil, errors.New("certificate table size")
	}
	buf := make([]byte, n)
	if _, err := r.ReadAt(buf, off); err != nil && err != io.EOF {
		return nil, err
	}
	length := int64(binary.LittleEndian.Uint32(buf[0:4]))
	certType := binary.LittleEndian.Uint16(buf[6:8])
	if certType != 0x0002 || length < 8 || length > n {
		return nil, errors.New("no PKCS#7 signature")
	}
	return pkcs7Signer(buf[8:length])
}

type contentInfo struct {
	ContentType asn1.ObjectIdentifier
	Content     asn1.RawValue `asn1:"explicit,optional,tag:0"`
}

type issuerAndSerial struct {
	Issuer asn1.RawValue
	Serial asn1.RawValue
}

// pkcs7Signer finds the signer of a PKCS#7 SignedData: the issuer and
// serial of the first SignerInfo, matched against the embedded
// certificates (RFC 2315, 9.1 and 9.2).
func pkcs7Signer(der []byte) (*Signer, error) {
	var ci contentInfo
	if _, err := asn1.Unmarshal(der, &ci); err != nil {
		return nil, err
	}
	// SignedData ::= SEQUENCE { version, digestAlgorithms SET, contentInfo,
	// certificates [0] IMPLICIT OPTIONAL, crls [1] IMPLICIT OPTIONAL, signerInfos SET }
	// With an explicit tag, encoding/asn1 hands over the inner SEQUENCE.
	sd := ci.Content
	if sd.Class != asn1.ClassUniversal || sd.Tag != asn1.TagSequence {
		if _, err := asn1.Unmarshal(ci.Content.Bytes, &sd); err != nil {
			return nil, err
		}
	}
	rest := sd.Bytes
	var elems []asn1.RawValue
	for len(rest) > 0 {
		var e asn1.RawValue
		var err error
		rest, err = asn1.Unmarshal(rest, &e)
		if err != nil {
			return nil, err
		}
		elems = append(elems, e)
	}
	var certs []*x509.Certificate
	var signerInfos []byte
	for _, e := range elems {
		switch {
		case e.Class == asn1.ClassContextSpecific && e.Tag == 0:
			certs, _ = x509.ParseCertificates(e.Bytes)
		case e.Class == asn1.ClassUniversal && e.Tag == asn1.TagSet:
			signerInfos = e.Bytes
		}
	}
	if signerInfos == nil {
		return nil, errors.New("no signer info")
	}
	var si asn1.RawValue
	if _, err := asn1.Unmarshal(signerInfos, &si); err != nil {
		return nil, err
	}
	var version int
	siRest, err := asn1.Unmarshal(si.Bytes, &version)
	if err != nil {
		return nil, err
	}
	var ias issuerAndSerial
	if _, err := asn1.Unmarshal(siRest, &ias); err != nil {
		return nil, err
	}
	var issuer pkix.RDNSequence
	if _, err := asn1.Unmarshal(ias.Issuer.FullBytes, &issuer); err != nil {
		return nil, err
	}
	serial := strings.ToLower(hex.EncodeToString(bytes.TrimLeft(ias.Serial.Bytes, "\x00")))
	var name pkix.Name
	name.FillFromRDNSequence(&issuer)
	for _, c := range certs {
		if bytes.Equal(c.RawIssuer, ias.Issuer.FullBytes) && strings.EqualFold(c.SerialNumber.Text(16), strings.TrimLeft(serial, "0")) {
			return &Signer{Issuer: cleanString(c.Issuer.String(), maxStringBytes), Subject: cleanString(c.Subject.String(), maxStringBytes), Serial: c.SerialNumber.Text(16)}, nil
		}
	}
	return &Signer{Issuer: cleanString(name.String(), maxStringBytes), Subject: "", Serial: strings.TrimLeft(serial, "0")}, nil
}

// subjectCN returns the CN= part of a subject, or the subject.
func subjectCN(s string) string {
	for _, part := range strings.Split(s, ",") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(part), "CN="); ok {
			return v
		}
	}
	return s
}
