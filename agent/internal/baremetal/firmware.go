package baremetal

import (
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
)

const efivarsDir = "/sys/firmware/efi/efivars"

// reBootEntry matches Boot#### of the global vendor GUID.
var reBootEntry = regexp.MustCompile(`^Boot([0-9A-Fa-f]{4})-` + EFIGlobalGUID + `$`)

// efivarAllowed is the allow-list of variables the capture reads
// (docs/BAREMETAL.md, 4.1); no other variable is opened.
func efivarAllowed(name string) bool {
	if reBootEntry.MatchString(name) {
		return true
	}
	switch name {
	case "BootOrder-" + EFIGlobalGUID, "BootCurrent-" + EFIGlobalGUID, "SecureBoot-" + EFIGlobalGUID, "SetupMode-" + EFIGlobalGUID,
		"SbatLevelRT-" + ShimLockGUID, "MokListRT-" + ShimLockGUID, "db-" + EFISecDBGUID, "dbx-" + EFISecDBGUID:
		return true
	}
	return false
}

// captureFirmware reads the firmware mode and, on UEFI, the boot entries,
// Secure Boot state, SBAT level, MOK list and the certificates of db and
// the hash of dbx, from the allow-listed efivars only.
func captureFirmware(c *capture) error {
	f := &c.l.Firmware
	if !exists(c.h, "/sys/firmware/efi") {
		f.Mode = "bios"
		return nil
	}
	f.Mode = "uefi"
	ents, err := c.h.ReadDir(efivarsDir)
	if err != nil {
		return err
	}
	vars := map[string][]byte{}
	for _, e := range ents {
		if !efivarAllowed(e.Name()) {
			continue
		}
		b, err := c.h.ReadFile(efivarsDir+"/"+e.Name(), 1<<20)
		if err != nil {
			continue
		}
		if _, v, err := ParseEFIVar(b); err == nil {
			vars[e.Name()] = v
		}
	}
	if _, ok := vars["MokListRT-"+ShimLockGUID]; !ok {
		if b, err := c.h.ReadFile("/sys/firmware/efi/mok-variables/MokListRT", 1<<20); err == nil {
			vars["MokListRT-"+ShimLockGUID] = b
		}
	}
	rawVars := map[string]string{}
	for k, v := range vars {
		rawVars[k] = hex.EncodeToString(v)
	}
	if b, err := json.MarshalIndent(rawVars, "", "  "); err == nil {
		c.addRaw("efivars.json", append(b, '\n'))
	}
	if v, ok := vars["SecureBoot-"+EFIGlobalGUID]; ok && len(v) > 0 {
		f.SecureBoot = boolPtr(v[0] == 1)
	}
	if v, ok := vars["SetupMode-"+EFIGlobalGUID]; ok && len(v) > 0 {
		f.SetupMode = boolPtr(v[0] == 1)
	}
	if v, ok := vars["BootOrder-"+EFIGlobalGUID]; ok {
		f.BootOrder = ParseBootOrder(v)
	}
	if v, ok := vars["BootCurrent-"+EFIGlobalGUID]; ok && len(v) >= 2 {
		cur := ParseBootOrder(v[:2])[0]
		f.BootCurrent = &cur
	}
	if v, ok := vars["SbatLevelRT-"+ShimLockGUID]; ok {
		f.SbatLevel = ParseSbatLevel(v)
		if len(f.SbatLevel) > maxSbatLines {
			f.SbatLevel = f.SbatLevel[:maxSbatLines]
		}
	}
	var names []string
	for k := range vars {
		if reBootEntry.MatchString(k) {
			names = append(names, k)
		}
	}
	sort.Strings(names)
	for _, k := range names {
		if len(f.Entries) >= maxEFIEntries {
			break
		}
		num, _ := strconv.ParseInt(reBootEntry.FindStringSubmatch(k)[1], 16, 64)
		o, err := ParseLoadOption(vars[k])
		if err != nil {
			continue
		}
		e := EFIEntry{Num: num, Label: clean(o.Description), Active: o.Active()}
		if o.PartUUID != "" {
			e.PartUUID = strPtr(o.PartUUID)
			pn := int64(o.PartNumber)
			e.PartNumber = &pn
		}
		if o.Path != "" {
			e.Loader = strPtr(clean(o.Path))
		}
		f.Entries = append(f.Entries, e)
	}
	if v, ok := vars["db-"+EFISecDBGUID]; ok {
		if l, err := ParseSignatureList(v); err == nil {
			f.DB = l.Certs
			if len(f.DB) > maxDB {
				f.DB = f.DB[:maxDB]
			}
		}
	}
	if v, ok := vars["dbx-"+EFISecDBGUID]; ok {
		if l, err := ParseSignatureList(v); err == nil && len(l.Hashes) > 0 {
			f.DBXSha256 = strPtr(HashListSHA256(l.Hashes))
		}
	}
	if v, ok := vars["MokListRT-"+ShimLockGUID]; ok {
		if l, err := ParseSignatureList(v); err == nil {
			for _, cert := range l.Certs {
				if len(f.MOK) >= maxMOK {
					break
				}
				f.MOK = append(f.MOK, MokRef{Subject: cleanPtr(cert.Subject), SHA256: cert.SHA256})
			}
			for _, h := range l.Hashes {
				if len(f.MOK) >= maxMOK {
					break
				}
				f.MOK = append(f.MOK, MokRef{SHA256: h})
			}
		}
	}
	return nil
}
