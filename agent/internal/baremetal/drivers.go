package baremetal

import (
	"strings"
)

// Driver check before erasing (docs/BAREMETAL.md 10.8): does the backed-up
// kernel know the storage controller and the network cards of the target?

// DriverCheck is the result of CheckDrivers.
type DriverCheck struct {
	Kernel   *string       `json:"kernel"`
	Fallback *string       `json:"fallback"`
	Storage  []DriverMatch `json:"storage"`
	NICs     []DriverMatch `json:"nics"`
}

// DriverMatch is one modalias and the module that handles it.
type DriverMatch struct {
	Device   string  `json:"device"`
	Modalias string  `json:"modalias"`
	Module   *string `json:"module"`
	Builtin  bool    `json:"builtin"`
	Found    bool    `json:"found"`
	Kernel   string  `json:"kernel"`
}

// isBridge: PCI class 06 (bridges such as pcieport) needs no driver of its own.
func isBridge(modalias string) bool {
	i := strings.Index(modalias, "bc")
	return strings.HasPrefix(modalias, "pci:") && i >= 0 && strings.HasPrefix(modalias[i:], "bc06")
}

// bootKernels returns the facts of the default kernel and the next
// fallback kernel.
func bootKernels(m *Manifest, f *Facts) (def, fb *KernelFacts, defVersion string) {
	for _, k := range m.Linux.Kernels {
		if k.Default {
			defVersion = k.Version
			break
		}
	}
	if defVersion == "" && len(m.Linux.Kernels) > 0 {
		defVersion = m.Linux.Kernels[0].Version
	}
	if f == nil {
		return nil, nil, defVersion
	}
	for i := range f.Kernels {
		k := &f.Kernels[i]
		if k.Default || (def == nil && k.Version == defVersion) {
			if def == nil {
				def = k
			}
		}
	}
	for i := range f.Kernels {
		k := &f.Kernels[i]
		if k != def && fb == nil {
			fb = k
		}
	}
	if def != nil {
		defVersion = def.Version
	}
	return def, fb, defVersion
}

// CheckDrivers checks every modalias of the driver chain of each target
// disk that carries /, /boot, /usr or an ESP (bridges excepted) against
// the default kernel (a problem when missing) and the fallback kernel (a
// warning), and the network cards (warnings). bootTargets are the ids of
// those target disks. With otherController a missing storage driver is
// the warning other_controller_driver_missing.
func CheckDrivers(m *Manifest, f *Facts, t *Target, bootTargets []string, otherController bool) (DriverCheck, []Finding) {
	dc := DriverCheck{Storage: []DriverMatch{}, NICs: []DriverMatch{}}
	var out []Finding
	def, fb, defVersion := bootKernels(m, f)
	if defVersion != "" {
		dc.Kernel = strPtr(defVersion)
	}
	if fb != nil {
		dc.Fallback = strPtr(fb.Version)
	}
	if def == nil || def.ModulesAlias == "" {
		out = append(out, newFinding(WarnDriverFactsMissing, "", "kernel", defVersion))
		return dc, out
	}
	di := newKernelIndex(*def, m.Linux.DKMS)
	var fi *kernelIndex
	if fb != nil && fb.ModulesAlias != "" {
		fi = newKernelIndex(*fb, m.Linux.DKMS)
	}
	want := map[string]bool{}
	for _, id := range bootTargets {
		want[id] = true
	}
	ptr := func(s string) *string {
		if s == "" {
			return nil
		}
		return strPtr(s)
	}
	for _, td := range t.Disks {
		if !want[td.ID] {
			continue
		}
		for _, ma := range td.DriverModaliases {
			if isBridge(ma) {
				continue
			}
			mod, builtin, found := di.match(ma, td.DriverChain)
			dc.Storage = append(dc.Storage, DriverMatch{Device: td.ID, Modalias: ma, Module: ptr(mod), Builtin: builtin, Found: found, Kernel: di.version})
			if !found {
				guess := "?"
				if len(td.DriverChain) > 0 {
					guess = td.DriverChain[len(td.DriverChain)-1]
				}
				if otherController {
					out = append(out, newFinding(WarnOtherControllerDriverMissing, td.ID, "kernel", di.version, "modalias", ma, "module", guess, "target", TargetOtherController))
				} else {
					out = append(out, newFinding(ProblemStorageDriverMissing, td.ID, "kernel", di.version, "modalias", ma, "target", td.ID, "module", guess))
				}
				continue
			}
			if fi != nil {
				fmod, fbuiltin, ffound := fi.match(ma, td.DriverChain)
				dc.Storage = append(dc.Storage, DriverMatch{Device: td.ID, Modalias: ma, Module: ptr(fmod), Builtin: fbuiltin, Found: ffound, Kernel: fi.version})
				if !ffound {
					out = append(out, newFinding(WarnFallbackKernelDriverMissing, td.ID, "kernel", fi.version, "modalias", ma, "target", td.ID))
				}
			}
		}
	}
	for _, n := range t.NICs {
		ma := deref(n.Modalias)
		if ma == "" {
			continue
		}
		chain := []string{}
		if n.Driver != nil {
			chain = append(chain, *n.Driver)
		}
		mod, builtin, found := di.match(ma, chain)
		dc.NICs = append(dc.NICs, DriverMatch{Device: n.Name, Modalias: ma, Module: ptr(mod), Builtin: builtin, Found: found, Kernel: di.version})
		if !found {
			out = append(out, newFinding(WarnNICDriverMissing, n.Name, "kernel", di.version, "nic", n.Name, "modalias", ma))
		}
	}
	return dc, out
}
