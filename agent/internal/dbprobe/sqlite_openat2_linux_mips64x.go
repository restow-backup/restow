//go:build linux && (mips64 || mips64le)

package dbprobe

// sysOpenat2 is openat2 on 64-bit MIPS (n64 ABI, the one Go uses): 5000 + 437.
// The n32 ABI (6437) has no Go port.
const sysOpenat2 = 5437
