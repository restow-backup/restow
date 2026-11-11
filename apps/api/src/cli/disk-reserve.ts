import {
  DiskReserve,
  type DiskReserveDeps,
  describeReserve,
  diskReserveConfig,
} from "../features/updates/disk-reserve.js";

/**
 * `restow disk-reserve ...` (#98, docs/DATABASE.md "Disk full"): the emergency disk reserve
 * without a database, so it works on a server whose database stopped on a full disk.
 *
 *   status [--json]  what the reserve is and how much the disk has free
 *   release          free it now (by hand); the alert follows once the database runs
 *   guard            free it if the disk is below the floor (the entrypoint, before the migrations)
 *   create           write it now if the disk has room (the installer)
 */

export type DiskReserveCommand =
  | { kind: "disk-reserve-status"; json: boolean }
  | { kind: "disk-reserve-release" }
  | { kind: "disk-reserve-guard" }
  | { kind: "disk-reserve-create" };

export const DISK_RESERVE_KINDS: ReadonlySet<string> = new Set([
  "disk-reserve-status",
  "disk-reserve-release",
  "disk-reserve-guard",
  "disk-reserve-create",
]);

export class DiskReserveUsageError extends Error {}

export function parseDiskReserveCommand(
  action: string | undefined,
  rest: readonly string[],
): DiskReserveCommand {
  if (action === "status") {
    const unknown = rest.filter((argument) => argument !== "--json");
    if (unknown.length > 0) {
      throw new DiskReserveUsageError(`Unknown option for disk-reserve status: ${unknown[0]}`);
    }
    return { kind: "disk-reserve-status", json: rest.includes("--json") };
  }
  if (action === "release" || action === "guard" || action === "create") {
    if (rest.length > 0) {
      throw new DiskReserveUsageError(
        `disk-reserve ${action} takes no arguments: ${rest.join(" ")}`,
      );
    }
    return { kind: `disk-reserve-${action}` };
  }
  throw new DiskReserveUsageError(
    action ? `Unknown disk-reserve command: ${action}` : "disk-reserve needs a command",
  );
}

export interface DiskReserveIo {
  out(text: string): void;
  err(text: string): void;
  env?: Record<string, string | undefined>;
  statfs?: DiskReserveDeps["statfs"];
}

/** Runs the command; the exit code. */
export async function runDiskReserveCommand(
  command: DiskReserveCommand,
  io: DiskReserveIo,
): Promise<number> {
  const reserve = new DiskReserve({
    config: diskReserveConfig(io.env ?? process.env),
    statfs: io.statfs,
  });
  switch (command.kind) {
    case "disk-reserve-status": {
      const status = await reserve.status();
      io.out(command.json ? `${JSON.stringify(status)}\n` : `${describeReserve(status)}\n`);
      return 0;
    }
    case "disk-reserve-release": {
      const released = await reserve.release("manual");
      io.out(
        released
          ? `The disk reserve at ${reserve.config.path} was freed. Free up space now; it is written again once there is room (docs/DATABASE.md, "Disk full").\n`
          : `There is no disk reserve at ${reserve.config.path} to free.\n`,
      );
      return 0;
    }
    case "disk-reserve-guard": {
      // Never stops the start: whatever goes wrong here, the api starts as before.
      try {
        const { action, status } = await reserve.check({ create: false, reason: "start" });
        if (action === "released") {
          io.err(
            `restow: the disk was almost full (${describeFree(status.freeBytes)} free); the disk reserve at ${status.path} was freed so the database can start. Free up space now (docs/DATABASE.md, "Disk full").\n`,
          );
        }
      } catch (error) {
        io.err(
          `restow: the disk reserve could not be checked: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      return 0;
    }
    case "disk-reserve-create": {
      const action = await reserve.create({ force: true });
      const status = await reserve.status();
      if (action === "failed") {
        io.err(`The disk reserve could not be written at ${status.path}.\n`);
        return 1;
      }
      if (action === "no_room") {
        io.err(
          `Not enough room for a disk reserve of ${describeFree(status.bytes)}: ${describeFree(status.freeBytes)} free. It is written once the disk has room.\n`,
        );
        return 2;
      }
      io.out(`${describeReserve(status)}\n`);
      return 0;
    }
  }
}

function describeFree(bytes: number | null): string {
  return bytes === null ? "unknown" : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
