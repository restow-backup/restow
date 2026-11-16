package baremetal

import (
	"encoding/hex"
	"testing"
)

func TestBuildLoadOptionRoundTrip(t *testing.T) {
	sig := uint32(0x1a2b3c4d)
	for _, c := range []struct {
		name string
		part LoadOptionPartition
		path string
		want string
	}{
		{"gpt", LoadOptionPartition{Number: 1, StartLBA: 2048, SizeLBA: 1050624, PartUUID: "5e1c4d0a-1b2c-4d3e-8f90-a1b2c3d4e5f6"}, `\EFI\debian\shimx64.efi`, "5e1c4d0a-1b2c-4d3e-8f90-a1b2c3d4e5f6"},
		{"forward slashes", LoadOptionPartition{Number: 2, StartLBA: 4096, SizeLBA: 8192, PartUUID: "5E1C4D0A-1B2C-4D3E-8F90-A1B2C3D4E5F6"}, "EFI/BOOT/BOOTX64.EFI", "5e1c4d0a-1b2c-4d3e-8f90-a1b2c3d4e5f6"},
		{"mbr", LoadOptionPartition{Number: 1, StartLBA: 2048, SizeLBA: 1024000, MBRSig: &sig}, `\EFI\ubuntu\grubx64.efi`, ""},
	} {
		b, err := BuildLoadOption(EFIVarNonVolatile|LoadOptionActive, "debian", c.part, c.path)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		o, err := ParseLoadOption(b)
		if err != nil {
			t.Fatalf("%s: parse: %v", c.name, err)
		}
		wantPath := c.path
		if c.name == "forward slashes" {
			wantPath = `\EFI\BOOT\BOOTX64.EFI`
		}
		if !o.Active() || o.Description != "debian" || o.PartNumber != uint32(c.part.Number) || o.PartUUID != c.want || o.Path != wantPath {
			t.Errorf("%s: round trip gave %+v", c.name, o)
		}
	}
}

// TestBuildLoadOptionGolden pins the exact bytes (hard drive node, file
// path node, end node) for GPT and MBR.
func TestBuildLoadOptionGolden(t *testing.T) {
	gpt, err := BuildLoadOption(1, "L", LoadOptionPartition{Number: 1, StartLBA: 0x800, SizeLBA: 0x100000, PartUUID: "00112233-4455-6677-8899-aabbccddeeff"}, `\a`)
	if err != nil {
		t.Fatal(err)
	}
	// The file path node is 4 bytes plus "\\a" and a NUL in UTF-16: 10 bytes.
	want := "01000000" + "3800" + "4c000000" +
		"04012a00" + "01000000" + "0008000000000000" + "0000100000000000" + "33221100554477668899aabbccddeeff" + "0202" +
		"04040a00" + "5c0061000000" +
		"7fff0400"
	if got := hex.EncodeToString(gpt); got != want {
		t.Errorf("GPT load option\n got %s\nwant %s", got, want)
	}
	sig := uint32(0xdeadbeef)
	mbr, err := BuildLoadOption(1, "L", LoadOptionPartition{Number: 2, StartLBA: 63, SizeLBA: 1000, MBRSig: &sig}, `\a`)
	if err != nil {
		t.Fatal(err)
	}
	want = "01000000" + "3800" + "4c000000" +
		"04012a00" + "02000000" + "3f00000000000000" + "e803000000000000" + "efbeadde000000000000000000000000" + "0101" +
		"04040a00" + "5c0061000000" +
		"7fff0400"
	if got := hex.EncodeToString(mbr); got != want {
		t.Errorf("MBR load option\n got %s\nwant %s", got, want)
	}
}

func TestBuildLoadOptionRejects(t *testing.T) {
	for _, c := range []struct {
		part LoadOptionPartition
		path string
	}{
		{LoadOptionPartition{Number: 0, PartUUID: "00112233-4455-6677-8899-aabbccddeeff"}, `\a`},
		{LoadOptionPartition{Number: 1}, `\a`},
		{LoadOptionPartition{Number: 1, PartUUID: "not-a-guid"}, `\a`},
		{LoadOptionPartition{Number: 1, PartUUID: "00112233-4455-6677-8899-aabbccddeeff"}, `\EFI\..\x`},
	} {
		if _, err := BuildLoadOption(1, "x", c.part, c.path); err == nil {
			t.Errorf("%+v %q accepted", c.part, c.path)
		}
	}
	if got := EncodeBootOrder([]int64{3, 0x1001}); hex.EncodeToString(got) != "03000110" {
		t.Errorf("boot order %x", got)
	}
	if got := ParseBootOrder(EncodeBootOrder([]int64{1, 2, 7})); len(got) != 3 || got[2] != 7 {
		t.Errorf("boot order round trip %v", got)
	}
}
