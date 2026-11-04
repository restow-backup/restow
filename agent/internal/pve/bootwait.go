//go:build !windows

package pve

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// waitForBoot waits for proof that the started temporary guest booted (see the top of
// boottest.go). agentForced: the guest's own configuration had the QEMU guest agent off.
func (b *BootTester) waitForBoot(ctx context.Context, kind string, vmid int, started time.Time, timeout time.Duration, agentForced bool) bootOutcome {
	if kind == "ct" {
		return b.waitForContainer(ctx, vmid, started, timeout)
	}
	return b.waitForVM(ctx, vmid, started, timeout, agentForced)
}

func (b *BootTester) waitForVM(ctx context.Context, vmid int, started time.Time, timeout time.Duration, agentForced bool) bootOutcome {
	id := strconv.Itoa(vmid)
	paused := false
	for {
		if _, err := b.command(ctx, "qm", "guest", "cmd", id, "ping"); err == nil {
			b.logf("the QEMU guest agent answered")
			return bootOutcome{"green", "agent_answered", "The restored VM booted: its QEMU guest agent answered.", true}
		}
		out, err := b.command(ctx, "qm", "status", id, "--verbose")
		if err == nil {
			st := statusFields(out)
			if st["status"] != "running" {
				b.logf("the guest stopped: %s", st["status"])
				return bootOutcome{"red", "guest_stopped", "The temporary guest stopped while it booted (status: " + st["status"] + ").", false}
			}
			switch qmp := st["qmpstatus"]; qmp {
			case "guest-panicked":
				b.logf("the guest panicked")
				return bootOutcome{"red", "guest_panicked", "The operating system of the temporary VM panicked while it booted (QEMU status guest-panicked).", false}
			case "internal-error":
				b.logf("QEMU reports an internal error")
				return bootOutcome{"red", "guest_internal_error", "The temporary VM stopped with an internal error of its virtual CPU while it booted (QEMU status internal-error).", false}
			case "io-error":
				// Its disks are on the boot test storage: a full thin pool, not the restore point.
				b.logf("the guest is paused by an I/O error")
				return bootOutcome{"skipped", "storage_io_error", "The temporary VM was paused by an I/O error of its disks (QEMU status io-error); the boot test storage may be full.", false}
			default:
				paused = qmp == "paused" || qmp == "suspended"
			}
		}
		if b.now().Sub(started) >= timeout {
			switch {
			case err != nil:
				// "Kept running" needs a status that says so.
				b.logf("the state of the guest is unknown: %v", err)
				return bootOutcome{"", "", "the state of the temporary guest is unknown: " + err.Error(), false}
			case paused:
				b.logf("the guest is paused")
				return bootOutcome{"yellow", "guest_paused", fmt.Sprintf("The restored VM started, but it was paused after %s and its QEMU guest agent did not answer.", timeout), false}
			case agentForced:
				b.logf("no answer of the guest agent within %s", timeout)
				return bootOutcome{"yellow", "no_guest_agent", fmt.Sprintf("The restored VM started and kept running for %s, but its QEMU guest agent did not answer (not installed?).", timeout), false}
			}
			b.logf("no answer of the guest agent, which the VM has enabled, within %s", timeout)
			return bootOutcome{"yellow", "agent_not_answering", fmt.Sprintf("The restored VM started and kept running, but the QEMU guest agent that runs in this guest (its configuration has it enabled) did not answer within %s: the guest probably did not finish booting.", timeout), false}
		}
		if o, done := b.pause(ctx); done {
			return o
		}
	}
}

func (b *BootTester) pause(ctx context.Context) (bootOutcome, bool) {
	select {
	case <-ctx.Done():
		return bootOutcome{"", "", "cancelled: " + ctx.Err().Error(), false}, true
	case <-time.After(b.poll()):
		return bootOutcome{}, false
	}
}

