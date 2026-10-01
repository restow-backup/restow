/**
 * The restore test of an endpoint snapshot (docs/AGENT.md, readiness).
 *
 * After a good backup the agent reports the SHA-256 of up to 20 random files
 * (`endpoint_samples`). The test reads those files back from the repository
 * with `restic dump` and compares the hashes. Only matching hashes rate a
 * snapshot green. Red needs proof: a hash that differs, or restic reporting
 * that the file is not in the snapshot or that the data it needs is missing
 * or damaged. A read that failed for any other reason (the repository busy,
 * restic stopped, unable to start or to reach the repository, an error restic
 * does not put down to the backup) proves nothing either way: the result is
 * incomplete and the caller tries again later instead of rating it. The same
 * comparison and the same findings judge the result of the agent's own
 * `verify_sample` task ({@link judgeAgentRestoreTest}).
 */
import { createHash } from "node:crypto";
import { type ResticDump, ResticError, type ResticSession, resticDump } from "./restic-cli.js";

export interface SampleFile {
  path: string;
  sha256: string;
  size?: number;
}

export interface SampleMismatch {
  path: string;
  expected: string;
  actual: string | null;
  reason?: string;
}

export interface RestoreTestResult {
  files: number;
  matched: number;
  mismatched: SampleMismatch[];
  /**
   * A file could not be read for a reason that says nothing about the backup
   * (see {@link isBackupFinding}): the repository was busy, restic was stopped
   * or could not start, could not open the repository, or failed in a way it
   * does not put down to the backup's data. Such a result is incomplete and
   * no rating; the caller tries again later.
   */
  transient: boolean;
  /** Why the result is incomplete: the first such failure, one line, for the log. */
  incomplete?: string;
}

/**
 * What restic (0.19) ends with when the backup itself is wrong, once it opened
 * the repository: the file is not in the snapshot, the snapshot or data it
 * needs is not in the repository, or what it read does not decrypt or does not
 * match its id. Checked against damaged, missing and absent objects with the
 * real restic in restore-test.test.ts.
 */
const BACKUP_FINDINGS: readonly RegExp[] = [
  /not found in snapshot/,
  /<(?:data|index|snapshot)\/[0-9a-f]+> does not exist/,
  /not found in repository/,
  /ciphertext verification failed/,
  /invalid data returned/,
];

/**
 * Whether a failed read of a sampled file proves the backup wrong. Only a run
 * restic ended with its generic error (exit code 1) and, as its last word, a
 * fatal error with one of the messages above does. A busy, stopped or
 * unreachable repository, a wrong password or a missing repository (the
 * repository check rates those), a restic that could not start or crashed, a
 * timeout, and anything else restic does not put down to the data are no
 * finding about this backup. Earlier lines (warnings about a retried request)
 * do not count: only the error restic gave up with.
 */
export function isBackupFinding(error: unknown): boolean {
  if (!(error instanceof ResticError) || error.exitCode !== 1 || error.failure !== "other") {
    return false;
  }
  const last = error.stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
  return last.startsWith("Fatal: ") && isFindingMessage(last);
}

/** The snapshot itself is not in the repository (restic loads a full id directly). */
const SNAPSHOT_MISSING = /<snapshot\/[0-9a-f]+> does not exist/;

interface FindingOptions {
  /**
   * The snapshot may have been forgotten by retention since the test was
   * asked for (it is no longer the endpoint's newest): its absence then proves
   * nothing about the backup.
   */
  snapshotMayBeGone?: boolean;
}

function isFindingMessage(message: string, options: FindingOptions = {}): boolean {
  if (options.snapshotMayBeGone && SNAPSHOT_MISSING.test(message)) {
    return false;
  }
  return BACKUP_FINDINGS.some((finding) => finding.test(message));
}

/**
 * What the agent reports about its own restore test (`restoreTest` of a
 * finished `verify_sample` run, docs/AGENT.md): what it observed, without a
 * verdict. Older agents do not send it.
 */
