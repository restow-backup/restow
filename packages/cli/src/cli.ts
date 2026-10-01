/**
 * The `restow-restore` commands, runnable in-process: {@link runCli} parses
 * the arguments, runs the command and returns the exit code instead of
 * exiting, so tests drive exactly the code path the binary runs.
 *
 * Exit codes: 0 when every object was restored or verified, 1 when any object
 * failed (the failure list is printed at the end) or the run could not start
 * (unreadable manifest, missing key material, bad arguments).
 *
 * `endpoint-password` opens the repository password of a server or client
 * (docs/AGENT.md, "Restore ohne Restow"): the server keeps it sealed with the
 * tenant key next to the endpoint's restic repository, so the KEK and the
 * storage are enough to hand plain restic what it needs.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LocalStorageBackend,
  endpointPasswordKey,
  openEndpointPassword,
  readEndpointPasswordDocument,
  readOnlyFallbackChain,
} from "@restow/core";
import type { StorageBackend } from "@restow/core";
import { Command, CommanderError } from "commander";
import { type Keyring, loadKeyring } from "./keyring.js";
import { type ObjectResult, type RunReport, restoreSnapshot, verifySnapshot } from "./restore.js";
import { ChunkStore, readManifest } from "./store.js";

export const VERSION = "0.0.0";

/** Where the commands write; the binary passes the process streams. */
export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

interface RestoreOptions {
  manifest: string;
  /** One or more `--storage` roots, current primary first (see {@link openStore}). */
  storage: string[];
  key: string;
  out: string;
}

type VerifyOptions = Omit<RestoreOptions, "out">;

interface EndpointPasswordOptions {
  storage: string[];
  key: string;
  endpoint: string;
  /** Write the password into this new file instead of printing it. */
  out?: string;
}

/** An endpoint id as the server makes them (a UUID); nothing that could leave the storage root. */
const ENDPOINT_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Collect repeated `--storage <dir>` occurrences into an ordered array. */
function collectStorageDir(value: string, previous: string[] | undefined): string[] {
  return previous ? [...previous, value] : [value];
}

class Reporter {
  constructor(private readonly io: CliIo) {}

  object(result: ObjectResult): void {
    if (!result.ok) {
      this.io.stderr(`  FAIL  ${result.path}: ${result.error}\n`);
    } else if (result.skipped !== undefined) {
      this.io.stderr(`  skip  ${result.path}: ${result.skipped}\n`);
    } else {
      this.io.stderr(`  ok    ${result.path} (${result.bytes} bytes)\n`);
    }
  }

  /**
   * Say which packs were skipped before any object is processed, so a later
   * "chunk not present" failure can be traced to the damaged pack behind it.
   */
  unreadablePacks(store: ChunkStore): void {
    const skipped = store.unreadablePacks;
    if (skipped.length === 0) {
      return;
    }
    this.io.stderr(
      `warning: ${skipped.length} pack(s) could not be read and were skipped; objects with chunks only in them will fail:\n`,
    );
    for (const pack of skipped) {
      this.io.stderr(`  SKIP  ${pack.key}: ${pack.reason}\n`);
    }
  }

  /** Say plainly when chunk ids cannot be recomputed. */
  chunkIdCheck(hasKey: boolean): void {
    if (!hasKey) {
      this.io.stderr(
        "note: no chunk-id key (the version 1 data key is not in the keyring): chunks are checked by their authenticated header, objects by size and SHA-256\n",
      );
    }
  }

  summary(verb: string, report: RunReport): void {
    this.io.stderr(
      `${verb} snapshot ${report.snapshotId} (tenant ${report.tenantId}): ` +
        `${report.restored}/${report.total} ok, ${report.skipped} skipped, ${report.failed} failed\n`,
    );
    if (report.failures.length === 0) {
      return;
    }
    const integrity = report.failures.filter((failure) => failure.integrity).length;
    this.io.stderr(
      `failed objects (${report.failures.length}, ${integrity} with data that does not match the manifest):\n`,
    );
    for (const failure of report.failures) {
      this.io.stderr(`  ${failure.path}: ${failure.error}\n`);
    }
  }
}

/**
 * Build the read-only view over every `--storage` root: the current primary
 * first, then any earlier targets a "keep" storage-target replacement left
 * behind with their pre-switch packs and manifests still on them
 * (docs/STORAGE.md, "Replace the primary"). Backup dedupes through the
 * server's Postgres chunk index, which does not know which target holds a
 * pack, so a snapshot taken after a "keep" switch can reference packs that
 * live only on a retired target; this tool has no such index and must scan
 * every given root to find them. A single `--storage` behaves exactly as
 * before (`readOnlyFallbackChain` is a pass-through for one backend).
 */
function openBackends(storageDirs: readonly string[]): StorageBackend {
  return readOnlyFallbackChain(storageDirs.map((dir) => new LocalStorageBackend(dir)));
}

/**
 * Read the manifest and the keys it needs. A sealed manifest names its tenant
 * in its header, so the keyring is loaded first and opens it; a manifest
 * written before sealing is read first and names the tenant itself.
 */
async function openStore(
  manifestRef: string,
  storageDirs: readonly string[],
  keyRef: string,
  out: Reporter,
) {
  const backend = openBackends(storageDirs);
  let loaded: { tenantId: string; keyring: Keyring } | null = null;
  const keyringFor = async (tenantId: string): Promise<Keyring> => {
    if (loaded?.tenantId !== tenantId) {
      loaded = { tenantId, keyring: await loadKeyring({ keyRef, backend, tenantId }) };
    }
    return loaded.keyring;
  };
  const manifest = await readManifest(manifestRef, backend, keyringFor);
  const store = await ChunkStore.build(backend, manifest.tenantId);
  out.unreadablePacks(store);
  const keyring = await keyringFor(manifest.tenantId);
  out.chunkIdCheck(keyring.hmacKey !== undefined);
  return { manifest, store, keyring };
}

