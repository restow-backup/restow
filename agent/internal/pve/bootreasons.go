package pve

// The reasons a boot test result names (BootTestResult.Reason; docs/PVE-PROTOCOL.md, "Task
// boot_test"). The server rates a result by its reason: PVE_BOOT_TEST_REASON_OUTCOMES in
// packages/core/src/pve/boot-test.ts must list every reason of this block (its test reads
// this file), and the web app gives each one a text. bootreasons_test.go makes sure the boot
// test code names its reasons only through these constants.
const (
	// green: proof that the copy booted
	reasonAgentAnswered = "agent_answered"
	reasonSystemRunning = "system_running"

	// yellow: it started and kept running, nothing proved that it booted to its services
	reasonNoGuestAgent          = "no_guest_agent"
	reasonAgentNotAnswering     = "agent_not_answering"
	reasonGuestPaused           = "guest_paused"
	reasonSystemDegraded        = "system_degraded"
	reasonSystemStarting        = "system_starting"
	reasonSystemUnknown         = "system_unknown"
	reasonInitRunningUnverified = "init_running_unverified"
	reasonInitUnknown           = "init_unknown"

	// red: it did not boot
	reasonRestoreFailed      = "restore_failed"
	reasonStartFailed        = "start_failed"
	reasonGuestStopped       = "guest_stopped"
	reasonGuestPanicked      = "guest_panicked"
	reasonGuestInternalError = "guest_internal_error"
	reasonSystemMaintenance  = "system_maintenance"

	// skipped: the node did not boot the copy, for a reason outside the restore point
	reasonMemoryLimit       = "memory_limit"
	reasonNodeMemory        = "node_memory"
	reasonNodeResources     = "node_resources"
	reasonStorageSpace      = "storage_space"
	reasonStorageContent    = "storage_content"
	reasonStorageIOError    = "storage_io_error"
	reasonNoStorage         = "no_storage"
	reasonBackupRunning     = "backup_running"
	reasonBootTestRunning   = "boot_test_running"
	reasonRestoresOff       = "restores_off"
	reasonBootTestsOff      = "boot_tests_off"
	reasonCustomQemuArgs    = "custom_qemu_args"
	reasonHostDisk          = "host_disk"
	reasonBridgeNotIsolated = "bridge_not_isolated"
)
