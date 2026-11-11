package recovery

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// The guard of the confirmed disks (docs/BAREMETAL.md 10.6, 10.10). The
// plan and every step name a disk by its kernel path (/dev/sdb), which
// the kernel gives out anew when a disk is pulled, plugged or enumerated
// again; the operator confirmed disks, not names. Between the scan and
// the first step lie the dialogs, the countdown and, with a foreign
// device-mapper device open, a shell. So recover reads the hardware again
// after the last dialog and stops when anything differs from what was
// shown and confirmed (Arm), holds every mapped disk open from then on,
// and before every step reads identity and size of the mapped disks once
// more (Check). Only after Arm does recover write to a disk for the first
// time: the write probe of the disks to erase.

// ErrDisksChanged: the disks are not the ones the operator confirmed.
var ErrDisksChanged = errors.New("the disks of this machine changed after they were shown and confirmed")

// DeviceHold keeps a device node pinned (Linux: an open descriptor, so
// the kernel does not give its name and number to another disk).
type DeviceHold interface {
	// Check reports whether the path still names the held device and the
	// device still has its size.
	Check() error
	Close() error
}

// GuardedDisk is a mapped target disk as it was confirmed.
type GuardedDisk struct {
	Path      string
	Identity  string
	SizeBytes int64
	// Erased: the plan erases it (false: adopted, or a resumed run).
	Erased bool
}

// DiskGuard checks that the mapped disks stay the confirmed ones. Scan,
// Hold and ProbeWrite are the machine (FlowEnv.Guard); Hold and
// ProbeWrite may be nil.
type DiskGuard struct {
	// Scan reads identity and size of the block devices again. It never
	// writes to a device.
	Scan func(ctx context.Context) (HardwareInput, error)
	// Hold pins the device node of a disk.
	Hold func(path string, size int64) (DeviceHold, error)
	// ProbeWrite reads the first and last MiB of a disk and writes the
	// same bytes back (10.6).
	ProbeWrite func(path string, size int64) error
	// AnswersMedium is the disk of the answers medium, as in the scan.
	AnswersMedium string
	// Settle is how long a difference that Check finds in a scan must last:
	// the scan is read once more after it, and only a difference that is
	// still there stops the run (udev rewrites what lsblk reads after every
	// change of a partition table). Zero: the first scan decides.
	Settle time.Duration

	disks []GuardedDisk
	holds []DeviceHold
}

// diskState is what the guard compares of one device.
type diskState struct {
	identity string
	size     int64
	sector   int64
	target   bool
	sigs     string
}

func targetState(t *baremetal.Target, withSignatures bool) map[string]diskState {
	out := map[string]diskState{}
	add := func(list []baremetal.TargetDisk, target bool) {
		for _, d := range list {
			st := diskState{identity: deref(d.Identity), size: d.SizeBytes, sector: d.LogicalSectorSize, target: target}
			if withSignatures {
				var s []string
				for _, sg := range d.Signatures {
					s = append(s, sg.Kind+"="+normIdent(sg.UUID))
				}
				sort.Strings(s)
				st.sigs = strings.Join(s, " ")
			}
			out[d.Path] = st
		}
	}
	add(t.Disks, true)
	add(t.Others, false)
	return out
}

func nameIdentity(id string) string {
	if id == "" {
		return "no identity"
	}
	return id
}

// targetChanges lists what differs between the confirmed target and the
// target of a new scan: a device that came or went, another identity,
// size or sector size behind a path, other content on a disk.
func targetChanges(confirmed, now *baremetal.Target) []string {
	a, b := targetState(confirmed, true), targetState(now, true)
	var out []string
	for p, was := range a {
		is, ok := b[p]
		switch {
		case !ok:
			out = append(out, fmt.Sprintf("%s (%s) is gone", p, nameIdentity(was.identity)))
		case was.identity != is.identity:
			out = append(out, fmt.Sprintf("%s was %s and is %s", p, nameIdentity(was.identity), nameIdentity(is.identity)))
		case was.size != is.size || was.sector != is.sector:
			out = append(out, fmt.Sprintf("%s had %d bytes in %d-byte sectors and has %d bytes in %d-byte sectors", p, was.size, was.sector, is.size, is.sector))
		case was.target != is.target:
			out = append(out, fmt.Sprintf("%s changed between a possible target and a device that is none", p))
		case was.sigs != is.sigs:
			out = append(out, fmt.Sprintf("the content of %s changed (its signatures were [%s] and are [%s])", p, was.sigs, is.sigs))
		}
	}
	for p, is := range b {
		if _, ok := a[p]; !ok {
			out = append(out, fmt.Sprintf("%s (%s) is new", p, nameIdentity(is.identity)))
		}
	}
	sort.Strings(out)
	return out
}

