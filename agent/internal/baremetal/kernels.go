package baremetal

import (
	"bytes"
	"encoding/binary"
	"path"
	"sort"
	"strings"
)

// captureKernels lists the installed kernels (/lib/modules/<version>) with
// their image and initramfs, which one runs (the default of this boot),
// and the signer of the image; UKIs on the ESP count as kernels too.
func captureKernels(c *capture) error {
	var versions []string
	for _, base := range []string{"/lib/modules", "/usr/lib/modules"} {
		ents, err := c.h.ReadDir(base)
		if err != nil {
			continue
		}
		for _, e := range ents {
			if e.IsDir() {
				versions = append(versions, e.Name())
			}
		}
		if len(versions) > 0 {
			break
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(versions)))
	seen := map[string]bool{}
	for _, v := range versions {
		if seen[v] || len(c.l.Kernels) >= maxKernels {
			continue
		}
		seen[v] = true
		image := firstExisting(c.h, "/boot/vmlinuz-"+v, "/boot/vmlinux-"+v, "/lib/modules/"+v+"/vmlinuz", "/usr/lib/modules/"+v+"/vmlinuz")
		if image == "" {
			continue
		}
		k := Kernel{Version: clean(v), Image: clean(image), Default: v == c.l.OS.Kernel}
		if st, err := c.h.Stat(image); err == nil {
			k.ImageBytes = st.Size()
		}
		if ird := firstExisting(c.h, "/boot/initrd.img-"+v, "/boot/initramfs-"+v+".img", "/boot/initrd-"+v, "/boot/initramfs-linux.img"); ird != "" {
			k.Initramfs = strPtr(clean(ird))
			if st, err := c.h.Stat(ird); err == nil {
				n := st.Size()
				k.InitramfsBytes = &n
			}
		}
		if r, size, err := c.h.Open(image); err == nil {
			if info, err := InspectLoader(r, size); err == nil && info.Signer != nil {
				k.Signer = strPtr(subjectCN(info.Signer.Subject))
			}
			r.Close()
		}
		c.l.Kernels = append(c.l.Kernels, k)
	}
	for _, ld := range c.l.Loaders {
		if !ld.UKI || len(c.l.Kernels) >= maxKernels {
			continue
		}
		k := Kernel{Version: clean(strings.TrimSuffix(path.Base(ld.Path), path.Ext(ld.Path))), Image: ld.Path, ImageBytes: ld.Bytes, UKI: true}
		if ld.Signer != nil {
			k.Signer = strPtr(subjectCN(ld.Signer.Subject))
		}
		c.l.Kernels = append(c.l.Kernels, k)
	}
	return nil
}

func firstExisting(h Host, paths ...string) string {
	for _, p := range paths {
		if st, err := h.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

// netDrivers and storageDrivers classify DKMS modules by name.
var (
	netDriverPrefixes     = []string{"r8125", "r8126", "r8168", "r8169", "r8152", "e1000", "igb", "igc", "ixgbe", "i40e", "ice", "mlx", "bnx", "bnxt", "tg3", "atlantic", "aq", "wl", "rtl", "iwl", "8821", "88x2", "ena", "vmxnet", "qede", "sfc", "nfp", "tn40", "jool"}
	storageDriverPrefixes = []string{"nvme", "megaraid", "mpt", "mpi3mr", "aacraid", "hpsa", "smartpqi", "arcmsr", "lpfc", "qla", "zfs", "spl", "hptiop", "rr", "esas", "vroc", "dm-", "vdo", "kvdo"}
)

func driverKind(module string) string {
	m := strings.ToLower(module)
	for _, p := range storageDriverPrefixes {
		if strings.HasPrefix(m, p) {
			return "storage"
		}
	}
	for _, p := range netDriverPrefixes {
		if strings.HasPrefix(m, p) {
			return "net"
		}
	}
	return "other"
}

// moduleSigMagic ends a signed kernel module.
var moduleSigMagic = []byte("~Module signature appended~\n")

// captureDKMS lists DKMS modules (/var/lib/dkms/<module>/<version>/<kernel>)
// with the signer of the built module, and the MOK files on disk.
func captureDKMS(c *capture) error {
	mods, _ := c.h.ReadDir("/var/lib/dkms")
	for _, m := range mods {
		if !m.IsDir() {
			continue
		}
		vers, _ := c.h.ReadDir("/var/lib/dkms/" + m.Name())
		for _, v := range vers {
			if !v.IsDir() || v.Name() == "source" {
				continue
			}
			kernels, _ := c.h.ReadDir("/var/lib/dkms/" + m.Name() + "/" + v.Name())
			for _, k := range kernels {
				if !k.IsDir() || k.Name() == "source" || k.Name() == "build" || len(c.l.DKMS) >= maxDKMS {
					continue
				}
				d := DKMSModule{Module: clean(m.Name()), Version: clean(v.Name()), Kernel: clean(k.Name()), Kind: driverKind(m.Name())}
				kos, _ := c.h.Glob("/lib/modules/" + k.Name() + "/updates/dkms/" + m.Name() + ".ko*")
				for _, ko := range kos {
					if s := moduleSigner(c.h, ko); s != "" {
						d.Signer = strPtr(clean(s))
						break
					}
				}
				c.l.DKMS = append(c.l.DKMS, d)
			}
		}
	}
	for _, p := range []string{"/var/lib/shim-signed/mok/MOK.der", "/var/lib/dkms/mok.pub"} {
		if b, err := c.h.ReadFile(p, 1<<20); err == nil && len(c.l.MokFiles) < maxMokFiles {
			c.l.MokFiles = append(c.l.MokFiles, FileHash{Path: p, SHA256: sha256Hex(b)})
		}
	}
	return nil
}

// moduleSigner reads the PKCS#7 signature at the end of a module
// (struct module_signature before the magic) and returns the signer's
// issuer CN. Compressed modules are not read.
func moduleSigner(h Host, p string) string {
	if !strings.HasSuffix(p, ".ko") {
		return ""
	}
	r, size, err := h.Open(p)
	if err != nil {
		return ""
	}
	defer r.Close()
	tail := int64(64 << 10)
	if tail > size {
		tail = size
	}
	buf := make([]byte, tail)
	if _, err := r.ReadAt(buf, size-tail); err != nil {
		return ""
	}
	if !bytes.HasSuffix(buf, moduleSigMagic) {
		return ""
	}
	end := len(buf) - len(moduleSigMagic)
	if end < 12 {
		return ""
	}
	info := buf[end-12 : end]
	if info[2] != 2 { // PKEY_ID_PKCS7
		return ""
	}
	sigLen := int(binary.BigEndian.Uint32(info[8:12]))
	start := end - 12 - sigLen
	if start < 0 {
		return ""
	}
	s, err := pkcs7Signer(buf[start : end-12])
	if err != nil || s == nil {
		return ""
	}
	if s.Subject != "" {
		return subjectCN(s.Subject)
	}
	return subjectCN(s.Issuer)
}