export interface AgentRestoreTestReport {
  /** The task's files as the agent found them in the restored copy. */
  files: { path: string; sha256?: string; missing?: boolean; error?: string }[];
  /** How `restic restore` ended when it failed. */
  restic?: {
    exitCode: number;
    /** restic's final error as it wrote it ("Fatal: ..."), empty if it wrote none. */
    fatal: string;
    /** The errors restic reported for single items before it ended ("/" for the snapshot's tree). */
    errors: { item: string; message: string }[];
  };
}

export type AgentRestoreTestVerdict =
  | { rating: "green" | "red"; result: RestoreTestResult }
  | { rating: "incomplete"; reason: string };

/**
 * Whether a failed `restic restore` proves the backup wrong. Like
 * {@link isBackupFinding}, only restic's generic error (exit code 1) counts,
 * and only with restic's own words: either the error it gave up with is a
 * finding (the snapshot or its tree could not be loaded), or it gave up
 * because of errors on single items ("There were N errors"), the agent
 * forwarded all N, and every item that failed has at least one finding among
 * its errors. Follow-up errors on such an item (restic cannot set the owner of
 * a file it could not write) do not count against it; an item that failed
 * only for another reason (a full disk, a network error) leaves the test
 * incomplete, whatever the others showed.
 */
export function isRestoreFinding(
  restic: NonNullable<AgentRestoreTestReport["restic"]>,
  options: FindingOptions = {},
): boolean {
  const fatal = restic.fatal.trim();
  if (restic.exitCode !== 1 || !fatal.startsWith("Fatal: ")) {
    return false;
  }
  if (isFindingMessage(fatal, options)) {
    return true;
  }
  const count = /^Fatal: There (?:were|was) (\d+) errors?$/.exec(fatal);
  if (!count || Number(count[1]) === 0 || restic.errors.length !== Number(count[1])) {
    return false;
  }
  const explained = new Set(
    restic.errors
      .filter((error) => isFindingMessage(error.message, options))
      .map((error) => error.item),
  );
  return explained.size > 0 && restic.errors.every((error) => explained.has(error.item));
}

/** One line of restic's failure for a log or a reason, bounded like {@link reasonOf}. */
function resticReason(restic: NonNullable<AgentRestoreTestReport["restic"]>): string {
  const detail = restic.errors[0] ? `, first: ${restic.errors[0].message}` : "";
  return reasonOf(
    `restic restore failed (exit code ${restic.exitCode}): ${restic.fatal || "no error message"}${detail}`,
  );
}

/**
 * Judge the agent's own restore test (`verify_sample`) the way the server's
 * test is judged. Green only when every file of the task came back with its
 * hash and the agent reported success. Red only with proof: a hash that
 * differs, a file restic restored the snapshot without (not in it), or restic
 * reporting that data the files need is missing or damaged
 * ({@link isRestoreFinding}). Everything else is incomplete and rates nothing:
 * the agent could not run or finish the test (stopped, a full or unwritable
 * disk, no network, a busy repository, an invalid task), a file it could not
 * read on the machine, or an older agent that failed without saying why (its
 * report has no `restoreTest`). An older agent's success still counts: it
 * compared every hash itself.
 */
