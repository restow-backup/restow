package recovery

// syscallTables are the system call numbers the seccomp filter needs, for
// both architectures the ISO could run on (amd64 now, arm64 later, 24.6);
// they are compiled everywhere so the filter is tested everywhere.
var syscallTables = map[string]syscallTable{
	"amd64": {
		audit: 0xc000003e, x32: true, clone: 56, clone3: 435, ioctl: 16, socket: 41, socketpair: 53,
		denied: map[string]int{
			"mount": 165, "umount2": 166, "pivot_root": 155, "open_tree": 428, "move_mount": 429, "fsopen": 430,
			"fsconfig": 431, "fsmount": 432, "fspick": 433, "mount_setattr": 442, "open_tree_attr": 467, "mknod": 133, "mknodat": 259,
			"init_module": 175, "finit_module": 313, "delete_module": 176, "kexec_load": 246, "kexec_file_load": 320,
			"reboot": 169, "ptrace": 101, "process_vm_readv": 310, "process_vm_writev": 311, "bpf": 321,
			"perf_event_open": 298, "unshare": 272, "setns": 308, "chroot": 161, "open_by_handle_at": 304,
			"name_to_handle_at": 303, "swapon": 167, "swapoff": 168, "io_uring_setup": 425, "io_uring_enter": 426,
			"io_uring_register": 427, "iopl": 172, "ioperm": 173,
		},
	},
	"arm64": {
		audit: 0xc00000b7, clone: 220, clone3: 435, ioctl: 29, socket: 198, socketpair: 199,
		denied: map[string]int{
			"mount": 40, "umount2": 39, "pivot_root": 41, "open_tree": 428, "move_mount": 429, "fsopen": 430,
			"fsconfig": 431, "fsmount": 432, "fspick": 433, "mount_setattr": 442, "open_tree_attr": 467, "mknodat": 33,
			"init_module": 105, "finit_module": 273, "delete_module": 106, "kexec_load": 104, "kexec_file_load": 294,
			"reboot": 142, "ptrace": 117, "process_vm_readv": 270, "process_vm_writev": 271, "bpf": 280,
			"perf_event_open": 241, "unshare": 97, "setns": 268, "chroot": 51, "open_by_handle_at": 265,
			"name_to_handle_at": 264, "swapon": 224, "swapoff": 225, "io_uring_setup": 425, "io_uring_enter": 426,
			"io_uring_register": 427,
		},
	},
}
