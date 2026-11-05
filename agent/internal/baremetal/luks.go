package baremetal

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/restow-backup/restow/agent/internal/sysparse"
)

// crypttabEntry is a line of /etc/crypttab resolved to a device.
type crypttabEntry struct {
	sysparse.CrypttabLine
	node *blkNode
}

// keyFileOf returns the key file of a crypttab entry, or "" for none, "-",
// a random source or a key on another device ("/key:UUID=...").
func keyFileOf(e sysparse.CrypttabLine) string {
	k := e.KeyFile
	if before, _, ok := strings.Cut(k, ":"); ok {
		k = before
	}
	switch k {
	case "", "none", "-", "/dev/urandom", "/dev/random", "/dev/hw_random":
		return ""
	}
	if !strings.HasPrefix(k, "/") {
		return ""
	}
	return k
}

func (c *capture) loadCrypttab() {
	if c.crypttab != nil {
		return
	}
	c.crypttab = []crypttabEntry{}
	b, ok := c.readHost("/etc/crypttab")
	if !ok {
		return
	}
	for _, e := range sysparse.ParseCrypttab([]byte(b)) {
		c.crypttab = append(c.crypttab, crypttabEntry{CrypttabLine: e, node: c.nodeOfSpec(e.Device)})
	}
}

// luks2Metadata is the part of `cryptsetup luksDump --dump-json-metadata`
// the capture reads. Keyslot areas, digests, salts and token contents are
// in that output too; they are never decoded into anything kept.
type luks2Metadata struct {
	Keyslots map[string]struct {
		Type    string `json:"type"`
		KeySize int64  `json:"key_size"`
		KDF     struct {
			Type       string `json:"type"`
			Iterations *int64 `json:"iterations"`
			Time       *int64 `json:"time"`
			Memory     *int64 `json:"memory"`
			CPUs       *int64 `json:"cpus"`
		} `json:"kdf"`
	} `json:"keyslots"`
	Tokens map[string]struct {
		Type string `json:"type"`
	} `json:"tokens"`
	Segments map[string]struct {
		Type       string          `json:"type"`
		Encryption string          `json:"encryption"`
		SectorSize int64           `json:"sector_size"`
		Integrity  json.RawMessage `json:"integrity"`
	} `json:"segments"`
	Config struct {
		Flags        []string `json:"flags"`
		Requirements struct {
			Mandatory []string `json:"mandatory"`
		} `json:"requirements"`
	} `json:"config"`
}

// sanitizedLUKS is raw/luks-<id>.json: only what the manifest records.
type sanitizedLUKS struct {
	Version      int64           `json:"version"`
	UUID         string          `json:"uuid"`
	Cipher       string          `json:"cipher"`
	KeyBits      int64           `json:"keyBits"`
	SectorSize   int64           `json:"sectorSize"`
	Keyslots     []sanitizedSlot `json:"keyslots"`
	TokenTypes   []string        `json:"tokenTypes"`
	Flags        []string        `json:"flags"`
	Requirements []string        `json:"requirements"`
	Integrity    *string         `json:"integrity"`
}

type sanitizedSlot struct {
	Slot    string `json:"slot"`
	Type    string `json:"type"`
	KeyBits int64  `json:"keyBits"`
	PBKDF   PBKDF  `json:"pbkdf"`
}