function buildProgram(io: CliIo, setExitCode: (code: number) => void): Command {
  const out = new Reporter(io);
  const program = new Command();
  program
    .name("restow-restore")
    .description("Standalone restore from a Restow chunk store, without a running server.")
    .version(VERSION)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  program
    .command("restore")
    .description(
      "Reassemble a snapshot's files into an output directory; a file is written only when every check passes.",
    )
    .requiredOption("--manifest <path>", "snapshot manifest: a local file, or a key in the store")
    .requiredOption(
      "--storage <dir>",
      "path to a local storage backend root; repeat to also read pack and key material a " +
        '"keep" storage-target replacement left on earlier targets, current primary first',
      collectStorageDir,
    )
    .requiredOption("--key <file|env>", "KEK or exported keyring: a file path or env var name")
    .requiredOption("--out <dir>", "directory to write the reconstructed files into")
    .action(async (options: RestoreOptions) => {
      const { manifest, store, keyring } = await openStore(
        options.manifest,
        options.storage,
        options.key,
        out,
      );
      const report = await restoreSnapshot({
        manifest,
        store,
        keyring,
        outDir: options.out,
        onObject: (result) => out.object(result),
      });
      out.summary("restored", report);
      setExitCode(report.failed > 0 ? 1 : 0);
    });

  program
    .command("verify")
    .description("Hash-check a snapshot end to end without writing any files.")
    .requiredOption("--manifest <path>", "snapshot manifest: a local file, or a key in the store")
    .requiredOption(
      "--storage <dir>",
      "path to a local storage backend root; repeat to also read pack and key material a " +
        '"keep" storage-target replacement left on earlier targets, current primary first',
      collectStorageDir,
    )
    .requiredOption("--key <file|env>", "KEK or exported keyring: a file path or env var name")
    .action(async (options: VerifyOptions) => {
      const { manifest, store, keyring } = await openStore(
        options.manifest,
        options.storage,
        options.key,
        out,
      );
      const report = await verifySnapshot({
        manifest,
        store,
        keyring,
        onObject: (result) => out.object(result),
      });
      out.summary("verified", report);
      setExitCode(report.failed > 0 ? 1 : 0);
    });

  program
    .command("endpoint-password")
    .description(
      "Open the restic password of a server's or client's repository from the storage and the KEK, so plain restic can restore it.",
    )
    .requiredOption(
      "--storage <dir>",
      "path to the local storage backend root that holds endpoints/<endpoint id>/; repeat to also look on earlier targets",
      collectStorageDir,
    )
    .requiredOption("--key <file|env>", "KEK or exported keyring: a file path or env var name")
    .requiredOption("--endpoint <id>", "the endpoint id (the folder name under endpoints/)")
    .option(
      "--out <file>",
      "write the password into this new file (mode 0600, never overwritten) instead of printing it",
    )
    .action(async (options: EndpointPasswordOptions) => {
      if (!ENDPOINT_ID.test(options.endpoint)) {
        throw new Error(`--endpoint "${options.endpoint}" is not an endpoint id`);
      }
      const endpointId = options.endpoint.toLowerCase();
      const backend = openBackends(options.storage);
      const key = endpointPasswordKey(endpointId);
      let document: Buffer;
      try {
        document = await backend.get(key);
      } catch {
        throw new Error(
          `no sealed repository password at ${key}: the server writes it when a machine enrolls and backfills it at the next retention or check run`,
        );
      }
      const { tenantId } = readEndpointPasswordDocument(document);
      const keyring = await loadKeyring({ keyRef: options.key, backend, tenantId });
      const { password } = openEndpointPassword(
        document,
        (sealed) => keyring.decrypt(sealed),
        endpointId,
      );
      io.stderr(
        "warning: this is the password of the restic repository of this machine. With it and the storage, anyone can read every backup of the machine: keep it out of shell histories, tickets and logs, and delete a copy once the restore is done.\n",
      );
      const repository = join(
        options.storage.find((dir) => existsSync(join(dir, "endpoints", endpointId, "config"))) ??
          (options.storage[0] as string),
        "endpoints",
        endpointId,
      );
      if (options.out) {
        await writeFile(options.out, `${password}\n`, { mode: 0o600, flag: "wx" });
        io.stderr(`wrote the password to ${options.out}\n`);
        io.stderr(
          `open the repository with: restic -r ${repository} --password-file ${options.out} snapshots\n`,
        );
      } else {
        io.stdout(`${password}\n`);
        io.stderr(
          `open the repository with: restic -r ${repository} --password-file <file with this password> snapshots\n`,
        );
      }
      setExitCode(0);
    });

  return program;
}

/**
 * Run `restow-restore` with the given arguments (without the node and script
 * paths) and return the exit code.
 */
export async function runCli(argv: readonly string[], io: CliIo = processIo): Promise<number> {
  let exitCode = 0;
  const program = buildProgram(io, (code) => {
    exitCode = code;
  });
  try {
    await program.parseAsync([...argv], { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Usage errors, --help and --version: commander has already said why.
      return error.exitCode;
    }
    io.stderr(`restow-restore: ${messageOf(error)}\n`);
    return 1;
  }
}
