package baremetal

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"
)

func TestInspectLoaderSigned(t *testing.T) {
	img := buildPE([]peSection{
		{".text", bytes.Repeat([]byte{0x90}, 3000)},
		{".sbat", []byte("sbat,1,SBAT Version,sbat,1,https://github.com/rhboot/shim/blob/main/SBAT.md\nshim,4,UEFI shim,shim,1,https://github.com/rhboot/shim\n\x00\x00")},
	}, &msThirdParty)
	info, err := InspectLoader(bytes.NewReader(img), int64(len(img)))
	if err != nil {
		t.Fatal(err)
	}
	want := expectedAuthenticode(img)
	if info.AuthenticodeSha256 != hex.EncodeToString(want[:]) {
		t.Fatalf("authenticode %s, want %x", info.AuthenticodeSha256, want)
	}
	if info.Signer == nil || info.Signer.Subject != "CN=Microsoft Windows UEFI Driver Publisher,O=Restow Test" ||
		!strings.Contains(info.Signer.Issuer, "Microsoft Corporation UEFI CA 2011") || info.Signer.Serial != "3300000001" {
		t.Fatalf("signer %+v", info.Signer)
	}
	if len(info.Sbat) != 2 || !strings.HasPrefix(info.Sbat[1], "shim,4") || info.UKI {
		t.Fatalf("%+v", info)
	}
	// The certificate data and the checksum do not change the hash.
	img2 := append([]byte(nil), img...)
	img2[0x40+24+64] = 0xff
	img2[len(img2)-1] ^= 0xff
	info2, err := InspectLoader(bytes.NewReader(img2), int64(len(img2)))
	if err != nil || info2.AuthenticodeSha256 != info.AuthenticodeSha256 {
		t.Fatalf("hash changed: %v", err)
	}
	// A changed section does.
	img2[0x400+10] ^= 0xff
	info3, _ := InspectLoader(bytes.NewReader(img2), int64(len(img2)))
	if info3.AuthenticodeSha256 == info.AuthenticodeSha256 {
		t.Fatal("hash ignores section content")
	}
}

func TestInspectLoaderUKI(t *testing.T) {
	img := buildPE([]peSection{
		{".osrel", []byte("ID=arch\nPRETTY_NAME=\"Arch Linux\"\n")},
		{".cmdline", []byte("root=UUID=abc rw quiet rd.luks.key=/etc/key cryptdevice=x\x00")},
		{".linux", bytes.Repeat([]byte{1}, 2048)},
		{".initrd", bytes.Repeat([]byte{2}, 1024)},
	}, nil)
	info, err := InspectLoader(bytes.NewReader(img), int64(len(img)))
	if err != nil {
		t.Fatal(err)
	}
	if !info.UKI || info.Signer != nil || info.UKICmdline != "root=UUID=abc rw quiet rd.luks.key=<redacted> cryptdevice=x" || !strings.Contains(info.OSRelease, "ID=arch") {
		t.Fatalf("%+v", info)
	}
	if _, err := InspectLoader(bytes.NewReader([]byte("not a pe")), 8); err == nil {
		t.Fatal("garbage accepted")
	}
}
