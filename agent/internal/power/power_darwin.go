package power

import (
	"context"
	"os/exec"
	"time"
)

func detect() Status {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/pmset", "-g", "batt").Output()
	if err != nil {
		return Status{OnAC: true, Known: false, Detail: "pmset failed: " + err.Error()}
	}
	return parsePmset(string(out))
}
