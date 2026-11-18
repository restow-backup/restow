/**
 * `db-stream` (docs/DATABASES.md 5.1): the command restic starts for a dump
 * (`restic backup --stdin-from-command -- node db-stream.js --spec <file>`). It reads the spec
 * the run wrote (0600, in memory: the program, its fixed arguments, its own environment with the
 * relay's socket and the `PGPASSFILE`), runs the program, passes its output to restic, and ends
 * with a code other than 0 when the program failed, so restic keeps no snapshot.
 *
 * Kept to erasable TypeScript with imports from packages only: tests run this file with Node's
 * type stripping, the image the compiled one.
 */
import { readFile } from "node:fs/promises";
import { type DbStreamSpec, runDbStream } from "@restow/core";

async function main(argv: string[]): Promise<number> {
  const at = argv.indexOf("--spec");
  const path = at >= 0 ? argv[at + 1] : undefined;
  if (!path) {
    process.stderr.write("db-stream: --spec <file> is required\n");
    return 2;
  }
  const spec = JSON.parse(await readFile(path, "utf8")) as DbStreamSpec;
  return runDbStream(spec, process.stdout);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`db-stream: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
