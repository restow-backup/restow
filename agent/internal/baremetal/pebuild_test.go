package baremetal

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/binary"
	"math/big"
	"sort"
	"time"
)

// Synthetic PE images for the tests (docs/BAREMETAL.md 21.1 asks for real
// shim, GRUB and UKI files; until those recordings exist the tests build a
// minimal PE32+ with the sections that matter and an Authenticode
// signature from a test certificate, deterministically).

type peSection struct {
	name string
	data []byte
}

// testSigner is a deterministic certificate (Ed25519 signatures do not use
// randomness).
type testSigner struct {
	cert *x509.Certificate
	der  []byte
}

func newTestSigner(cn, issuerCN string, serial int64, seed byte) testSigner {
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{seed}, 32))
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(serial),
		Subject:      pkix.Name{CommonName: cn, Organization: []string{"Restow Test"}},
		Issuer:       pkix.Name{CommonName: issuerCN, Organization: []string{"Restow Test"}},
		NotBefore:    time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:     time.Date(2044, 1, 1, 0, 0, 0, 0, time.UTC),
	}
	parent := &x509.Certificate{Subject: tmpl.Issuer, PublicKey: key.Public()}
	der, err := x509.CreateCertificate(nil, tmpl, parent, key.Public(), key)
	if err != nil {
		panic(err)
	}
	c, err := x509.ParseCertificate(der)
	if err != nil {
		panic(err)
	}
	return testSigner{cert: c, der: der}
}

var (
	oidSignedData  = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 2}
	oidSpcIndirect = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 311, 2, 1, 4}
	oidSHA256      = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 2, 1}
	oidEd25519     = asn1.ObjectIdentifier{1, 3, 101, 112}
)

type algID struct {
	Algorithm asn1.ObjectIdentifier
}

// pkcs7For builds a SignedData whose signer info names the certificate.
func pkcs7For(s testSigner, digest []byte) []byte {
	mustRaw := func(v any, params string) asn1.RawValue {
		b, err := asn1.MarshalWithParams(v, params)
		if err != nil {
			panic(err)
		}
		return asn1.RawValue{FullBytes: b}
	}
	type issuerSerial struct {
		Issuer asn1.RawValue
		Serial *big.Int
	}
	type signerInfo struct {
		Version         int
		IssuerAndSerial issuerSerial
		DigestAlg       algID
		SigAlg          algID
		Signature       []byte
	}
	type innerContent struct {
		Type asn1.ObjectIdentifier
	}
	type signedData struct {
		Version          int
		DigestAlgorithms []algID `asn1:"set"`
		ContentInfo      innerContent
		Certificates     asn1.RawValue `asn1:"tag:0,optional"`
		SignerInfos      []signerInfo  `asn1:"set"`
	}
	sd := signedData{Version: 1, DigestAlgorithms: []algID{{oidSHA256}}, ContentInfo: innerContent{oidSpcIndirect},
		Certificates: asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 0, IsCompound: true, Bytes: s.der},
		SignerInfos: []signerInfo{{Version: 1, IssuerAndSerial: issuerSerial{Issuer: asn1.RawValue{FullBytes: s.cert.RawIssuer}, Serial: s.cert.SerialNumber},
			DigestAlg: algID{oidSHA256}, SigAlg: algID{oidEd25519}, Signature: digest}}}
	type contentInfoOut struct {
		Type    asn1.ObjectIdentifier
		Content asn1.RawValue
	}
	// A RawValue with FullBytes is written as is: build the [0] wrapper here.
	inner := mustRaw(sd, "").FullBytes
	out, err := asn1.Marshal(contentInfoOut{Type: oidSignedData,
		Content: asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 0, IsCompound: true, Bytes: inner}})
	if err != nil {
		panic(err)
	}
	return out
}

func align(n, a int) int { return (n + a - 1) / a * a }

