// Package pve is restow-pve, the node helper for Proxmox VE backups
// (docs/PVE.md, docs/PROXMOX.md section 2). It receives the calls of the PVE
// storage plugin shim (`restow-pve provider <verb>`, JSON over stdin and
// stdout, docs/PVE-PROTOCOL.md), reads VM disks over NBD, backs up containers
// with restic, talks to the Restow server under /agent/pve/v1 and to the
// local PVE API with the node's API token.
//
// This file holds the binary formats shared with the server
// (packages/core/src/pve/formats.ts); both sides must change together.
package pve

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// BlockSize is the unit of VM disk backups: 4 MiB, the granularity of the
// QEMU dirty bitmap PVE sets up for backup access.
const BlockSize = 4 << 20

// MaxBlocksPerFrame bounds one upload request.
const MaxBlocksPerFrame = 16

// Block flags (frame entries, hash lists).
const (
	FlagZero    byte = 1 << 0
	FlagPresent byte = 1 << 1
)

var (
	frameMagic  = [4]byte{'R', 'S', 'B', 'F'}
	hashesMagic = [4]byte{'R', 'S', 'B', 'H'}
)

// BlockCount is the number of blocks of a disk of size bytes.
func BlockCount(size uint64) uint32 {
	return uint32((size + BlockSize - 1) / BlockSize)
}

// BlockLen is the length of block index of a disk of size bytes (the last
// one may be short).
func BlockLen(size uint64, index uint32) uint32 {
	start := uint64(index) * BlockSize
	if start >= size {
		return 0
	}
	if size-start < BlockSize {
		return uint32(size - start)
	}
	return BlockSize
}

// FrameBlock is one entry of an upload frame.
type FrameBlock struct {
	Device string
	Index  uint32
	Zero   bool
	Length uint32
	SHA256 [32]byte
	Data   []byte // nil for a zero block
}

// EncodeFrame writes an upload frame:
//
//	"RSBF" | version u8 = 1 | count u16
//	per block: nameLen u8 | name | index u32 | flags u8 | length u32 | sha256 [32] | data (absent for zero blocks)
//
// Integers are big endian.
func EncodeFrame(w io.Writer, blocks []FrameBlock) error {
	if len(blocks) == 0 || len(blocks) > MaxBlocksPerFrame {
		return fmt.Errorf("a frame holds 1 to %d blocks, not %d", MaxBlocksPerFrame, len(blocks))
	}
	var hdr bytes.Buffer
	hdr.Write(frameMagic[:])
	hdr.WriteByte(1)
	_ = binary.Write(&hdr, binary.BigEndian, uint16(len(blocks)))
	if _, err := w.Write(hdr.Bytes()); err != nil {
		return err
	}
	for _, b := range blocks {
		if len(b.Device) == 0 || len(b.Device) > 64 {
			return fmt.Errorf("device name %q is not 1 to 64 bytes", b.Device)
		}
		var e bytes.Buffer
		e.WriteByte(byte(len(b.Device)))
		e.WriteString(b.Device)
		_ = binary.Write(&e, binary.BigEndian, b.Index)
		var flags byte
		if b.Zero {
			flags |= FlagZero
		} else if uint32(len(b.Data)) != b.Length {
			return fmt.Errorf("block %d of %s: %d bytes of data, length %d", b.Index, b.Device, len(b.Data), b.Length)
		}
		e.WriteByte(flags)
		_ = binary.Write(&e, binary.BigEndian, b.Length)
		e.Write(b.SHA256[:])
		if _, err := w.Write(e.Bytes()); err != nil {
			return err
		}
		if !b.Zero {
			if _, err := w.Write(b.Data); err != nil {
				return err
			}
		}
	}
	return nil
}

// DecodeFrame reads a frame written by EncodeFrame (tests; the server has
// its own decoder).
func DecodeFrame(r io.Reader) ([]FrameBlock, error) {
	var hdr [7]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	if !bytes.Equal(hdr[0:4], frameMagic[:]) || hdr[4] != 1 {
		return nil, errors.New("not a block frame")
	}
	n := int(binary.BigEndian.Uint16(hdr[5:7]))
	out := make([]FrameBlock, 0, n)
	for i := 0; i < n; i++ {
		var l [1]byte
		if _, err := io.ReadFull(r, l[:]); err != nil {
			return nil, err
		}
		name := make([]byte, l[0])
		if _, err := io.ReadFull(r, name); err != nil {
			return nil, err
		}
		var fixed [41]byte
		if _, err := io.ReadFull(r, fixed[:]); err != nil {
			return nil, err
		}
		b := FrameBlock{Device: string(name), Index: binary.BigEndian.Uint32(fixed[0:4])}
		b.Zero = fixed[4]&FlagZero != 0
		b.Length = binary.BigEndian.Uint32(fixed[5:9])
		copy(b.SHA256[:], fixed[9:41])
		if !b.Zero {
			b.Data = make([]byte, b.Length)
			if _, err := io.ReadFull(r, b.Data); err != nil {
				return nil, err
			}
		}
		out = append(out, b)
	}
	return out, nil
}