// captureLUKS records each LUKS header (docs/BAREMETAL.md, 4.1): LUKS2
// from `cryptsetup luksDump --dump-json-metadata`, LUKS1 from the text of
// `cryptsetup luksDump`. Kept are version, cipher, key size, sector size,
// the KDF of each slot, the number of slots, the token types and the flags;
// never a header backup, keyslot data, digests, salts or token contents.
func captureLUKS(c *capture) error {
	c.loadCrypttab()
	var nodes []*blkNode
	for n := range c.luksOf {
		nodes = append(nodes, n)
	}
	sort.Slice(nodes, func(i, j int) bool { return idNum(c.luksOf[nodes[i]]) < idNum(c.luksOf[nodes[j]]) })
	var errs []string
	for _, n := range nodes {
		id := c.luksOf[n]
		ref, ok := c.refOf(n)
		if !ok {
			c.note(CodeUnknownDeviceInBootPath, n.kname(), "LUKS volume on "+n.kname()+" sits on an unknown device", SeverityUnsupported)
			continue
		}
		dev := n.path()
		v := LUKSVolume{ID: id, Device: ref, UUID: clean(n.str("uuid")), Label: cleanPtr(n.str("label"))}
		bid := c.blkidOf(dev)
		if s := bid["SUBSYSTEM"]; s != "" {
			v.Subsystem = strPtr(clean(s))
		}
		if v.Label == nil && bid["LABEL"] != "" {
			v.Label = strPtr(clean(bid["LABEL"]))
		}
		if v.UUID == "" {
			v.UUID = clean(bid["UUID"])
		}
		ver := n.str("fsver")
		if ver == "" {
			ver = bid["VERSION"]
		}
		san := sanitizedLUKS{}
		if ver == "1" {
			out, err := c.run("cryptsetup", "luksDump", dev)
			if err != nil {
				errs = append(errs, fmt.Sprintf("%s: %v", dev, err))
				continue
			}
			parseLUKS1(string(out), &v, &san)
		} else {
			out, err := c.run("cryptsetup", "luksDump", "--dump-json-metadata", dev)
			if err != nil {
				errs = append(errs, fmt.Sprintf("%s: %v", dev, err))
				continue
			}
			if err := parseLUKS2(out, &v, &san); err != nil {
				errs = append(errs, fmt.Sprintf("%s: %v", dev, err))
				continue
			}
		}
		for _, ch := range n.children {
			if ch.typ() == "crypt" {
				v.MappedName = strPtr(clean(ch.str("name")))
				break
			}
		}
		for _, e := range c.crypttab {
			if e.node != n {
				continue
			}
			v.CrypttabName = strPtr(clean(e.Name))
			if k := keyFileOf(e.CrypttabLine); k != "" {
				v.KeyFile = strPtr(clean(k))
			}
			if sysparse.HasOption(e.Options, "header") {
				c.note(CodeLUKSDetachedHeader, id, "", SeverityUnsupported)
			}
		}
		san.UUID = v.UUID
		c.l.LUKS = append(c.l.LUKS, v)
		b, _ := json.MarshalIndent(san, "", "  ")
		c.addRaw("luks-"+id+".json", append(b, '\n'))
	}
	// Detached headers: a crypttab entry with header= whose device carries
	// no LUKS signature.
	for _, e := range c.crypttab {
		if sysparse.HasOption(e.Options, "header") {
			c.note(CodeLUKSDetachedHeader, e.Name, "", SeverityUnsupported)
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

func idNum(id string) int {
	n, _ := strconv.Atoi(id[1:])
	return n
}

func parseLUKS2(out []byte, v *LUKSVolume, san *sanitizedLUKS) error {
	var md luks2Metadata
	if err := json.Unmarshal(out, &md); err != nil {
		return fmt.Errorf("LUKS2 metadata: %w", err)
	}
	v.Version, san.Version = 2, 2
	slots := make([]string, 0, len(md.Keyslots))
	for k := range md.Keyslots {
		slots = append(slots, k)
	}
	sort.Slice(slots, func(i, j int) bool { a, _ := strconv.Atoi(slots[i]); b, _ := strconv.Atoi(slots[j]); return a < b })
	for i, k := range slots {
		ks := md.Keyslots[k]
		p := PBKDF{Type: clean(ks.KDF.Type), Iterations: ks.KDF.Iterations, Time: ks.KDF.Time, MemoryKiB: ks.KDF.Memory, Parallel: ks.KDF.CPUs}
		if i == 0 {
			v.PBKDF = p
			v.KeyBits = ks.KeySize * 8
		}
		san.Keyslots = append(san.Keyslots, sanitizedSlot{Slot: clean(k), Type: clean(ks.Type), KeyBits: ks.KeySize * 8, PBKDF: p})
	}
	v.Keyslots = int64(len(slots))
	types := map[string]bool{}
	for _, t := range md.Tokens {
		if t.Type != "" {
			types[clean(t.Type)] = true
		}
	}
	v.TokenTypes = sortedKeys(types)
	if seg, ok := md.Segments["0"]; ok {
		v.Cipher = clean(seg.Encryption)
		v.SectorSize = seg.SectorSize
		if len(seg.Integrity) > 0 && string(seg.Integrity) != "null" {
			var integ struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(seg.Integrity, &integ) == nil && integ.Type != "" {
				v.Integrity = strPtr(clean(integ.Type))
			}
		}
	}
	v.Flags = cleanList(md.Config.Flags)
	v.Requirements = cleanList(md.Config.Requirements.Mandatory)
	san.Cipher, san.KeyBits, san.SectorSize = v.Cipher, v.KeyBits, v.SectorSize
	san.TokenTypes, san.Flags, san.Requirements, san.Integrity = v.TokenTypes, v.Flags, v.Requirements, v.Integrity
	return nil
}

// parseLUKS1 reads the text of `cryptsetup luksDump` for a LUKS1 header.
func parseLUKS1(out string, v *LUKSVolume, san *sanitizedLUKS) {
	v.Version, san.Version = 1, 1
	v.SectorSize = 512
	v.PBKDF = PBKDF{Type: "pbkdf2"}
	var cipher, mode string
	slot := ""
	for _, line := range strings.Split(out, "\n") {
		t := strings.TrimSpace(line)
		k, val, ok := strings.Cut(t, ":")
		if !ok {
			continue
		}
		val = strings.TrimSpace(val)
		switch {
		case k == "Cipher name":
			cipher = val
		case k == "Cipher mode":
			mode = val
		case k == "MK bits":
			v.KeyBits, _ = strconv.ParseInt(val, 10, 64)
		case k == "UUID" && v.UUID == "":
			v.UUID = clean(val)
		case strings.HasPrefix(k, "Key Slot "):
			slot = ""
			if val == "ENABLED" {
				slot = strings.TrimPrefix(k, "Key Slot ")
				v.Keyslots++
				san.Keyslots = append(san.Keyslots, sanitizedSlot{Slot: slot, Type: "luks1", KeyBits: v.KeyBits, PBKDF: PBKDF{Type: "pbkdf2"}})
			}
		case k == "Iterations" && slot != "":
			if n, err := strconv.ParseInt(val, 10, 64); err == nil {
				san.Keyslots[len(san.Keyslots)-1].PBKDF.Iterations = &n
				if v.PBKDF.Iterations == nil {
					v.PBKDF.Iterations = &n
				}
			}
		}
	}
	v.Cipher = clean(cipher + "-" + mode)
	v.TokenTypes, v.Flags, v.Requirements = []string{}, []string{}, []string{}
	san.Cipher, san.KeyBits, san.SectorSize = v.Cipher, v.KeyBits, v.SectorSize
	san.TokenTypes, san.Flags, san.Requirements = v.TokenTypes, v.Flags, v.Requirements
}

func cleanList(in []string) []string {
	out := []string{}
	for _, s := range in {
		if s = clean(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}
