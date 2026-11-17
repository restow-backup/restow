//go:build linux && !mips && !mipsle && !mips64 && !mips64le

package dbprobe

// sysOpenat2 is the number of openat2 (Linux 5.6) on the architectures with
// the generic system call table: 437. MIPS adds an ABI offset
// (sqlite_openat2_linux_mips*.go).
const sysOpenat2 = 437
