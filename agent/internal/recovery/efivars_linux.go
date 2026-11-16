//go:build linux

package recovery

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// EFI variables of the replacement machine (docs/BAREMETAL.md 10.5 and
// 10.15): the Secure Boot databases are read for the chain check, and
// Boot#### and BootOrder are written by recover itself (the programs of
// the target run with --no-nvram / --no-variables).
type EFIVars struct {
	// Dir is efivarfs (/sys/firmware/efi/efivars).
	Dir string
	// FirmwareDir is /sys/firmware/efi (its presence means UEFI).
	FirmwareDir string
	// SysRoot and DevRoot are /sys and /dev (tests).
	SysRoot string
	DevRoot string
}

func (e EFIVars) dir() string {
	if e.Dir == "" {
		return "/sys/firmware/efi/efivars"
	}
	return e.Dir
}

func (e EFIVars) read(name, guid string) ([]byte, bool) {
	b, err := os.ReadFile(filepath.Join(e.dir(), name+"-"+guid))
	if err != nil {
		return nil, false
	}
	_, v, err := baremetal.ParseEFIVar(b)
	if err != nil {
		return nil, false
	}
	return v, true
}

// Firmware reads the boot mode and the Secure Boot state: SecureBoot,
// SetupMode, db, dbx (hashes and certificate SHA-256), SbatLevelRT and
// MokListRT. A database that cannot be read stays empty (dbx: unknown).
func (e EFIVars) Firmware() baremetal.TargetFirmware {
	fw := baremetal.TargetFirmware{Mode: "bios", DB: []baremetal.CertRef{}, SbatLevel: []string{}, MokList: []baremetal.MokRef{}}
	fd := e.FirmwareDir
	if fd == "" {
		fd = "/sys/firmware/efi"
	}
	if _, err := os.Stat(fd); err != nil {
		return fw
	}
	fw.Mode = "uefi"
	if v, ok := e.read("SecureBoot", baremetal.EFIGlobalGUID); ok && len(v) > 0 {
		on := v[0] == 1
		fw.SecureBoot = &on
	}
	if v, ok := e.read("SetupMode", baremetal.EFIGlobalGUID); ok && len(v) > 0 {
		on := v[0] == 1
		fw.SetupMode = &on
	}
	if v, ok := e.read("db", baremetal.EFISecDBGUID); ok {
		if l, err := baremetal.ParseSignatureList(v); err == nil {
			fw.DB = append(fw.DB, l.Certs...)
		}
	}
	if v, ok := e.read("dbx", baremetal.EFISecDBGUID); ok {
		if l, err := baremetal.ParseSignatureList(v); err == nil {
			dbx := &baremetal.TargetDBX{Hashes: append([]string{}, l.Hashes...), Certs: []string{}}
			for _, c := range l.Certs {
				dbx.Certs = append(dbx.Certs, c.SHA256)
			}
			fw.DBX = dbx
		}
	}
	if v, ok := e.read("SbatLevelRT", baremetal.ShimLockGUID); ok {
		fw.SbatLevel = baremetal.ParseSbatLevel(v)
	}
	if v, ok := e.read("MokListRT", baremetal.ShimLockGUID); ok {
		if l, err := baremetal.ParseSignatureList(v); err == nil {
			for _, c := range l.Certs {
				subj := c.Subject
				fw.MokList = append(fw.MokList, baremetal.MokRef{Subject: &subj, SHA256: c.SHA256})
			}
		}
	}
	return fw
}

var reBootVar = regexp.MustCompile(`^Boot([0-9A-F]{4})-` + baremetal.EFIGlobalGUID + `$`)

// partitionOf finds the partition of a PARTUUID: its number, start and
// size in logical sectors of its disk.
func (e EFIVars) partitionOf(partUUID string) (baremetal.LoadOptionPartition, error) {
	dev, sys := e.DevRoot, e.SysRoot
	if dev == "" {
		dev = "/dev"
	}
	if sys == "" {
		sys = "/sys"
	}
	link := filepath.Join(dev, "disk/by-partuuid", strings.ToLower(partUUID))
	r, err := filepath.EvalSymlinks(link)
	if err != nil {
		return baremetal.LoadOptionPartition{}, fmt.Errorf("partition %s not found: %w", partUUID, err)
	}
	k := filepath.Base(r)
	readInt := func(p string) (int64, error) {
		b, err := os.ReadFile(p)
		if err != nil {
			return 0, err
		}
		return strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	}
	cls := filepath.Join(sys, "class/block", k)
	num, err := readInt(filepath.Join(cls, "partition"))
	if err != nil {
		return baremetal.LoadOptionPartition{}, fmt.Errorf("%s is not a partition", k)
	}
	start, err1 := readInt(filepath.Join(cls, "start"))
	size, err2 := readInt(filepath.Join(cls, "size"))
	if err1 != nil || err2 != nil {
		return baremetal.LoadOptionPartition{}, fmt.Errorf("%s: start or size unknown", k)
	}
	// The parent is the disk; sysfs counts in 512-byte units.
	target, err := filepath.EvalSymlinks(cls)
	if err != nil {
		return baremetal.LoadOptionPartition{}, err
	}
	disk := filepath.Base(filepath.Dir(target))
	lbs, err := readInt(filepath.Join(sys, "block", disk, "queue/logical_block_size"))
	if err != nil || lbs < 512 {
		lbs = 512
	}
	f := lbs / 512
	return baremetal.LoadOptionPartition{Number: num, StartLBA: uint64(start / f), SizeLBA: uint64(size / f), PartUUID: strings.ToLower(partUUID)}, nil
}

