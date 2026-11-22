// Package isotest writes small ISO 9660 images for tests of the oneshot
// payload and the oneshot command. It is imported by tests only.
package isotest

import (
	"bytes"
	"encoding/binary"
	"sort"
	"strings"
)

const sectorSize = 2048

// Options change how Build writes the image.
type Options struct {
	NoRockRidge bool
	// Mutate changes the image after it is built.
	Mutate func(img []byte)
}

type isoNode struct {
	name     string
	children map[string]*isoNode
	data     []byte
	dir      bool
	extent   uint32
	size     uint32
}

// Build writes a small ISO 9660 image with Rock Ridge names (NM) and an SP
// entry on the root, like xorriso writes. files maps absolute paths to
// contents; directories are made as needed.
func Build(files map[string][]byte, o Options) []byte {
	root := &isoNode{dir: true, children: map[string]*isoNode{}}
	for p, d := range files {
		parts := strings.Split(strings.Trim(p, "/"), "/")
		cur := root
		for i, part := range parts {
			if i == len(parts)-1 {
				cur.children[part] = &isoNode{name: part, data: d}
				break
			}
			next, ok := cur.children[part]
			if !ok {
				next = &isoNode{name: part, dir: true, children: map[string]*isoNode{}}
				cur.children[part] = next
			}
			cur = next
		}
	}
	// Layout: sectors 0-15 empty, 16 PVD, 17 terminator, then directories
	// (one sector each), then files.
	next := uint32(18)
	var dirs []*isoNode
	var walk func(n *isoNode)
	walk = func(n *isoNode) {
		n.extent = next
		n.size = sectorSize
		next++
		dirs = append(dirs, n)
		for _, k := range sortedKeys(n.children) {
			if c := n.children[k]; c.dir {
				walk(c)
			}
		}
	}
	walk(root)
	var filesOrder []*isoNode
	var collect func(n *isoNode)
	collect = func(n *isoNode) {
		for _, k := range sortedKeys(n.children) {
			c := n.children[k]
			if c.dir {
				collect(c)
				continue
			}
			c.extent = next
			c.size = uint32(len(c.data))
			next += (c.size + sectorSize - 1) / sectorSize
			if c.size == 0 {
				next++
			}
			filesOrder = append(filesOrder, c)
		}
	}
	collect(root)
	img := make([]byte, int(next)*sectorSize)
	pvd := img[16*sectorSize:]
	pvd[0] = 1
	copy(pvd[1:6], "CD001")
	pvd[6] = 1
	binary.LittleEndian.PutUint16(pvd[128:130], sectorSize)
	copy(pvd[156:], record(root, "\x00", nil))
	term := img[17*sectorSize:]
	term[0] = 255
	copy(term[1:6], "CD001")
	for _, d := range dirs {
		var b bytes.Buffer
		var sp []byte
		if d == root && !o.NoRockRidge {
			sp = []byte{'S', 'P', 7, 1, 0xBE, 0xEF, 0}
		}
		b.Write(record(d, "\x00", sp))
		b.Write(record(d, "\x01", nil))
		for _, k := range sortedKeys(d.children) {
			c := d.children[k]
			var nm []byte
			if !o.NoRockRidge {
				nm = append([]byte{'N', 'M', byte(5 + len(c.name)), 1, 0}, c.name...)
			}
			b.Write(record(c, isoName(c), nm))
		}
		copy(img[int(d.extent)*sectorSize:], b.Bytes())
	}
	for _, f := range filesOrder {
		copy(img[int(f.extent)*sectorSize:], f.data)
	}
	if o.Mutate != nil {
		o.Mutate(img)
	}
	return img
}

func isoName(n *isoNode) string {
	s := strings.ToUpper(strings.ReplaceAll(n.name, "-", "_"))
	if n.dir {
		return s
	}
	if !strings.Contains(s, ".") {
		s += "."
	}
	return s + ";1"
}

func record(n *isoNode, id string, susp []byte) []byte {
	l := 33 + len(id)
	if len(id)%2 == 0 {
		l++
	}
	l += len(susp)
	if l%2 == 1 {
		l++
	}
	r := make([]byte, l)
	r[0] = byte(l)
	binary.LittleEndian.PutUint32(r[2:6], n.extent)
	binary.BigEndian.PutUint32(r[6:10], n.extent)
	binary.LittleEndian.PutUint32(r[10:14], n.size)
	binary.BigEndian.PutUint32(r[14:18], n.size)
	if n.dir {
		r[25] = 2
	}
	r[32] = byte(len(id))
	copy(r[33:], id)
	su := 33 + len(id)
	if len(id)%2 == 0 {
		su++
	}
	copy(r[su:], susp)
	return r
}

func sortedKeys(m map[string]*isoNode) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
