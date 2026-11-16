//go:build linux

package recovery

import (
	"context"
	"fmt"
	"os"
	"syscall"
	"time"
)

// fdHold pins a disk with an open descriptor. While it is open the
// kernel keeps the disk object, and the usual drivers (sd, nvme, loop)
// give its name and device number out again only after that; when the
// disk itself goes away, the descriptor reports no size any more. The
// guard does not rely on this alone: it reads the identities again before
// every step.
type fdHold struct {
	f    *os.File
	path string
	rdev uint64
	size int64
}

// HoldDevice opens the block device at path read-only and keeps it open.
// It fails when path is no block device or does not have size bytes.
func HoldDevice(path string, size int64) (DeviceHold, error) {
	f, err := os.OpenFile(path, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	var st syscall.Stat_t
	if err := syscall.Fstat(int(f.Fd()), &st); err != nil {
		f.Close()
		return nil, err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFBLK {
		f.Close()
		return nil, fmt.Errorf("%s is no block device", path)
	}
	n, err := deviceSize(f)
	if err != nil || n != size {
		f.Close()
		return nil, fmt.Errorf("%s has %d bytes, the confirmed disk had %d (%v)", path, n, size, err)
	}
	return &fdHold{f: f, path: path, rdev: uint64(st.Rdev), size: size}, nil
}

// Check implements DeviceHold.
func (h *fdHold) Check() error {
	var st syscall.Stat_t
	if err := syscall.Stat(h.path, &st); err != nil {
		return fmt.Errorf("%s: %v", h.path, err)
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFBLK || uint64(st.Rdev) != h.rdev {
		return fmt.Errorf("%s no longer names the confirmed disk (device %d:%d, now %d:%d)", h.path,
			devMajor(h.rdev), devMinor(h.rdev), devMajor(uint64(st.Rdev)), devMinor(uint64(st.Rdev)))
	}
	n, err := deviceSize(h.f)
	if err != nil || n != h.size {
		return fmt.Errorf("the confirmed disk at %s is gone or has another size (%d bytes, confirmed %d)", h.path, n, h.size)
	}
	return nil
}

// Close implements DeviceHold.
func (h *fdHold) Close() error { return h.f.Close() }

func devMajor(d uint64) uint64 { return (d>>8)&0xfff | (d>>32)&^0xfff }
func devMinor(d uint64) uint64 { return d&0xff | (d>>12)&^0xff }

// Guard implements FlowEnv: the scan before every step reads identities
// and sizes only (sysfs and lsblk), the hold is an open descriptor, the
// write probe is ProbeIO.
func (e *LinuxEnv) Guard(g *DiskGuard) {
	// The scan before every step is not logged (lsblk a hundred times in
	// the log of the session); what it finds is: a change stops the run.
	quiet := e.Exec
	if c, ok := quiet.(CmdExec); ok {
		c.Log = nil
		quiet = c
	}
	g.Scan = func(ctx context.Context) (HardwareInput, error) {
		return (&HardwareCollector{Exec: quiet, IdentityOnly: true}).Collect(ctx)
	}
	g.Hold = HoldDevice
	g.ProbeWrite = func(path string, size int64) error { return ProbeIO(path, size, true) }
	g.Settle = 2 * time.Second
}
