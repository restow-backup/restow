package baremetal

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"
)

// Formats of the planner's inputs and output (contracts C-M2-2 to C-M2-5).
const (
	PlanFormat   = "restow-plan-v1"
	FactsFormat  = "restow-plan-facts-v1"
	TargetFormat = "restow-plan-target-v1"
)

// Caps of the planner's inputs.
const (
	MaxFactsBytes      = 32 << 20
	MaxKernelFactBytes = 8 << 20
	MaxTargetBytes     = 1 << 20
	MaxChoicesBytes    = 64 << 10
	maxFactsKernels    = 64
	maxFactsMokFiles   = 16
	maxRestoreSizes    = 4096
)

// ErrInputTooLarge is returned by the parsers for input above its cap.
var ErrInputTooLarge = errors.New("input too large")

// Facts are what stage 1 (or recover) read from the snapshot for the
// planner: the module lists of the default and the fallback kernel, the
// restore size per mount target and the MOK files (C-M2-2).
type Facts struct {
	Format       string                 `json:"format"`
	Kernels      []KernelFacts          `json:"kernels"`
	RestoreSizes map[string]RestoreSize `json:"restoreSizes"`
	MokFiles     []MokFileFact          `json:"mokFiles"`
}

// KernelFacts are the module lists of one kernel. An empty text means the
// file is not in the snapshot.
type KernelFacts struct {
	Version               string `json:"version"`
	Default               bool   `json:"default"`
	ModulesAlias          string `json:"modulesAlias"`
	ModulesBuiltin        string `json:"modulesBuiltin"`
	ModulesBuiltinModinfo string `json:"modulesBuiltinModinfo"`
}

// RestoreSize is what a restore writes below one mount target (without the
// trees of other mount targets below it; hard links once).
type RestoreSize struct {
	Bytes  int64 `json:"bytes"`
	Files  int64 `json:"files"`
	Inodes int64 `json:"inodes"`
}

// MokFileFact is a MOK certificate file of the snapshot.
type MokFileFact struct {
	Path    string  `json:"path"`
	Present bool    `json:"present"`
	SHA256  *string `json:"sha256"`
}

// requireKeys checks that the JSON object raw has every key.
func requireKeys(raw []byte, what string, keys ...string) error {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return fmt.Errorf("%s: %v", what, err)
	}
	for _, k := range keys {
		v, ok := m[k]
		if !ok {
			return fmt.Errorf("%s.%s: required field missing", what, k)
		}
		if bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
			return fmt.Errorf("%s.%s: must not be null", what, k)
		}
	}
	return nil
}

// checkMultiline is checkString for module lists: line breaks and tabs are
// allowed, every other control character is not.
func checkMultiline(s string) error {
	return checkString(strings.NewReplacer("\n", " ", "\t", " ").Replace(s))
}

// ParseFacts reads and checks a facts document (C-M2-2).
func ParseFacts(b []byte) (*Facts, error) {
	if len(b) > MaxFactsBytes {
		return nil, ErrInputTooLarge
	}
	if err := requireKeys(b, "facts", "format", "kernels", "restoreSizes", "mokFiles"); err != nil {
		return nil, err
	}
	var f Facts
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("facts: %v", err)
	}
	if f.Format != FactsFormat {
		return nil, fmt.Errorf("facts.format: %q, want %q", f.Format, FactsFormat)
	}
	if len(f.Kernels) > maxFactsKernels || len(f.MokFiles) > maxFactsMokFiles || len(f.RestoreSizes) > maxRestoreSizes {
		return nil, errors.New("facts: too many entries")
	}
	var kernelsRaw struct {
		Kernels []json.RawMessage `json:"kernels"`
	}
	_ = json.Unmarshal(b, &kernelsRaw)
	for i, raw := range kernelsRaw.Kernels {
		if err := requireKeys(raw, fmt.Sprintf("facts.kernels[%d]", i), "version", "default", "modulesAlias", "modulesBuiltin", "modulesBuiltinModinfo"); err != nil {
			return nil, err
		}
	}
	for i, k := range f.Kernels {
		if err := checkString(k.Version); err != nil || k.Version == "" || len(k.Version) > maxStringBytes {
			return nil, fmt.Errorf("facts.kernels[%d].version: invalid", i)
		}
		for name, text := range map[string]string{"modulesAlias": k.ModulesAlias, "modulesBuiltin": k.ModulesBuiltin, "modulesBuiltinModinfo": k.ModulesBuiltinModinfo} {
			if len(text) > MaxKernelFactBytes {
				return nil, ErrInputTooLarge
			}
			if err := checkMultiline(text); err != nil {
				return nil, fmt.Errorf("facts.kernels[%d].%s: %v", i, name, err)
			}
		}
	}
	for target, s := range f.RestoreSizes {
		if err := checkString(target); err != nil || len(target) > maxStringBytes {
			return nil, fmt.Errorf("facts.restoreSizes: invalid key %q", truncateForError(target))
		}
		if s.Bytes < 0 || s.Files < 0 || s.Inodes < 0 || s.Bytes > maxSafeInteger || s.Files > maxSafeInteger || s.Inodes > maxSafeInteger {
			return nil, fmt.Errorf("facts.restoreSizes[%q]: out of range", truncateForError(target))
		}
	}
	for i, mf := range f.MokFiles {
		if err := checkString(mf.Path); err != nil || len(mf.Path) > maxStringBytes {
			return nil, fmt.Errorf("facts.mokFiles[%d].path: invalid", i)
		}
		if mf.SHA256 != nil && !reHex64.MatchString(*mf.SHA256) {
			return nil, fmt.Errorf("facts.mokFiles[%d].sha256: not a lowercase hex SHA-256", i)
		}
	}
	if f.RestoreSizes == nil {
		f.RestoreSizes = map[string]RestoreSize{}
	}
	return &f, nil
}

