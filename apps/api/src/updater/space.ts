import * as fs from "node:fs/promises";
import type { DatabaseOps } from "./database-ops.js";
import type { UpdateSpace } from "./database-protocol.js";
import type { DumpStore } from "./dumps.js";
import { type EnvFile, envValueOf } from "./env-file.js";
import type { Clock, DockerOps } from "./ops.js";

/**
 * How much disk space the next update needs (docs/UPDATING.md, "Disk space"). An update
 * writes a full `pg_dump` into the updater's state volume, pulls the two new images
 * and lets the new api run its migrations; a disk that cannot hold all of that fills
 * up in the middle of the update, and a full disk stops PostgreSQL. So the preflight
 * refuses an update that would not fit:
 *
 *   dump        the newest dump plus a quarter (the database grows between updates);
 *               without one, the size of the tables without their indexes (a custom-
 *               format dump holds the rows, compressed, and no index): an upper bound
 *   images      the images that run now (`docker image inspect`), as the size of the
 *               new ones; 2 GiB when that cannot be read
 *   migrations  a tenth of the database, at least 1 GiB (a migration that rewrites a
 *               table needs room for its new copy)
 *   margin      RESTOW_UPDATER_MIN_FREE_MB (default 1024 MB), on top
 *
 * The dump and the images go to the file system of the updater's state (Docker's data
 * directory, where both the volume and the image store live by default). The
 * migrations need their room on the database's file system: when it is the same one
 * (or that cannot be told), everything is added up there.
 */

const GIB = 1024 ** 3;
/** The dump estimate on top of the last dump. */
export const DUMP_GROWTH = 1.25;
export const MIGRATION_SHARE = 0.1;
export const MIGRATION_MIN_BYTES = GIB;
export const IMAGE_FALLBACK_BYTES = 2 * GIB;
/** How long measured database and image sizes are reused between checks. */
const INPUT_TTL_MS = 10 * 60_000;

export interface SpaceInputs {
  /** Size of the newest dump; null when there is none. */
  lastDumpBytes: number | null;
  /** Size of the tables without indexes; null when unknown. */
  tableBytes: number | null;
  /** pg_database_size; null when unknown. */
  databaseBytes: number | null;
  /** The running images together; null when unknown. */
  imageBytes: number | null;
  minFreeBytes: number;
  stateFreeBytes: number | null;
  databaseFreeBytes: number | null;
  /** null: unknown, counted as the same file system. */
  sameFilesystem: boolean | null;
}

/** The estimate (pure). */
export function estimateUpdateSpace(input: SpaceInputs): UpdateSpace {
  const dumpBasis: UpdateSpace["dumpBasis"] =
    input.lastDumpBytes !== null ? "last_dump" : input.tableBytes !== null ? "tables" : "none";
  const dumpBytes =
    input.lastDumpBytes !== null
      ? Math.ceil(input.lastDumpBytes * DUMP_GROWTH)
      : (input.tableBytes ?? 0);
  const imageBytes = input.imageBytes ?? IMAGE_FALLBACK_BYTES;
  const migrationBytes = Math.max(
    MIGRATION_MIN_BYTES,
    Math.ceil((input.databaseBytes ?? 0) * MIGRATION_SHARE),
  );
  const marginBytes = input.minFreeBytes;
  const separate = input.sameFilesystem === false;
  const stateRequiredBytes = dumpBytes + imageBytes + marginBytes + (separate ? 0 : migrationBytes);
  const databaseRequiredBytes = separate ? migrationBytes : 0;
  const stateOk = input.stateFreeBytes !== null && input.stateFreeBytes >= stateRequiredBytes;
  const databaseOk =
    !separate ||
    input.databaseFreeBytes === null ||
    input.databaseFreeBytes >= databaseRequiredBytes;
  return {
    dumpBytes,
    dumpBasis,
    imageBytes,
    migrationBytes,
    marginBytes,
    stateFreeBytes: input.stateFreeBytes,
    stateRequiredBytes,
    databaseFreeBytes: input.databaseFreeBytes,
    databaseRequiredBytes,
    sameFilesystem: input.sameFilesystem,
    enough: stateOk && databaseOk,
  };
}

