//go:build !unix

package cmdrun

import "os/exec"

func setpgid(*exec.Cmd) {}
