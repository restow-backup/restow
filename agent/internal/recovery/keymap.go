package recovery

import (
	"regexp"
	"strings"

	"github.com/restow-backup/restow/agent/internal/baremetal"
)

// Debian's kbd ships no console keymaps; recover loads XKB layouts with
// ckbcomp <layout> [<variant>] | loadkeys - (R16). consoleKeymaps maps the
// console names of vconsole.conf and /etc/default/keyboard to XKB.
var consoleKeymaps = map[string][2]string{
	"us": {"us", ""}, "us-acentos": {"us", "intl"}, "dvorak": {"us", "dvorak"},
	"de": {"de", ""}, "de-latin1": {"de", ""}, "de-latin1-nodeadkeys": {"de", "nodeadkeys"}, "de-nodeadkeys": {"de", "nodeadkeys"},
	"at": {"at", ""}, "at-latin1": {"at", ""}, "at-nodeadkeys": {"at", "nodeadkeys"},
	"sg": {"ch", ""}, "sg-latin1": {"ch", ""}, "de_CH-latin1": {"ch", ""}, "ch": {"ch", ""}, "fr_CH": {"ch", "fr"}, "fr_CH-latin1": {"ch", "fr"},
	"fr": {"fr", ""}, "fr-latin1": {"fr", ""}, "fr-latin9": {"fr", "latin9"}, "fr-pc": {"fr", ""},
	"uk": {"gb", ""}, "gb": {"gb", ""}, "es": {"es", ""}, "it": {"it", ""}, "nl": {"nl", ""}, "be-latin1": {"be", ""},
	"dk": {"dk", ""}, "dk-latin1": {"dk", ""}, "no": {"no", ""}, "no-latin1": {"no", ""}, "se-latin1": {"se", ""}, "sv-latin1": {"se", ""},
	"fi": {"fi", ""}, "pl": {"pl", ""}, "pl2": {"pl", ""}, "cz-qwertz": {"cz", ""}, "cz": {"cz", ""}, "hu": {"hu", ""},
	"pt-latin1": {"pt", ""}, "br-abnt2": {"br", ""}, "jp106": {"jp", ""},
}

var reXKBName = regexp.MustCompile(`^[a-z]{2,3}$`)
var reXKBVariant = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)

// XKBForConsole maps a console keymap name to an XKB layout and variant;
// ok is false for an unknown name (recover then warns and keeps us).
func XKBForConsole(name string) (layout, variant string, ok bool) {
	if v, found := consoleKeymaps[name]; found {
		return v[0], v[1], true
	}
	if reXKBName.MatchString(name) {
		return name, "", true
	}
	return "", "", false
}

// KeymapForInitramfs is the layout the passphrase is typed with at the
// start (10.10): the one of the initramfs, us with GRUB cryptodisk or
// when the initramfs takes none. grubCryptodisk reports the GRUB case.
func KeymapForInitramfs(m *baremetal.Manifest) (layout, variant string, grubCryptodisk bool) {
	if m == nil || m.Linux == nil {
		return "us", "", false
	}
	k := m.Linux.Initramfs.Keymap
	if k.GrubCryptodisk {
		return "us", "", true
	}
	if !k.InInitramfs || k.Layout == nil || *k.Layout == "" {
		return "us", "", false
	}
	l, v, ok := XKBForConsole(strings.TrimSpace(*k.Layout))
	if !ok {
		return "us", "", false
	}
	if k.Variant != nil && *k.Variant != "" && reXKBVariant.MatchString(*k.Variant) {
		v = *k.Variant
	}
	return l, v, false
}

// CkbcompArgs is the argument vector of ckbcomp for a layout.
func CkbcompArgs(layout, variant string) []string {
	args := []string{"ckbcomp", layout}
	if variant != "" {
		args = append(args, variant)
	}
	return args
}
