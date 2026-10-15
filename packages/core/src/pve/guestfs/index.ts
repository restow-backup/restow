// The guest file system readers of VM restore points (docs/PVE.md, "Files of a VM"). The child
// process entry (sandbox-child.ts) is deliberately not exported: importing it would make the
// importing process answer IPC messages.
export type { VolumeInfo } from "./protocol.js";
export { GuestFsSandbox, type SandboxDisk, type SandboxOptions } from "./sandbox.js";
export { type FsEntry, GuestFsError } from "./source.js";
export { discoverVolumes, type GuestDisk, GuestFiles } from "./volumes.js";
