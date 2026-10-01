package sysinfo

import "testing"

func TestParseOSRelease(t *testing.T) {
	debian := "PRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\nNAME=\"Debian GNU/Linux\"\nVERSION_ID=\"12\"\n"
	if got := parseOSRelease(debian); got != "Debian GNU/Linux 12 (bookworm)" {
		t.Errorf("debian: %q", got)
	}
	noPretty := "NAME='Alpine Linux'\nVERSION_ID=3.20.1\n"
	if got := parseOSRelease(noPretty); got != "Alpine Linux 3.20.1" {
		t.Errorf("fallback: %q", got)
	}
	if got := parseOSRelease(""); got != "" {
		t.Errorf("empty: %q", got)
	}
}

func TestIdentifiers(t *testing.T) {
	if OS() == "" || Arch() == "" || Hostname() == "" || OSVersion() == "" {
		t.Fatal("identifiers must not be empty")
	}
}