/** The estimate as one line for a blocker (English, non-sensitive). */
export function describeShortfall(space: UpdateSpace): string {
  const mb = (bytes: number) => `${Math.ceil(bytes / (1024 * 1024))} MB`;
  const parts = [
    `dump ${mb(space.dumpBytes)}${space.dumpBasis === "last_dump" ? " (last dump + 25 %)" : space.dumpBasis === "tables" ? " (table size, no dump yet)" : ""}`,
    `images ${mb(space.imageBytes)}`,
    `migrations ${mb(space.migrationBytes)}`,
    `margin ${mb(space.marginBytes)}`,
  ];
  const lines: string[] = [];
  if (space.stateFreeBytes === null || space.stateFreeBytes < space.stateRequiredBytes) {
    lines.push(
      `${space.stateFreeBytes === null ? "unknown" : mb(space.stateFreeBytes)} free where the dump and the images go, ${mb(space.stateRequiredBytes)} needed`,
    );
  }
  if (
    space.databaseRequiredBytes > 0 &&
    space.databaseFreeBytes !== null &&
    space.databaseFreeBytes < space.databaseRequiredBytes
  ) {
    lines.push(
      `${mb(space.databaseFreeBytes)} free on the database's disk, ${mb(space.databaseRequiredBytes)} needed for migrations`,
    );
  }
  return `${lines.join("; ")} (${parts.join(", ")}).`;
}

export interface SpaceProbeOptions {
  ops: Pick<DockerOps, "freeBytes">;
  database: Pick<DatabaseOps, "databaseSizes" | "dataFilesystem" | "imageBytes">;
  dumps: Pick<DumpStore, "list">;
  envFile: Pick<EnvFile, "read">;
  clock: Clock;
  stateDir: string;
  minFreeMb: number;
  /** Device number of the state directory (tests replace it). */
  stateDevice?: () => Promise<number | null>;
}

interface SlowInputs {
  at: number;
  tableBytes: number | null;
  databaseBytes: number | null;
  imageBytes: number | null;
}

/** Gathers the inputs of {@link estimateUpdateSpace}; the slow ones are cached. */
export class UpdateSpaceProbe {
  private slow: SlowInputs | null = null;

  constructor(private readonly options: SpaceProbeOptions) {}

  async estimate(refresh = false): Promise<UpdateSpace> {
    const { ops, database, dumps, clock, stateDir, minFreeMb } = this.options;
    const now = clock.now().getTime();
    if (refresh || !this.slow || now - this.slow.at > INPUT_TTL_MS) {
      this.slow = { at: now, ...(await this.readSlow()) };
    }
    const stateFreeBytes = await ops.freeBytes(stateDir).catch(() => null);
    const filesystem = await database.dataFilesystem().catch(() => null);
    const stateDevice = await (this.options.stateDevice ?? (() => deviceOf(stateDir)))().catch(
      () => null,
    );
    const lastDump = (await dumps.list().catch(() => []))[0] ?? null;
    return estimateUpdateSpace({
      lastDumpBytes: lastDump ? lastDump.bytes : null,
      tableBytes: this.slow.tableBytes,
      databaseBytes: this.slow.databaseBytes,
      imageBytes: this.slow.imageBytes,
      minFreeBytes: minFreeMb * 1024 * 1024,
      stateFreeBytes,
      databaseFreeBytes: filesystem?.freeBytes ?? null,
      sameFilesystem:
        filesystem?.device === null || filesystem?.device === undefined || stateDevice === null
          ? null
          : filesystem.device === stateDevice,
    });
  }

  private async readSlow(): Promise<Omit<SlowInputs, "at">> {
    const { database, envFile } = this.options;
    const sizes = await database.databaseSizes().catch(() => null);
    let imageBytes: number | null = null;
    try {
      const text = await envFile.read();
      const images = [envValueOf(text, "RESTOW_IMAGE"), envValueOf(text, "RESTOW_WEB_IMAGE")];
      let total = 0;
      let known = 0;
      for (const image of images) {
        if (!image) {
          continue;
        }
        const bytes = await database.imageBytes(image).catch(() => null);
        if (bytes !== null) {
          total += bytes;
          known += 1;
        }
      }
      imageBytes = known > 0 ? total : null;
    } catch {
      imageBytes = null;
    }
    return {
      tableBytes: sizes?.tableBytes ?? null,
      databaseBytes: sizes?.databaseBytes ?? null,
      imageBytes,
    };
  }
}

async function deviceOf(dir: string): Promise<number | null> {
  try {
    return (await fs.stat(dir)).dev;
  } catch {
    return null;
  }
}