// aliasEntry is one line of modules.alias (or a builtin alias).
type aliasEntry struct {
	pattern, module string
}

// ParseModulesAlias reads modules.alias: "alias <pattern> <module>" lines;
// comments and other lines are skipped. Module names use "_" for "-".
func ParseModulesAlias(text string) []aliasEntry {
	var out []aliasEntry
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) == 3 && f[0] == "alias" {
			out = append(out, aliasEntry{pattern: f[1], module: moduleName(f[2])})
		}
	}
	return out
}

// parseBuiltinModinfo reads modules.builtin.modinfo (NULs as line breaks):
// the "<module>.alias=<pattern>" entries.
func parseBuiltinModinfo(text string) []aliasEntry {
	var out []aliasEntry
	for _, line := range strings.Split(text, "\n") {
		mod, rest, ok := strings.Cut(strings.TrimSpace(line), ".alias=")
		if ok && mod != "" && rest != "" && !strings.ContainsAny(mod, " =") {
			out = append(out, aliasEntry{pattern: rest, module: moduleName(mod)})
		}
	}
	return out
}

// parseModulesBuiltin reads modules.builtin: one path per line
// ("kernel/drivers/ata/ahci.ko"); the result holds the module names.
func parseModulesBuiltin(text string) map[string]bool {
	out := map[string]bool{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		base := path.Base(line)
		base = strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(base, ".xz"), ".zst"), ".ko")
		out[moduleName(base)] = true
	}
	return out
}

func moduleName(s string) string { return strings.ReplaceAll(s, "-", "_") }

// kernelIndex answers which module of one kernel handles a modalias.
type kernelIndex struct {
	version  string
	aliases  []aliasEntry
	builtins []aliasEntry
	builtin  map[string]bool
	dkms     map[string]bool
	known    bool
}

func newKernelIndex(k KernelFacts, dkms []DKMSModule) *kernelIndex {
	idx := &kernelIndex{version: k.Version, aliases: ParseModulesAlias(k.ModulesAlias),
		builtins: parseBuiltinModinfo(k.ModulesBuiltinModinfo), builtin: parseModulesBuiltin(k.ModulesBuiltin),
		dkms: map[string]bool{}, known: k.ModulesAlias != ""}
	for _, d := range dkms {
		if d.Kernel == k.Version {
			idx.dkms[moduleName(d.Module)] = true
		}
	}
	return idx
}

// match returns the module for a modalias and whether it is built in. A
// module of the device's driver chain built by DKMS for this kernel counts
// as present.
func (k *kernelIndex) match(modalias string, chain []string) (module string, builtin, found bool) {
	for _, a := range k.builtins {
		if ok, _ := path.Match(a.pattern, modalias); ok {
			return a.module, true, true
		}
	}
	var mods []string
	for _, a := range k.aliases {
		if ok, _ := path.Match(a.pattern, modalias); ok {
			mods = append(mods, a.module)
		}
	}
	if len(mods) > 0 {
		sort.Strings(mods)
		// Prefer a module of the chain (several modules may claim an alias).
		for _, m := range mods {
			for _, c := range chain {
				if moduleName(c) == m {
					return m, k.builtin[m], true
				}
			}
		}
		return mods[0], k.builtin[mods[0]], true
	}
	for _, c := range chain {
		if k.dkms[moduleName(c)] {
			return moduleName(c), false, true
		}
	}
	return "", false, false
}