// buildPE returns a PE32+ EFI application with the given sections, signed
// by signer when it is not nil (WIN_CERTIFICATE with a PKCS#7 SignedData).
func buildPE(sections []peSection, signer *testSigner) []byte {
	const (
		peOff       = 0x40
		optSize     = 240
		fileAlign   = 0x200
		sectAlign   = 0x1000
		headersSize = 0x400
	)
	buf := make([]byte, headersSize)
	copy(buf, "MZ")
	binary.LittleEndian.PutUint32(buf[0x3c:], peOff)
	copy(buf[peOff:], "PE\x00\x00")
	coff := buf[peOff+4:]
	binary.LittleEndian.PutUint16(coff[0:], 0x8664)
	binary.LittleEndian.PutUint16(coff[2:], uint16(len(sections)))
	binary.LittleEndian.PutUint16(coff[16:], optSize)
	binary.LittleEndian.PutUint16(coff[18:], 0x0022)
	opt := buf[peOff+24:]
	binary.LittleEndian.PutUint16(opt[0:], 0x20b)
	binary.LittleEndian.PutUint32(opt[32:], sectAlign)
	binary.LittleEndian.PutUint32(opt[36:], fileAlign)
	binary.LittleEndian.PutUint32(opt[60:], headersSize)
	binary.LittleEndian.PutUint16(opt[68:], 10)
	binary.LittleEndian.PutUint32(opt[108:], 16)
	sh := buf[peOff+24+optSize:]
	raw := headersSize
	va := sectAlign
	var body []byte
	for i, s := range sections {
		h := sh[i*40:]
		copy(h[0:8], s.name)
		size := align(len(s.data), fileAlign)
		binary.LittleEndian.PutUint32(h[8:], uint32(len(s.data)))
		binary.LittleEndian.PutUint32(h[12:], uint32(va))
		binary.LittleEndian.PutUint32(h[16:], uint32(size))
		binary.LittleEndian.PutUint32(h[20:], uint32(raw))
		binary.LittleEndian.PutUint32(h[36:], 0x40000040)
		d := make([]byte, size)
		copy(d, s.data)
		body = append(body, d...)
		raw += size
		va += align(len(s.data)+1, sectAlign)
	}
	binary.LittleEndian.PutUint32(opt[56:], uint32(va))
	img := append(buf, body...)
	if signer == nil {
		return img
	}
	// The hash is taken before the certificate table exists; the test
	// recomputes it independently.
	sum := sha256.Sum256(img)
	p7 := pkcs7For(*signer, sum[:])
	cert := make([]byte, align(8+len(p7), 8))
	binary.LittleEndian.PutUint32(cert[0:], uint32(len(cert)))
	binary.LittleEndian.PutUint16(cert[4:], 0x0200)
	binary.LittleEndian.PutUint16(cert[6:], 0x0002)
	copy(cert[8:], p7)
	off := len(img)
	binary.LittleEndian.PutUint32(img[peOff+24+112+32:], uint32(off))
	binary.LittleEndian.PutUint32(img[peOff+24+112+36:], uint32(len(cert)))
	return append(img, cert...)
}

// expectedAuthenticode recomputes the image hash by plain byte slicing.
func expectedAuthenticode(img []byte) [32]byte {
	peOff := int(binary.LittleEndian.Uint32(img[0x3c:]))
	opt := peOff + 24
	checksum := opt + 64
	certEntry := opt + 144
	certOff := int(binary.LittleEndian.Uint32(img[certEntry:]))
	certLen := int(binary.LittleEndian.Uint32(img[certEntry+4:]))
	end := len(img)
	if certLen > 0 {
		end = certOff
	}
	var b []byte
	b = append(b, img[:checksum]...)
	b = append(b, img[checksum+4:certEntry]...)
	b = append(b, img[certEntry+8:end]...)
	return sha256.Sum256(b)
}

// Signers of the fixtures (their names follow the real chain; the keys are
// test keys).
var (
	msThirdParty = newTestSigner("Microsoft Windows UEFI Driver Publisher", "Microsoft Corporation UEFI CA 2011", 0x3300000001, 1)
	distroSigner = newTestSigner("Debian Secure Boot Signer 2022 - linux", "Debian Secure Boot CA", 0x7a, 2)
	ownSigner    = newTestSigner("Own Secure Boot Key", "Own Secure Boot Key", 0x42, 3)
	mokSigner    = newTestSigner("DKMS module signing key", "DKMS module signing key", 0x99, 4)
)

func sortedSectionNames(secs []peSection) []string {
	var out []string
	for _, s := range secs {
		out = append(out, s.name)
	}
	sort.Strings(out)
	return out
}
