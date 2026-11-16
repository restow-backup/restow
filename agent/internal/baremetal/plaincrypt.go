package baremetal

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/restow-backup/restow/agent/internal/sysparse"
)

// capturePlainCrypt records dm-crypt mappings without a LUKS header (swap
// and /tmp with a random key) from `dmsetup table --target crypt` and
// crypttab. dmsetup prints the key masked unless asked with --showkeys,
// which the agent never passes (cmdrun refuses it).
func capturePlainCrypt(c *capture) error {
	if len(c.plainOf) == 0 {
		return nil
	}
	c.loadCrypttab()
	out, err := c.run("dmsetup", "table", "--target", "crypt")
	if err != nil {
		return err
	}
	tables := map[string][]string{}
	for _, line := range strings.Split(string(out), "\n") {
		name, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) >= 7 && f[2] == "crypt" {
			tables[strings.TrimSpace(name)] = f
		}
	}
	var nodes []*blkNode
	for n := range c.plainOf {
		nodes = append(nodes, n)
	}
	sort.Slice(nodes, func(i, j int) bool { return idNum(c.plainOf[nodes[i]]) < idNum(c.plainOf[nodes[j]]) })
	var errs []string
	for _, n := range nodes {
		name := n.str("name")
		f, ok := tables[name]
		if !ok {
			errs = append(errs, fmt.Sprintf("no crypt table for %s", name))
			continue
		}
		parent := c.byKName[n.str("pkname")]
		if dev := c.nodeOfDevice(f[6]); dev != nil {
			parent = dev
		}
		ref, ok := c.refOf(parent)
		if !ok {
			c.note(CodeUnknownDeviceInBootPath, name, "plain dm-crypt "+name+" sits on an unknown device", SeverityUnsupported)
			continue
		}
		p := PlainCrypt{ID: c.plainOf[n], Device: ref, MappedName: clean(name), Cipher: clean(f[3]), KeyBits: keyBitsOf(f[4]),
			Purpose: "plain", KeySource: "unknown"}
		if parent != nil {
			p.PartUUID = cleanPtr(parent.str("partuuid"))
		}
		for _, e := range c.crypttab {
			if e.Name != name {
				continue
			}
			p.CrypttabName = strPtr(clean(e.Name))
			switch {
			case sysparse.HasOption(e.Options, "swap"):
				p.Purpose = "swap"
			case sysparse.HasOption(e.Options, "tmp"):
				p.Purpose = "tmp"
			}
			if e.KeyFile != "" {
				p.KeySource = clean(e.KeyFile)
			}
		}
		c.l.PlainCrypt = append(c.l.PlainCrypt, p)
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

// keyBitsOf reads the key size from a masked dm-crypt key: hex digits
// (4 bits each) or a keyring reference ":<bytes>:<type>:<description>".
func keyBitsOf(key string) int64 {
	if strings.HasPrefix(key, ":") {
		parts := strings.SplitN(key[1:], ":", 2)
		if n, err := strconv.ParseInt(parts[0], 10, 64); err == nil {
			return n * 8
		}
		return 0
	}
	if key == "-" {
		return 0
	}
	return int64(len(key)) * 4
}