// HashList is the per-block view of a stored block map: which blocks are
// zero, which hold data and the SHA-256 of each data block. The helper keeps
// the newest one per disk to skip unchanged blocks (docs/PROXMOX.md 2.4).
type HashList struct {
	DiskSize uint64
	Flags    []byte
	Hashes   [][32]byte
}

// NewHashList is an empty list for a disk (every block absent).
func NewHashList(size uint64) *HashList {
	n := BlockCount(size)
	return &HashList{DiskSize: size, Flags: make([]byte, n), Hashes: make([][32]byte, n)}
}

// Encode writes the hash list:
//
//	"RSBH" | version u8 = 1 | blockSize u32 | diskSize u64 | blockCount u32 | per block: flags u8 | sha256 [32]
func (h *HashList) Encode() []byte {
	var b bytes.Buffer
	b.Grow(21 + len(h.Flags)*33)
	b.Write(hashesMagic[:])
	b.WriteByte(1)
	_ = binary.Write(&b, binary.BigEndian, uint32(BlockSize))
	_ = binary.Write(&b, binary.BigEndian, h.DiskSize)
	_ = binary.Write(&b, binary.BigEndian, uint32(len(h.Flags)))
	for i := range h.Flags {
		b.WriteByte(h.Flags[i])
		b.Write(h.Hashes[i][:])
	}
	return b.Bytes()
}

// Digest is the SHA-256 (hex) of the encoded list; the server names the
// same digest for the map it holds.
func (h *HashList) Digest() string {
	sum := sha256.Sum256(h.Encode())
	return fmt.Sprintf("%x", sum[:])
}

// DecodeHashList parses an encoded hash list.
func DecodeHashList(data []byte) (*HashList, error) {
	if len(data) < 21 || !bytes.Equal(data[0:4], hashesMagic[:]) || data[4] != 1 {
		return nil, errors.New("not a block hash list")
	}
	if binary.BigEndian.Uint32(data[5:9]) != BlockSize {
		return nil, errors.New("block hash list with another block size")
	}
	size := binary.BigEndian.Uint64(data[9:17])
	n := binary.BigEndian.Uint32(data[17:21])
	if n != BlockCount(size) || uint64(len(data)) != 21+uint64(n)*33 {
		return nil, errors.New("block hash list is truncated or inconsistent")
	}
	h := NewHashList(size)
	for i := uint32(0); i < n; i++ {
		at := 21 + int(i)*33
		h.Flags[i] = data[at]
		copy(h.Hashes[i][:], data[at+1:at+33])
	}
	return h, nil
}

// RestoreBlock is one block of a restore stream:
//
//	index u32 | flags u8 | length u32 | data (absent for zero blocks)
type RestoreBlock struct {
	Index  uint32
	Zero   bool
	Length uint32
	Data   []byte
}

// ReadRestoreBlock reads the next block of a restore stream; io.EOF at the end.
func ReadRestoreBlock(r io.Reader) (RestoreBlock, error) {
	var hdr [9]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return RestoreBlock{}, err
	}
	b := RestoreBlock{Index: binary.BigEndian.Uint32(hdr[0:4]), Zero: hdr[4]&FlagZero != 0, Length: binary.BigEndian.Uint32(hdr[5:9])}
	if b.Length > BlockSize {
		return RestoreBlock{}, errors.New("restore block larger than the block size")
	}
	if !b.Zero {
		b.Data = make([]byte, b.Length)
		if _, err := io.ReadFull(r, b.Data); err != nil {
			return RestoreBlock{}, fmt.Errorf("restore stream cut short: %w", err)
		}
	}
	return b, nil
}

// WriteRestoreBlock writes one block of a restore stream (tests, fake server).
func WriteRestoreBlock(w io.Writer, b RestoreBlock) error {
	var hdr [9]byte
	binary.BigEndian.PutUint32(hdr[0:4], b.Index)
	if b.Zero {
		hdr[4] = FlagZero
	}
	binary.BigEndian.PutUint32(hdr[5:9], b.Length)
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if !b.Zero {
		_, err := w.Write(b.Data)
		return err
	}
	return nil
}

var zeroBlock = make([]byte, BlockSize)

// IsZero reports whether p holds only zero bytes.
func IsZero(p []byte) bool {
	for len(p) > 0 {
		n := min(len(p), len(zeroBlock))
		if !bytes.Equal(p[:n], zeroBlock[:n]) {
			return false
		}
		p = p[n:]
	}
	return true
}
