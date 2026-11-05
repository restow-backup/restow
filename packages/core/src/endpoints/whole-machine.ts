/**
 * Whole machine backups (preview, docs/BAREMETAL.md 5): a switch of an endpoint backup job that
 * has a Linux agent back up every local file system with the machine's disk layout instead of the
 * job's folders. The agent works out the sources itself (agent/internal/core/wholemachine.go); the
 * server decides who gets the switch, which exclusions a job starts from and whether file system
 * snapshots are on by default.
 *
 * In this release (M1) only Linux machines that are not containers get it; macOS follows with M6.
 * The job keeps its folders: an agent older than 0.5.0 does not know the switch and backs them up.
 */

/**
 * The exclusions a job editor puts in place of the profile's when the switch goes on (5.3): what
 * a restored system does not need. Unlike the profile's defaults, container data and the package
 * caches of a service stay in, so the services run after a restore.
 */
export const DEFAULT_WHOLE_MACHINE_EXCLUDES = [
  "/tmp/*",
  "/var/tmp/*",
  "/var/cache/apt/archives/*.deb",
  "/var/cache/dnf/*",
  "/var/cache/yum/*",
  "/var/cache/pacman/pkg/*",
  "/var/cache/zypp/packages/*",
  "/var/lib/systemd/coredump/*",
  "**/lost+found/*",
] as const;

/**
 * Container images of the btrfs storage driver: a machine with many of them may load them again
 * after a restore instead of backing up every image layer (5.2, the job's choice; off by default).
 */
export const CONTAINER_IMAGE_EXCLUDES = ["/var/lib/docker/btrfs", "/var/lib/docker/image"] as const;

/** The first agent release that backs up a whole machine. */
export const WHOLE_MACHINE_AGENT_VERSION = "0.5.0";

export const FS_SNAPSHOT_MODES = ["auto", "off"] as const;
export type FsSnapshotMode = (typeof FS_SNAPSHOT_MODES)[number];

/** Why a member of a whole machine job backs up differently, or what it should know. */
export const WHOLE_MACHINE_NOTES = [
  "container",
  "windows",
  "darwin_later",
  "agent_too_old",
  "arm64_restore_later",
  "bios_needs_csm",
] as const;
export type WholeMachineNote = (typeof WHOLE_MACHINE_NOTES)[number];

/** Whether a machine gets the switch in its configuration: Linux, not a container. */
export function wholeMachineApplies(
  os: string,
  virtualization: string | null | undefined,
): boolean {
  return os === "linux" && virtualization !== "container";
}

function versionTriple(version: string | null | undefined): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether an agent version is at least `minimum` (major.minor.patch; a pre-release counts as its release). */
export function agentVersionAtLeast(version: string | null | undefined, minimum: string): boolean {
  const have = versionTriple(version);
  const want = versionTriple(minimum);
  if (!have || !want) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    if ((have[i] as number) !== (want[i] as number)) {
      return (have[i] as number) > (want[i] as number);
    }
  }
  return true;
}

/**
 * The note a job page shows next to a member of a whole machine job, or null when the machine is
 * backed up as a whole without anything to add. `layoutCodes` are the codes of the machine's
 * newest layout (`unsupported[].code`), when there is one.
 */
export function wholeMachineNote(endpoint: {
  os: string;
  arch: string;
  agentVersion: string | null;
  virtualization?: string | null;
  layoutCodes?: readonly string[];
}): WholeMachineNote | null {
  if (endpoint.os === "windows") return "windows";
  if (endpoint.os === "darwin") return "darwin_later";
  if (endpoint.virtualization === "container") return "container";
  if (!agentVersionAtLeast(endpoint.agentVersion, WHOLE_MACHINE_AGENT_VERSION)) {
    return "agent_too_old";
  }
  if (endpoint.arch === "arm64") return "arm64_restore_later";
  if (endpoint.layoutCodes?.includes("bios_needs_csm")) return "bios_needs_csm";
  return null;
}

/**
 * Whether the agent takes file system snapshots: the machine's own setting, else on for a machine
 * backed up as a whole and off for every other (docs/BAREMETAL.md 24.4).
 */
export function resolveFsSnapshot(
  stored: FsSnapshotMode | null | undefined,
  wholeMachine: boolean,
): FsSnapshotMode {
  return stored ?? (wholeMachine ? "auto" : "off");
}
