package power

import "os"

func detect() Status {
	return linuxSupplies(os.DirFS("/sys/class/power_supply"))
}
