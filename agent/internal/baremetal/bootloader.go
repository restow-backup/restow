package baremetal

import (
	"path"
	"strings"

	"github.com/restow-backup/restow/agent/internal/sysparse"
)

// captureBootloader works out the boot loader from its files: GRUB (with
// its platform, BLS, grub.cfg location, device.map, BIOS target disks) or
// systemd-boot, shim, the ESPs and XBOOTLDR, the vendor directory and the
// fallback chain (fbx64.efi, BOOTX64.CSV), proxmox-boot-tool.
func captureBootloader(c *capture) error {
	b := &c.l.Bootloader
	esps, xb := c.bootPartitions()
	b.ESPs = esps
	if xb != "" {
		b.XBootLdr = strPtr(xb)
	}
	espMount := ""
	for _, id := range esps {
		if m := c.mountTargetOf(id); m != "" {
			espMount = m
			break
		}
	}
	if espMount != "" {
		b.EFIDirectory = strPtr(espMount)
	}
	for _, ld := range c.l.Loaders {
		base := strings.ToLower(path.Base(ld.Path))
		if strings.HasPrefix(base, "shim") {
			b.Shim = true
		}
		dir := path.Base(path.Dir(ld.Path))
		if b.BootloaderID == nil && !strings.EqualFold(dir, "BOOT") && !strings.EqualFold(dir, "Linux") &&
			(strings.HasPrefix(base, "shim") || strings.HasPrefix(base, "grub")) {
			b.BootloaderID = strPtr(clean(dir))
		}
		if base == "fbx64.efi" || base == "fbaa64.efi" {
			b.FallbackChain = true
		}
	}
	if espMount != "" {
		if csv, _ := c.h.Glob(espMount + "/EFI/*/BOOT*.CSV"); len(csv) > 0 {
			b.FallbackChain = true
		}
	}
	sdboot := false
	if espMount != "" {
		sdboot = exists(c.h, espMount+"/loader/loader.conf") || exists(c.h, espMount+"/EFI/systemd/systemd-bootx64.efi") ||
			exists(c.h, espMount+"/EFI/systemd/systemd-bootaa64.efi")
	}
	grubCfg := ""
	for _, p := range []string{"/boot/grub/grub.cfg", "/boot/grub2/grub.cfg"} {
		if exists(c.h, p) {
			grubCfg = p
			break
		}
	}
	if grubCfg == "" && espMount != "" {
		if m, _ := c.h.Glob(espMount + "/EFI/*/grub.cfg"); len(m) > 0 {
			grubCfg = m[0]
		}
	}
	switch {
	case sdboot && (c.l.Firmware.Mode == "uefi" || grubCfg == ""):
		b.Kind = "systemd-boot"
	case grubCfg != "" || exists(c.h, "/etc/default/grub"):
		b.Kind = "grub"
	case len(c.l.Loaders) > 0:
		b.Kind = "other"
	default:
		b.Kind = "none"
	}
	if b.Kind == "grub" {
		if grubCfg != "" {
			b.GrubCfg = strPtr(grubCfg)
		}
		for _, dir := range []string{"/boot/grub", "/boot/grub2"} {
			efiPlat, biosPlat := exists(c.h, dir+"/x86_64-efi"), exists(c.h, dir+"/i386-pc")
			switch {
			case c.l.Firmware.Mode == "uefi" && efiPlat:
				b.Platform = strPtr("x86_64-efi")
			case c.l.Firmware.Mode == "uefi" && exists(c.h, dir+"/arm64-efi"):
				b.Platform = strPtr("arm64-efi")
			case biosPlat && b.Platform == nil:
				b.Platform = strPtr("i386-pc")
			}
			if exists(c.h, dir+"/device.map") {
				b.DeviceMap = true
			}
		}
		if b.Platform == nil && c.l.Firmware.Mode == "uefi" {
			b.Platform = strPtr("x86_64-efi")
		}
		if c.l.Firmware.Mode == "bios" || deref(b.Platform) == "i386-pc" {
			for _, d := range c.l.Disks {
				if d.BootCode == "grub" {
					b.BIOSDisks = append(b.BIOSDisks, d.ID)
				}
			}
		}
	}
	if m, _ := c.h.Glob("/boot/loader/entries/*.conf"); len(m) > 0 {
		b.BLS = true
	} else if espMount != "" {
		if m, _ := c.h.Glob(espMount + "/loader/entries/*.conf"); len(m) > 0 {
			b.BLS = true
		}
	}
	b.ProxmoxBootTool = exists(c.h, "/etc/kernel/proxmox-boot-uuids")
	return nil
}

