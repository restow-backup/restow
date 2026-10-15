/**
 * The restic commands the server runs on a file share's repository besides those it shares with
 * endpoints (../endpoints/restic-cli.ts): streaming `restic diff --json` and `restic ls --json`
 * for the catalog (docs/FILESHARES.md 8.5). The lines are handed to the caller one by one, so a
 * share with millions of files is never held in memory.
 */
import { createInterface } from "node:readline";
import { type ResticSession, resticErrorOf, spawnRestic } from "../endpoints/restic-cli.js";

const SNAPSHOT_ID = /^[0-9a-f]{8,64}$/;

function checkId(id: string): void {
  if (!SNAPSHOT_ID.test(id)) {
    throw new TypeError("a snapshot id must be 8 to 64 lower-case hex digits");
  }
}

/** Run restic and hand every stdout line to `onLine`; throws the restic error when it fails. */
export async function resticLines(
  session: ResticSession,
  args: readonly string[],
  onLine: (line: string) => void | Promise<void>,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const { child, done } = spawnRestic(session, args, { signal: options.signal });
  if (!child.stdout) {
    throw new Error("restic produced no output stream");
  }
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  let failure: unknown = null;
  for await (const line of lines) {
    if (failure) {
      continue;
    }
    try {
      await onLine(line);
    } catch (error) {
      failure = error;
      child.kill("SIGTERM");
    }
  }
  const { exitCode, signal, stderr } = await done;
  if (failure) {
    throw failure;
  }
  if (exitCode !== 0) {
    throw resticErrorOf(args, exitCode, stderr, signal);
  }
}

/** `restic diff --json <from> <to>`, line by line. */
export async function resticDiffLines(
  session: ResticSession,
  from: string,
  to: string,
  onLine: (line: string) => void | Promise<void>,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  checkId(from);
  checkId(to);
  return resticLines(session, ["diff", "--no-lock", "--json", from, to], onLine, options);
}

/** `restic ls --json <snapshot> [path]`, line by line (the whole tree below the path). */
export async function resticLsLines(
  session: ResticSession,
  snapshotId: string,
  onLine: (line: string) => void | Promise<void>,
  options: { signal?: AbortSignal; path?: string } = {},
): Promise<void> {
  checkId(snapshotId);
  const args = ["ls", "--no-lock", "--json", "--recursive", snapshotId];
  if (options.path) {
    args.push("--", options.path);
  }
  return resticLines(session, args, onLine, options);
}
