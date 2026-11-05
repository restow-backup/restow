package recovery

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// Device-mapper devices outside the target (docs/BAREMETAL.md 10.14).
//
// A step that keeps CAP_SYS_ADMIN (grub-install, grub-mkconfig,
// vgimportdevices on LVM or LUKS) may send DM_TABLE_STATUS, and the kernel
// answers it for any mapping of the machine, not only for the nodes bound
// into the isolation. With DM_STATUS_TABLE_FLAG (a field inside struct
// dm_ioctl, which seccomp cannot read) the table of a dm-crypt mapping
// carries its volume key in hex unless the key sits in the kernel keyring
// (LUKS1, plain, a LUKS2 volume opened with --disable-keyring), and the
// table of a dm-integrity mapping its keyed hash. The command itself cannot
// be denied: grub-probe reads the table of a LUKS2 mapping of the target to
// learn its cipher (grub_util_pull_devmapper fails without it), and LVM
// checks with the status of a dm device whether it is usable. So recover
// runs such a step only while no mapping that could hold a key exists
// outside the target stack, and checks again after the step.

// DMMapping is one device-mapper device as sysfs shows it
// (/sys/class/block/dm-N: dm/name, dm/uuid, slaves).
type DMMapping struct {
	// Node is the kernel name (dm-3).
	Node string
	Name string
	UUID string
	// Slaves are the kernel names of what the mapping sits on.
	Slaves []string
}

// reKeylessDMUUID are the UUIDs of mappings whose table holds no key:
// logical volumes of LVM, multipath, dmraid and kpartx partitions
// (part<N>-...). Every other mapping, also one without a UUID (dmsetup
// create), counts as one that could hold a key (CRYPT-LUKS1-, CRYPT-PLAIN-,
// CRYPT-INTEGRITY-, ...).
var reKeylessDMUUID = regexp.MustCompile(`^(LVM-|mpath-|DMRAID-|part[0-9]+-)`)

// keylessMapping reports a mapping whose table holds no key.
func keylessMapping(m DMMapping) bool { return reKeylessDMUUID.MatchString(m.UUID) }

// dmAdminPrograms keep CAP_SYS_ADMIN when a device-mapper node is among
// the devices of their step (needsSysAdmin).
var dmAdminPrograms = map[string]bool{"grub-install": true, "grub2-install": true, "grub-mkconfig": true, "grub2-mkconfig": true,
	"update-grub": true, "vgimportdevices": true}

// foreignKeyMappings lists the mappings a step with CAP_SYS_ADMIN could
// read a key from: every device-mapper device that is neither among the
// step's devices (the target stack from DeviceSet) nor named in own (the
// volumes this run opened or accepted on the plan's partitions), unless
// its UUID marks a keyless kind.
func foreignKeyMappings(all []DMMapping, devices []string, own map[string]bool) []DMMapping {
	inStack, names := map[string]bool{}, map[string]bool{}
	for n, ok := range own {
		names[n] = ok
	}
	for _, d := range devices {
		if n, ok := strings.CutPrefix(d, "/dev/mapper/"); ok {
			names[n] = true
			continue
		}
		inStack[strings.TrimPrefix(d, "/dev/")] = true
	}
	var out []DMMapping
	for _, m := range all {
		if inStack[m.Node] || (m.Name != "" && names[m.Name]) || keylessMapping(m) {
			continue
		}
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Node < out[j].Node })
	return out
}

// openedNames are the volumes this run opened or accepted (luks_open).
func (x *Executor) openedNames() map[string]bool {
	own := map[string]bool{}
	for _, n := range x.opened {
		own[n] = true
	}
	return own
}

// describeMappings names the mappings for the operator and how to close
// each.
func describeMappings(ms []DMMapping) (names, closes string) {
	var n, c []string
	for _, m := range ms {
		name := m.Name
		if name == "" {
			name = m.Node
		}
		on := ""
		if len(m.Slaves) > 0 {
			on = " on " + strings.Join(m.Slaves, ", ")
		}
		n = append(n, fmt.Sprintf("/dev/mapper/%s (%s%s)", name, m.Node, on))
		if strings.HasPrefix(m.UUID, "CRYPT-") {
			c = append(c, "cryptsetup close "+name)
		} else {
			c = append(c, "dmsetup remove "+name)
		}
	}
	return strings.Join(n, ", "), strings.Join(c, "; ")
}

// foreignMappingError refuses a step (or the run) while such mappings are
// open.
func foreignMappingError(prog string, ms []DMMapping) error {
	names, closes := describeMappings(ms)
	return &problemError{code: ProblemForeignMappingOpen,
		err: fmt.Errorf("device-mapper devices outside the target disks are open: %s; %s keeps CAP_SYS_ADMIN and could read their keys, so it does not run; close them (%s), then start the recovery again and continue it",
			names, prog, closes),
		params: map[string]any{"mappings": names, "close": closes}}
}

// openedDuringError: a mapping appeared while the step ran (opened from
// another console); the program could have read its key.
func openedDuringError(prog string, ms []DMMapping) error {
	names, closes := describeMappings(ms)
	return &problemError{code: ProblemForeignMappingOpen,
		err: fmt.Errorf("device-mapper devices outside the target disks were opened while %s ran: %s; the program could have read their keys (treat the volume keys as known: cryptsetup reencrypt); close them (%s), then start the recovery again and continue it",
			prog, names, closes),
		params: map[string]any{"mappings": names, "close": closes}}
}

// planUsesDMAdmin reports a plan with a program that keeps CAP_SYS_ADMIN
// on a device-mapper stack (a grub or LVM program and an encrypted volume
// or a logical volume).
func planUsesDMAdmin(p *baremetal.RestorePlan) bool {
	admin, dm := false, false
	for _, s := range p.Steps {
		if len(s.Args) > 1 && s.Args[0] == "chroot-exec" && dmAdminPrograms[s.Args[1]] {
			admin = true
		}
		switch s.Kind {
		case "luks_open", "lv_create", "vg_activate":
			dm = true
		}
	}
	return admin && dm
}

// PreflightMappings refuses the run before its first step when the plan
// will run a program with CAP_SYS_ADMIN and a mapping that could hold a
// key is open outside the target disks (so the operator closes it before
// anything is erased, not in the middle of the post phase). Mappings on
// the target disks are released by the plan; a volume of the plan that is
// open already on its partition (resume) is the plan's.
func (x *Executor) PreflightMappings() error {
	if x.Ops == nil || !planUsesDMAdmin(x.Plan) {
		return nil
	}
	disks, _ := x.isolatedDevices("")
	devices, _ := x.Ops.DeviceSet(disks, nil)
	own := map[string]bool{}
	for _, s := range x.Plan.Steps {
		if s.Kind != "luks_open" || len(s.Args) < 2 {
			continue
		}
		name, src := x.subst(s.Args[len(s.Args)-1]), x.subst(s.Args[len(s.Args)-2])
		if on, _ := x.Ops.MappingOn(name, src); on {
			own[name] = true
		}
	}
	if f := foreignKeyMappings(x.Ops.DMMappings(), devices, own); len(f) > 0 {
		return foreignMappingError("a program of the target (grub, LVM)", f)
	}
	return nil
}