export function judgeAgentRestoreTest(input: {
  expected: readonly SampleFile[];
  status: "succeeded" | "partial" | "failed";
  /** How many errors the run reported. */
  errorCount: number;
  report?: AgentRestoreTestReport | null;
  /** See {@link FindingOptions.snapshotMayBeGone}. */
  snapshotMayBeGone?: boolean;
}): AgentRestoreTestVerdict {
  const { expected, report } = input;
  if (expected.length === 0) {
    return { rating: "incomplete", reason: "the restore-test task lists no files" };
  }
  if (!report) {
    if (input.status === "succeeded" && input.errorCount === 0) {
      return {
        rating: "green",
        result: {
          files: expected.length,
          matched: expected.length,
          mismatched: [],
          transient: false,
        },
      };
    }
    return { rating: "incomplete", reason: "the agent reported no restore-test result" };
  }
  const options = { snapshotMayBeGone: input.snapshotMayBeGone };
  const restic = report.restic;
  const proven = restic ? isRestoreFinding(restic, options) : false;
  if (restic && !proven) {
    return { rating: "incomplete", reason: resticReason(restic) };
  }
  const byPath = new Map(report.files.map((file) => [file.path, file]));
  const observed = new Map<string, { sha256: string | null; reason?: string }>();
  for (const sample of expected) {
    const file = byPath.get(sample.path);
    if (file?.sha256) {
      observed.set(sample.path, { sha256: file.sha256 });
      continue;
    }
    if (file?.missing || (!file && proven)) {
      // restic's finding for this file, else the one for the snapshot's tree, else the absence itself.
      const findings = restic?.errors.filter((error) => isFindingMessage(error.message, options));
      const said =
        findings?.find((error) => error.item === sample.path)?.message ??
        findings?.[0]?.message ??
        (restic ? restic.fatal : "The file is not in the snapshot.");
      observed.set(sample.path, { sha256: null, reason: reasonOf(said) });
      continue;
    }
    return {
      rating: "incomplete",
      reason: reasonOf(`${sample.path}: ${file?.error ?? "not checked by the agent"}`),
    };
  }
  const result = compareSamples(expected, observed);
  if (result.mismatched.length > 0) {
    return { rating: "red", result };
  }
  if (input.status === "succeeded" && !restic) {
    return { rating: "green", result };
  }
  return { rating: "incomplete", reason: "the agent reported a failure, but every file matched" };
}

/**
 * One line of an error for a log or a summary, bounded. restic names the cause
 * last, after paths that can be long, so a long line keeps its start and its end.
 */
function reasonOf(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ");
  return message.length <= 300 ? message : `${message.slice(0, 100)} ... ${message.slice(-195)}`;
}

/** SHA-256 (hex, lower case) of everything a stream delivers. */
async function sha256Of(stream: AsyncIterable<Buffer | Uint8Array>): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** Compare reported hashes with observed ones; the pure part of the test. */
export function compareSamples(
  expected: readonly SampleFile[],
  actual: ReadonlyMap<string, { sha256: string | null; reason?: string }>,
): RestoreTestResult {
  const mismatched: SampleMismatch[] = [];
  let matched = 0;
  for (const sample of expected) {
    const seen = actual.get(sample.path);
    if (seen?.sha256 && seen.sha256.toLowerCase() === sample.sha256.toLowerCase()) {
      matched += 1;
    } else {
      mismatched.push({
        path: sample.path,
        expected: sample.sha256,
        actual: seen?.sha256 ?? null,
        ...(seen?.reason ? { reason: seen.reason } : {}),
      });
    }
  }
  return { files: expected.length, matched, mismatched, transient: false };
}

/**
 * Restore-test `samples` of `snapshotId`: dump each file, hash it, compare.
 * Nothing is written to disk. The smallest file is read first and alone, the
 * rest four at a time: restic (0.19) cannot set up a new cache folder from
 * several processes at once. One of them writes the folder's version file
 * while another reads it still empty and gives up ("unable to open cache:
 * readVersion"), which made the first restore test of a new endpoint fail at
 * random. Once one run has set the folder up, restic shares it safely.
 */
export async function restoreTestSamples(
  session: ResticSession,
  snapshotId: string,
  samples: readonly SampleFile[],
  options: { signal?: AbortSignal; concurrency?: number } = {},
): Promise<RestoreTestResult> {
  const observed = new Map<string, { sha256: string | null; reason?: string }>();
  let incomplete: string | undefined;
  const read = async (sample: SampleFile): Promise<void> => {
    let dump: ResticDump | undefined;
    try {
      dump = resticDump(session, snapshotId, sample.path, { signal: options.signal });
      const digest = await sha256Of(dump.stream);
      await dump.done;
      observed.set(sample.path, { sha256: digest });
    } catch (error) {
      dump?.cancel();
      const reason = reasonOf(error);
      if (!isBackupFinding(error)) {
        incomplete ??= reason;
      }
      observed.set(sample.path, { sha256: null, reason });
    }
  };
  const [first, ...rest] = [...samples].sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
  if (first) {
    await read(first);
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < rest.length) {
      await read(rest[next++] as SampleFile);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency ?? 4, rest.length) }, worker),
  );
  const result = compareSamples(samples, observed);
  return incomplete === undefined ? result : { ...result, transient: true, incomplete };
}