// captureInitramfs works out the initramfs generator and the keyboard
// layout the initramfs uses (docs/BAREMETAL.md, 4.1).
func captureInitramfs(c *capture) error {
	in := &c.l.Initramfs
	kv := func(p string) map[string]string {
		b, ok := c.readHost(p)
		if !ok {
			return map[string]string{}
		}
		return sysparse.ParseOSRelease([]byte(b))
	}
	vconsole := kv("/etc/vconsole.conf")
	keymapFromVconsole := func() {
		if v := vconsole["KEYMAP"]; v != "" {
			in.Keymap.Layout = strPtr(clean(v))
			in.Keymap.Source = strPtr("/etc/vconsole.conf")
		}
	}
	switch {
	case exists(c.h, "/etc/initramfs-tools/initramfs.conf"):
		in.Generator = strPtr("initramfs-tools")
		conf := kv("/etc/initramfs-tools/initramfs.conf")
		if v := conf["MODULES"]; v != "" {
			in.Modules = strPtr(clean(v))
		}
		kb := kv("/etc/default/keyboard")
		if v := kb["XKBLAYOUT"]; v != "" {
			in.Keymap.Layout = strPtr(clean(v))
			in.Keymap.Source = strPtr("/etc/default/keyboard")
			if x := kb["XKBVARIANT"]; x != "" {
				in.Keymap.Variant = strPtr(clean(x))
			}
		}
		in.Keymap.InInitramfs = strings.EqualFold(conf["KEYMAP"], "y")
	case exists(c.h, "/etc/mkinitcpio.conf"):
		in.Generator = strPtr("mkinitcpio")
		conf := kv("/etc/mkinitcpio.conf")
		hooks := strings.Trim(conf["HOOKS"], "()")
		for _, h := range strings.Fields(hooks) {
			if h == "keymap" || h == "sd-vconsole" {
				in.Keymap.InInitramfs = true
			}
		}
		keymapFromVconsole()
		presets, _ := c.h.Glob("/etc/mkinitcpio.d/*.preset")
		for _, p := range presets {
			if b, ok := c.readHost(p); ok && strings.Contains(b, "default_uki=") {
				for _, line := range strings.Split(b, "\n") {
					if t := strings.TrimSpace(line); strings.HasPrefix(t, "default_uki=") {
						in.UKIPresets = true
					}
				}
			}
		}
	case exists(c.h, "/etc/dracut.conf") || exists(c.h, "/etc/dracut.conf.d") || exists(c.h, "/usr/bin/dracut"):
		in.Generator = strPtr("dracut")
		files := []string{"/etc/dracut.conf"}
		more, _ := c.h.Glob("/etc/dracut.conf.d/*.conf")
		files = append(files, more...)
		add := map[string]bool{}
		for _, f := range files {
			b, ok := c.readHost(f)
			if !ok {
				continue
			}
			conf := sysparse.ParseOSRelease([]byte(b))
			switch strings.Trim(conf["hostonly"], `"`) {
			case "yes":
				in.Hostonly = boolPtr(true)
			case "no":
				in.Hostonly = boolPtr(false)
			}
			for _, line := range strings.Split(b, "\n") {
				t := strings.TrimSpace(line)
				if v, ok := strings.CutPrefix(t, "add_device+="); ok {
					for _, d := range strings.Fields(strings.Trim(v, `"' `)) {
						add[clean(d)] = true
					}
				}
			}
		}
		in.AddDevices = sortedKeys(add)
		keymapFromVconsole()
		in.Keymap.InInitramfs = in.Keymap.Layout != nil
	case exists(c.h, "/sbin/mkinitfs") || exists(c.h, "/usr/sbin/mkinitfs"):
		in.Generator = strPtr("other")
	}
	if v, ok := cmdlineValue(c.cmdline, "rd.vconsole.keymap"); ok && v != "" {
		in.Keymap.Layout = strPtr(clean(v))
		in.Keymap.Variant = nil
		in.Keymap.Source = strPtr("cmdline")
		in.Keymap.InInitramfs = true
	}
	if conf := kv("/etc/kernel/install.conf"); conf["layout"] != "" {
		in.KernelInstallLayout = strPtr(clean(conf["layout"]))
	}
	grub := kv("/etc/default/grub")
	in.Keymap.GrubCryptodisk = strings.EqualFold(grub["GRUB_ENABLE_CRYPTODISK"], "y")
	return nil
}
