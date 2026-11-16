//go:build linux

package recovery

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"
)

// Interfaces lists the network interfaces with their link, speed, driver
// and addresses (/sys/class/net and the kernel's address list).
func Interfaces(sysRoot string) []NetIface {
	if sysRoot == "" {
		sysRoot = "/sys"
	}
	var out []NetIface
	entries, _ := os.ReadDir(filepath.Join(sysRoot, "class/net"))
	for _, e := range entries {
		if e.Name() == "lo" {
			continue
		}
		base := filepath.Join(sysRoot, "class/net", e.Name())
		i := NetIface{Name: e.Name(), MAC: readTrim(filepath.Join(base, "address")), Link: readTrim(filepath.Join(base, "carrier")) == "1"}
		if _, err := os.Stat(filepath.Join(base, "device")); err == nil {
			i.Physical = true
		}
		if d, err := os.Readlink(filepath.Join(base, "device/driver")); err == nil {
			i.Driver = filepath.Base(d)
		}
		i.Modalias = readTrim(filepath.Join(base, "device/modalias"))
		i.SpeedMbps, _ = strconv.ParseInt(readTrim(filepath.Join(base, "speed")), 10, 64)
		if ifc, err := net.InterfaceByName(e.Name()); err == nil {
			addrs, _ := ifc.Addrs()
			for _, a := range addrs {
				i.Addresses = append(i.Addresses, a.String())
			}
		}
		out = append(out, i)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Name < out[b].Name })
	return out
}

// ApplyStatic writes the static network file and reloads networkd.
func ApplyStatic(ctx context.Context, x Exec, n AnswersNetwork) error {
	text, err := StaticNetworkFile(n)
	if err != nil {
		return err
	}
	if err := os.MkdirAll("/run/systemd/network", 0o755); err != nil {
		return err
	}
	if err := os.WriteFile("/run/systemd/network/10-restow-static.network", []byte(text), 0o644); err != nil {
		return err
	}
	_, err = x.Run(ctx, RunSpec{Argv: []string{"networkctl", "reload"}, Timeout: time.Minute})
	return err
}

// WaitAddress waits up to timeout until a physical interface has an
// address (DHCP keeps running in the background), redrawing the list.
func WaitAddress(ctx context.Context, ui *UI, timeout time.Duration) []NetIface {
	deadline := time.Now().Add(timeout)
	for {
		ifs := Interfaces("")
		if HasAddress(ifs) || time.Now().After(deadline) {
			return ifs
		}
		if ui != nil {
			ui.Progress(ui.Text("net.waiting"))
		}
		select {
		case <-ctx.Done():
			return ifs
		case <-time.After(2 * time.Second):
		}
	}
}