// statusFields reads the top-level "key: value" lines of `qm status --verbose` (or of `pct
// status`).
func statusFields(out string) map[string]string {
	fields := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(out))
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if line == "" || line[0] == ' ' || line[0] == '\t' {
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if ok {
			fields[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	return fields
}

// networkUnitRE are the units that fail in a container without network, as the isolation
// leaves it: they say nothing about the restore point.
var networkUnitRE = regexp.MustCompile(`^(networking|network|ifupdown-wait-online|systemd-networkd-wait-online(@.+)?|NetworkManager-wait-online|ifup@.+)\.service$`)

func (b *BootTester) waitForContainer(ctx context.Context, vmid int, started time.Time, timeout time.Duration) bootOutcome {
	id := strconv.Itoa(vmid)
	var init, state string
	for {
		if init == "" {
			if init = b.containerInit(ctx, id); init != "" {
				b.logf("init runs: %s", init)
			}
		}
		if init == "systemd" {
			out, _ := b.command(ctx, "pct", "exec", id, "--", "systemctl", "is-system-running")
			if st := firstWord(out); st != "" {
				if st != state {
					b.logf("systemd: %s", st)
				}
				state = st
			}
			switch state {
			case "running":
				return bootOutcome{"green", "system_running", "The restored container booted: systemd reports the system running.", false}
			case "degraded":
				units, err := b.failedUnits(ctx, id)
				if err != nil {
					break
				}
				var other []string
				for _, u := range units {
					if !networkUnitRE.MatchString(u) {
						other = append(other, u)
					}
				}
				if len(other) == 0 {
					msg := "The restored container booted: systemd reports the system running."
					if len(units) > 0 {
						msg = fmt.Sprintf("The restored container booted: systemd reports the system running; only units that need the network failed (%s), as expected in the isolated test.", strings.Join(units, ", "))
					}
					return bootOutcome{"green", "system_running", msg, false}
				}
				return bootOutcome{"yellow", "system_degraded", fmt.Sprintf("The restored container booted, but these units failed: %s.", strings.Join(other, ", ")), false}
			case "maintenance":
				return bootOutcome{"red", "system_maintenance", "The restored container did not reach multi-user: systemd is in emergency or rescue mode (maintenance).", false}
			}
		}
		st, err := b.command(ctx, "pct", "status", id)
		if err == nil && statusFields(st)["status"] != "running" {
			b.logf("the guest stopped: %s", st)
			return bootOutcome{"red", "guest_stopped", "The temporary guest stopped while it booted (" + strings.TrimSpace(st) + ").", false}
		}
		if b.now().Sub(started) >= timeout {
			switch {
			case err != nil:
				b.logf("the state of the guest is unknown: %v", err)
				return bootOutcome{"", "", "the state of the temporary guest is unknown: " + err.Error(), false}
			case init == "systemd" && state == "degraded":
				return bootOutcome{"yellow", "system_degraded", fmt.Sprintf("The restored container kept running for %s, but systemd reports it degraded and its failed units could not be listed.", timeout), false}
			case init == "systemd" && state != "":
				return bootOutcome{"yellow", "system_starting", fmt.Sprintf("The restored container kept running for %s, but systemd did not finish booting (%s).", timeout, state), false}
			case init == "systemd":
				return bootOutcome{"yellow", "system_unknown", fmt.Sprintf("The restored container kept running for %s with systemd, but its state could not be asked (systemctl is-system-running).", timeout), false}
			case init != "":
				return bootOutcome{"yellow", "init_running_unverified", fmt.Sprintf("The restored container kept running for %s with its init (%s); Restow verifies the boot of systemd containers only.", timeout, init), false}
			}
			return bootOutcome{"yellow", "init_unknown", fmt.Sprintf("The restored container kept running for %s, but its init could not be looked at.", timeout), false}
		}
		if o, done := b.pause(ctx); done {
			return o
		}
	}
}

// containerInit is the name of a running container's PID 1, read from the host (lxc-info and
// /proc), which needs nothing inside the container (OCI and minimal images have no cat); `pct
// exec -- cat /proc/1/comm` is the fallback. "" while it is not known.
func (b *BootTester) containerInit(ctx context.Context, id string) string {
	if out, err := b.command(ctx, "lxc-info", "-n", id, "-p", "-H"); err == nil {
		if pid, err := strconv.Atoi(strings.TrimSpace(out)); err == nil && pid > 1 {
			root := b.ProcRoot
			if root == "" {
				root = procRoot
			}
			if exe, err := os.Readlink(filepath.Join(root, strconv.Itoa(pid), "exe")); err == nil && filepath.Base(exe) == "systemd" {
				return "systemd"
			}
			if comm, err := os.ReadFile(filepath.Join(root, strconv.Itoa(pid), "comm")); err == nil && strings.TrimSpace(string(comm)) != "" {
				return strings.TrimSpace(string(comm))
			}
		}
	}
	if out, err := b.command(ctx, "pct", "exec", id, "--", "cat", "/proc/1/comm"); err == nil {
		return strings.TrimSpace(out)
	}
	return ""
}

// failedUnits lists the failed units of a running systemd container.
func (b *BootTester) failedUnits(ctx context.Context, id string) ([]string, error) {
	out, err := b.command(ctx, "pct", "exec", id, "--", "systemctl", "list-units", "--state=failed", "--plain", "--no-legend", "--no-pager")
	if err != nil {
		return nil, err
	}
	var units []string
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(strings.TrimPrefix(strings.TrimSpace(line), "●"))
		if len(fields) > 0 {
			units = append(units, fields[0])
		}
	}
	return units, nil
}

func firstWord(s string) string {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

// zfsARCStats is the ZFS ARC's statistics on a node with ZFS.
const zfsARCStats = "/proc/spl/kstat/zfs/arcstats"

// zfsARCReclaimable is what the ZFS ARC holds above its minimum (size - c_min), which it gives
// back under memory pressure; 0 without ZFS.
func zfsARCReclaimable(path string) uint64 {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	var size, min uint64
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) != 3 {
			continue
		}
		n, err := strconv.ParseUint(f[2], 10, 64)
		if err != nil {
			continue
		}
		switch f[0] {
		case "size":
			size = n
		case "c_min":
			min = n
		}
	}
	if size > min {
		return size - min
	}
	return 0
}
