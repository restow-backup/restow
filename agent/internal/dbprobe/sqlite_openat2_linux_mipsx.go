//go:build linux && (mips || mipsle)

package dbprobe

// sysOpenat2 is openat2 on 32-bit MIPS (o32 ABI): 4000 + 437.
const sysOpenat2 = 4437
