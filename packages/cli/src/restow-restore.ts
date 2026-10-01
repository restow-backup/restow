#!/usr/bin/env node
/**
 * restow-restore — standalone restore from a Restow chunk store.
 *
 * Reconstructs files from an open storage backend and a snapshot manifest with
 * no running Restow server and no database. This is a contractual guarantee to
 * customers (docs/ARCHITECTURE.md): a restore must remain possible from the
 * storage format alone.
 *
 *   restow-restore restore --manifest <path> --storage <dir> --key <file|env> --out <dir>
 *   restow-restore verify  --manifest <path> --storage <dir> --key <file|env>
 *
 * Every chunk is checked against the id the manifest requested and every
 * object against the manifest's size and SHA-256; a file that fails a check
 * is never written. Any failure makes the exit code non-zero. The commands
 * live in ./cli.ts.
 */
import { runCli } from "./cli.js";

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `restow-restore: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
