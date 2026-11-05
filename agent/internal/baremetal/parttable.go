package baremetal

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

type sfdiskPart struct {
	Node     string `json:"node"`
	Start    int64  `json:"start"`
	Size     int64  `json:"size"`
	Type     string `json:"type"`
	UUID     string `json:"uuid"`
	Name     string `json:"name"`
	Attrs    string `json:"attrs"`
	Bootable bool   `json:"bootable"`
}

type sfdiskTable struct {
	PartitionTable struct {
		Label      string       `json:"label"`
		ID         string       `json:"id"`
		Device     string       `json:"device"`
		Unit       string       `json:"unit"`
		FirstLBA   *int64       `json:"firstlba"`
		LastLBA    *int64       `json:"lastlba"`
		SectorSize int64        `json:"sectorsize"`
		Partitions []sfdiskPart `json:"partitions"`
	} `json:"partitiontable"`
}

// capturePartitionTables reads `sfdisk --json` and `sfdisk --dump` of every
// disk with a partition table. Starts and sizes are stored in bytes.
func capturePartitionTables(c *capture) error {
	var errs []string
	for i := range c.l.Disks {
		d := &c.l.Disks[i]
		n := c.byKName[d.KName]
		if n == nil || n.str("pttype") == "" {
			continue
		}
		dev := n.path()
		out, err := c.run("sfdisk", "--json", dev)
		if err != nil {
			if strings.Contains(err.Error(), "not installed") {
				return ErrToolsMissing
			}
			errs = append(errs, fmt.Sprintf("%s: %v", dev, err))
			continue
		}
		var t sfdiskTable
		if err := json.Unmarshal(out, &t); err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", dev, err))
			continue
		}
		pt := t.PartitionTable
		sector := pt.SectorSize
		if sector == 0 {
			sector = d.LogicalSectorSize
		}
		if sector == 0 {
			sector = 512
		}
		table := &PartitionTable{Type: pt.Label, ID: clean(pt.ID), SectorSize: sector, FirstLBA: pt.FirstLBA, LastLBA: pt.LastLBA}
		if dump, err := c.run("sfdisk", "--dump", dev); err == nil {
			c.addRaw("sfdisk-"+d.ID+".dump", dump)
			for _, line := range strings.Split(string(dump), "\n") {
				if v, ok := strings.CutPrefix(strings.TrimSpace(line), "table-length:"); ok {
					if x, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
						table.TableLength = &x
					}
				}
			}
		}
		for _, p := range pt.Partitions {
			if len(table.Partitions) >= maxPartitions {
				break
			}
			num := int64(0)
			if pn := c.byPath[p.Node]; pn != nil {
				num = pn.partNumber()
			}
			if num == 0 {
				if m := rePartSuffix.FindString(p.Node); m != "" {
					num, _ = strconv.ParseInt(m, 10, 64)
				}
			}
			if num == 0 {
				continue
			}
			table.Partitions = append(table.Partitions, Partition{Number: num, StartBytes: p.Start * sector, SizeBytes: p.Size * sector,
				Type: clean(p.Type), UUID: cleanPtr(p.UUID), Name: cleanPtr(p.Name), Attrs: clean(p.Attrs), Bootable: p.Bootable})
		}
		d.Table = table
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

// captureBootCode reads the first sector of each disk: GRUB's boot code in
// the MBR, and on GPT the active flag of the protective MBR (byte 446).
func captureBootCode(c *capture) error {
	for i := range c.l.Disks {
		d := &c.l.Disks[i]
		f, size, err := c.h.Open("/dev/" + d.KName)
		if err != nil {
			continue
		}
		buf := make([]byte, 512)
		_, rerr := f.ReadAt(buf, 0)
		f.Close()
		if rerr != nil || size < 512 {
			continue
		}
		code := buf[:440]
		switch {
		case bytes.Contains(code, []byte("GRUB")):
			d.BootCode = "grub"
		case bytes.Count(code, []byte{0}) == len(code):
			d.BootCode = "none"
		default:
			d.BootCode = "other"
		}
		if d.Table != nil && d.Table.Type == "gpt" {
			d.PMBRBoot = buf[446] == 0x80
		}
	}
	return nil
}