func changed(what []string) error {
	return &problemError{code: ProblemStepFailed, err: fmt.Errorf("%w: %s", ErrDisksChanged, strings.Join(what, "; "))}
}

// Arm runs after the last dialog and before the first step. rescan reads
// the hardware as the first scan did; its target must equal the confirmed
// one in every device (path, identity, size, sector size, signatures).
// Then the mapped disks of the plan are held, and with probe the disks to
// erase are read and written back at both ends. Nothing was changed when
// Arm fails.
func (g *DiskGuard) Arm(ctx context.Context, rescan func(context.Context) (HardwareInput, error), confirmed *baremetal.Target, plan *baremetal.RestorePlan, probe bool) error {
	hw, err := rescan(ctx)
	if err != nil {
		return fmt.Errorf("read the disks again before the first step: %w", err)
	}
	hw.AnswersMedium = g.AnswersMedium
	now, _ := BuildTarget(hw)
	if diff := targetChanges(confirmed, now); len(diff) > 0 {
		return changed(diff)
	}
	byID := map[string]baremetal.TargetDisk{}
	for _, d := range confirmed.Disks {
		byID[d.ID] = d
	}
	g.disks = nil
	for _, a := range plan.Mapping {
		if a.Target == nil || a.Action == baremetal.ActionMissing {
			continue
		}
		d, ok := byID[*a.Target]
		if !ok {
			return fmt.Errorf("the plan maps %s to %s, which is no disk of this machine", a.Source, *a.Target)
		}
		// A resumed plan maps with the action erase and erases nothing.
		erased := a.Action == baremetal.ActionErase && deref(a.Reason) != "resume"
		g.disks = append(g.disks, GuardedDisk{Path: d.Path, Identity: deref(d.Identity), SizeBytes: d.SizeBytes, Erased: erased})
	}
	if g.Hold != nil {
		for _, d := range g.disks {
			h, err := g.Hold(d.Path, d.SizeBytes)
			if err != nil {
				g.Close()
				return changed([]string{fmt.Sprintf("%s (%s): %v", d.Path, nameIdentity(d.Identity), err)})
			}
			g.holds = append(g.holds, h)
		}
	}
	if probe && g.ProbeWrite != nil {
		for _, d := range g.disks {
			if !d.Erased {
				continue
			}
			if err := g.ProbeWrite(d.Path, d.SizeBytes); err != nil {
				g.Close()
				return &problemError{code: baremetal.ProblemSEDLocked, err: fmt.Errorf("%s: %w", d.Path, err), params: map[string]any{"target": d.Path}}
			}
		}
	}
	return nil
}

// Disks are the disks the guard watches.
func (g *DiskGuard) Disks() []GuardedDisk { return append([]GuardedDisk(nil), g.disks...) }

// Check runs before every step: every mapped disk is still held, and its
// path still gives the confirmed identity and size. Other devices may
// come and go during the hours of a restore; a mapped one may not.
func (g *DiskGuard) Check(ctx context.Context) error {
	if g == nil {
		return nil
	}
	var diff []string
	for _, h := range g.holds {
		if err := h.Check(); err != nil {
			diff = append(diff, err.Error())
		}
	}
	if len(diff) == 0 && g.Scan != nil && len(g.disks) > 0 {
		var err error
		if diff, err = g.scanDiff(ctx); err != nil {
			return err
		}
		if len(diff) > 0 && g.Settle > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(g.Settle):
			}
			if diff, err = g.scanDiff(ctx); err != nil {
				return err
			}
		}
	}
	if len(diff) > 0 {
		return changed(diff)
	}
	return nil
}

// scanDiff reads the devices and lists what differs for the mapped disks.
func (g *DiskGuard) scanDiff(ctx context.Context) ([]string, error) {
	hw, err := g.Scan(ctx)
	if err != nil {
		return nil, fmt.Errorf("read the disks again: %w", err)
	}
	hw.AnswersMedium = g.AnswersMedium
	now, _ := BuildTarget(hw)
	is := targetState(now, false)
	var diff []string
	for _, d := range g.disks {
		st, ok := is[d.Path]
		switch {
		case !ok || !st.target:
			diff = append(diff, fmt.Sprintf("%s (%s) is gone", d.Path, nameIdentity(d.Identity)))
		case st.identity != d.Identity:
			diff = append(diff, fmt.Sprintf("%s was %s and is %s", d.Path, nameIdentity(d.Identity), nameIdentity(st.identity)))
		case st.size != d.SizeBytes:
			diff = append(diff, fmt.Sprintf("%s had %d bytes and has %d", d.Path, d.SizeBytes, st.size))
		}
	}
	return diff, nil
}

// Close lets the held devices go.
func (g *DiskGuard) Close() {
	if g == nil {
		return
	}
	for _, h := range g.holds {
		_ = h.Close()
	}
	g.holds = nil
}