// WriteBootEntry creates a Boot#### entry (NV|BS|RT) for the loader on
// the partition and puts it first in BootOrder. An entry with the same
// partition and loader is reused, never duplicated.
func (e EFIVars) WriteBootEntry(req BootEntryRequest) (int, error) {
	part, err := e.partitionOf(req.PartUUID)
	if err != nil {
		return -1, err
	}
	opt, err := baremetal.BuildLoadOption(baremetal.LoadOptionActive, req.Label, part, req.Loader)
	if err != nil {
		return -1, err
	}
	want, _ := baremetal.ParseLoadOption(opt)
	entries, err := os.ReadDir(e.dir())
	if err != nil {
		return -1, err
	}
	used := map[int]bool{}
	num := -1
	for _, de := range entries {
		m := reBootVar.FindStringSubmatch(de.Name())
		if m == nil {
			continue
		}
		n, _ := strconv.ParseInt(m[1], 16, 32)
		used[int(n)] = true
		if v, ok := e.read("Boot"+m[1], baremetal.EFIGlobalGUID); ok {
			if o, err := baremetal.ParseLoadOption(v); err == nil && strings.EqualFold(o.PartUUID, want.PartUUID) && strings.EqualFold(o.Path, want.Path) {
				num = int(n)
			}
		}
	}
	if num < 0 {
		for n := 0; n <= 0xffff; n++ {
			if !used[n] {
				num = n
				break
			}
		}
		if num < 0 {
			return -1, errors.New("no free Boot#### number")
		}
		name := fmt.Sprintf("Boot%04X-%s", num, baremetal.EFIGlobalGUID)
		if err := e.writeVar(name, opt); err != nil {
			return -1, err
		}
	}
	order := []int64{}
	if v, ok := e.read("BootOrder", baremetal.EFIGlobalGUID); ok {
		order = baremetal.ParseBootOrder(v)
	}
	next := []int64{int64(num)}
	for _, n := range order {
		if n != int64(num) {
			next = append(next, n)
		}
	}
	if err := e.writeVar("BootOrder-"+baremetal.EFIGlobalGUID, baremetal.EncodeBootOrder(next)); err != nil {
		return num, err
	}
	return num, nil
}

// writeVar writes an EFI variable with NV|BS|RT in one write (efivarfs
// needs the attributes and the value together). The immutable flag
// efivarfs sets on existing variables is cleared for this file only.
func (e EFIVars) writeVar(name string, data []byte) error {
	p := filepath.Join(e.dir(), name)
	if _, err := os.Stat(p); err == nil {
		clearImmutable(p)
	}
	buf := make([]byte, 4, 4+len(data))
	attrs := uint32(baremetal.EFIVarNonVolatile | baremetal.EFIVarBootserviceAccess | baremetal.EFIVarRuntimeAccess)
	buf[0], buf[1], buf[2], buf[3] = byte(attrs), byte(attrs>>8), byte(attrs>>16), byte(attrs>>24)
	buf = append(buf, data...)
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|syscall.O_NOFOLLOW, 0o644)
	if err != nil {
		return err
	}
	_, werr := f.Write(buf)
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	return werr
}

const (
	fsIocGetFlags = 0x80086601
	fsIocSetFlags = 0x40086602
	fsImmutableFl = 0x00000010
)

func clearImmutable(p string) {
	f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return
	}
	defer f.Close()
	var flags int32
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), fsIocGetFlags, uintptr(unsafe.Pointer(&flags))); e != 0 {
		return // ENOTTY on a file system without flags
	}
	if flags&fsImmutableFl == 0 {
		return
	}
	flags &^= fsImmutableFl
	_, _, _ = syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), fsIocSetFlags, uintptr(unsafe.Pointer(&flags)))
}

// BootEntries lists the Boot#### entries (number and option), sorted.
func (e EFIVars) BootEntries() map[int]baremetal.LoadOption {
	out := map[int]baremetal.LoadOption{}
	entries, _ := os.ReadDir(e.dir())
	var names []string
	for _, de := range entries {
		names = append(names, de.Name())
	}
	sort.Strings(names)
	for _, n := range names {
		m := reBootVar.FindStringSubmatch(n)
		if m == nil {
			continue
		}
		num, _ := strconv.ParseInt(m[1], 16, 32)
		if v, ok := e.read("Boot"+m[1], baremetal.EFIGlobalGUID); ok {
			if o, err := baremetal.ParseLoadOption(v); err == nil {
				out[int(num)] = o
			}
		}
	}
	return out
}

// BootOrder is the current BootOrder.
func (e EFIVars) BootOrder() []int64 {
	if v, ok := e.read("BootOrder", baremetal.EFIGlobalGUID); ok {
		return baremetal.ParseBootOrder(v)
	}
	return nil
}
