package baremetal

import (
	"path"
	"sort"
	"strconv"
	"strings"
)

// Secure Boot check of the boot chain against the target firmware
// (docs/BAREMETAL.md 10.5): db, dbx, SBAT and MOK.

// ChainCheck is the result of CheckChain.
type ChainCheck struct {
	Checked          bool          `json:"checked"`
	TargetSecureBoot *bool         `json:"targetSecureBoot"`
	Loaders          []LoaderCheck `json:"loaders"`
}

// LoaderCheck is the verdict on one loader: ok, ca_missing, revoked,
// sbat_revoked or unsigned.
type LoaderCheck struct {
	Path    string  `json:"path"`
	Verdict string  `json:"verdict"`
	Detail  *string `json:"detail"`
}

// espMounts returns the mount targets of the restored ESPs.
func (x *layoutModel) espMounts() []string {
	var out []string
	for _, id := range x.l.Bootloader.ESPs {
		out = append(out, x.mounts[id]...)
	}
	sort.Strings(out)
	return out
}

func underAny(p string, roots []string) (string, bool) {
	for _, r := range roots {
		if r == "/" || strings.HasPrefix(p, strings.TrimSuffix(r, "/")+"/") {
			return r, true
		}
	}
	return "", false
}

// firstStage returns the loaders the firmware starts directly: the loader
// of each active Boot#### entry and the fallback path \EFI\BOOT\BOOT*.EFI.
func (x *layoutModel) firstStage() map[string]bool {
	out := map[string]bool{}
	roots := x.espMounts()
	for _, e := range x.l.Firmware.Entries {
		if !e.Active || e.Loader == nil {
			continue
		}
		rel := strings.ToLower(strings.ReplaceAll(*e.Loader, `\`, "/"))
		for _, r := range roots {
			out[strings.ToLower(path.Join(r, rel))] = true
		}
	}
	for _, ld := range x.l.Loaders {
		base := strings.ToLower(path.Base(ld.Path))
		if strings.HasPrefix(base, "boot") && strings.HasSuffix(base, ".efi") && strings.EqualFold(path.Base(path.Dir(ld.Path)), "BOOT") {
			out[strings.ToLower(ld.Path)] = true
		}
	}
	return out
}

func isMicrosoftLoader(p string) bool {
	return strings.Contains(strings.ToLower(p), "/efi/microsoft/")
}

// sbatEntry is one "component,generation" line.
func sbatEntry(line string) (string, int64, bool) {
	f := strings.Split(line, ",")
	if len(f) < 2 {
		return "", 0, false
	}
	g, err := strconv.ParseInt(strings.TrimSpace(f[1]), 10, 64)
	if err != nil {
		return "", 0, false
	}
	return strings.TrimSpace(f[0]), g, true
}

// CheckChain checks the boot chain of the manifest against the Secure Boot
// state of the target: the signer of each first-stage loader must be in
// db, no loader may be in dbx, every SBAT generation must reach the
// target's SbatLevel, and keys of the machine owner (MOK) must be enrolled
// or in the backup. With choices.SecureBootOff the problems become one
// warning secure_boot_disabled_by_choice.
func CheckChain(m *Manifest, t *Target, f *Facts, choices Choices) (ChainCheck, []Finding) {
	x := newLayoutModel(m, nil, "skip")
	return x.checkChain(t, f, choices)
}

func (x *layoutModel) checkChain(t *Target, f *Facts, choices Choices) (ChainCheck, []Finding) {
	cc := ChainCheck{Loaders: []LoaderCheck{}, TargetSecureBoot: t.Firmware.SecureBoot}
	if t.Firmware.Mode != "uefi" || t.Firmware.SecureBoot == nil || !*t.Firmware.SecureBoot {
		return cc, nil
	}
	cc.Checked = true
	var problems, warnings []Finding
	dbCN := map[string]bool{}
	for _, c := range t.Firmware.DB {
		dbCN[subjectCN(c.Subject)] = true
	}
	dbxHash := map[string]bool{}
	dbxCert := map[string]bool{}
	if t.Firmware.DBX != nil {
		for _, h := range t.Firmware.DBX.Hashes {
			dbxHash[strings.ToLower(h)] = true
		}
		for _, h := range t.Firmware.DBX.Certs {
			dbxCert[strings.ToLower(h)] = true
		}
	} else {
		warnings = append(warnings, newFinding(WarnSecureBootDBXUnknown, ""))
	}
	// db certificates by CN, for revoked signer certificates.
	dbSHA := map[string][]string{}
	for _, c := range t.Firmware.DB {
		cn := subjectCN(c.Subject)
		dbSHA[cn] = append(dbSHA[cn], strings.ToLower(c.SHA256))
	}
	level := map[string]int64{}
	var levelText []string
	for i, line := range t.Firmware.SbatLevel {
		if i == 0 && strings.HasPrefix(line, "sbat,") {
			continue // header: sbat,1,<date>
		}
		if c, g, ok := sbatEntry(line); ok {
			level[c] = g
			levelText = append(levelText, line)
		}
	}
	roots := x.espMounts()
	first := x.firstStage()
	shim := x.l.Bootloader.Shim
	for _, ld := range x.l.Loaders {
		if _, ok := underAny(ld.Path, roots); !ok || isMicrosoftLoader(ld.Path) {
			continue
		}
		verdict, detail := "ok", ""
		isFirst := first[strings.ToLower(ld.Path)]
		if isFirst {
			switch {
			case ld.Signer == nil:
				verdict = "unsigned"
				if !shim {
					warnings = append(warnings, newFinding(WarnSecureBootUnsignedChain, ld.Path, "loader", ld.Path))
				} else {
					problems = append(problems, newFinding(ProblemSecureBootCAMissing, ld.Path, "loader", ld.Path, "issuer", "none"))
				}
			case !dbCN[subjectCN(ld.Signer.Issuer)]:
				verdict, detail = "ca_missing", subjectCN(ld.Signer.Issuer)
				problems = append(problems, newFinding(ProblemSecureBootCAMissing, ld.Path, "loader", ld.Path, "issuer", subjectCN(ld.Signer.Issuer)))
			}
		}
		if verdict == "ok" && t.Firmware.DBX != nil {
			revoked := dbxHash[strings.ToLower(ld.AuthenticodeSha256)]
			if ld.Signer != nil {
				for _, h := range dbSHA[subjectCN(ld.Signer.Issuer)] {
					revoked = revoked || dbxCert[h]
				}
			}
			if revoked {
				verdict = "revoked"
				problems = append(problems, newFinding(ProblemSecureBootRevoked, ld.Path, "loader", ld.Path))
			}
		}
		if verdict == "ok" {
			for i, line := range ld.Sbat {
				c, g, ok := sbatEntry(line)
				if !ok || (i == 0 && c == "sbat") {
					continue
				}
				if need, ok := level[c]; ok && g < need {
					verdict, detail = "sbat_revoked", c+","+strconv.FormatInt(g, 10)
					problems = append(problems, newFinding(ProblemSecureBootSbatRevoked, ld.Path, "loader", ld.Path, "component", c, "generation", g, "level", need))
					break
				}
			}
		}
		lc := LoaderCheck{Path: ld.Path, Verdict: verdict}
		if detail != "" {
			lc.Detail = strPtr(detail)
		}
		cc.Loaders = append(cc.Loaders, lc)
	}
	// MOK: kernels and DKMS modules signed with a key of the machine owner.
	enrolled := map[string]bool{}
	for _, k := range t.Firmware.MokList {
		enrolled[strings.ToLower(k.SHA256)] = true
	}
	files := map[string]bool{}
	if f != nil {
		for _, mf := range f.MokFiles {
			if mf.Present && mf.SHA256 != nil {
				files[*mf.SHA256] = true
			}
		}
	}
	reported := map[string]bool{}
	checkSigner := func(object, signer string, blocking bool) {
		if signer == "" {
			return
		}
		for _, mok := range x.l.Firmware.MOK {
			if mok.Subject == nil || subjectCN(*mok.Subject) != subjectCN(signer) || enrolled[strings.ToLower(mok.SHA256)] {
				continue
			}
			key := mok.SHA256 + "|" + object
			if reported[key] {
				return
			}
			reported[key] = true
			if files[strings.ToLower(mok.SHA256)] {
				if !reported[mok.SHA256] {
					reported[mok.SHA256] = true
					warnings = append(warnings, newFinding(WarnMokEnrollRequired, mok.SHA256, "subject", subjectCN(*mok.Subject)))
				}
			} else if blocking {
				problems = append(problems, newFinding(ProblemMokKeyMissing, object, "object", object, "subject", subjectCN(*mok.Subject)))
			} else {
				warnings = append(warnings, newFinding(ProblemMokKeyMissing, object, "object", object, "subject", subjectCN(*mok.Subject)))
			}
			return
		}
	}
	for _, k := range x.l.Kernels {
		checkSigner("kernel "+k.Version, deref(k.Signer), true)
	}
	for _, d := range x.l.DKMS {
		checkSigner("module "+d.Module, deref(d.Signer), d.Kind == "net" || d.Kind == "storage")
	}
	if choices.SecureBootOff && len(problems) > 0 {
		var codes []string
		seen := map[string]bool{}
		for _, p := range problems {
			if !seen[p.Code] {
				seen[p.Code] = true
				codes = append(codes, p.Code)
			}
		}
		sort.Strings(codes)
		warnings = append(warnings, newFinding(WarnSecureBootDisabledByChoice, "", "codes", codes))
		problems = nil
	}
	// A non-blocking mok_key_missing is a warning: report it under its own
	// warning code so the code lists stay apart.
	for i := range warnings {
		if warnings[i].Code == ProblemMokKeyMissing {
			warnings[i] = newFinding(WarnMokEnrollRequired, deref(warnings[i].Ref), "subject", warnings[i].Params["subject"], "object", warnings[i].Params["object"], "fileMissing", true)
		}
	}
	return cc, append(problems, warnings...)
}
