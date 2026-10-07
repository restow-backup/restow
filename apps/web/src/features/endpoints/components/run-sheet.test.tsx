import { beforeAll, describe, expect, it } from "vitest";

import { count, render } from "@/components/kit/test-utils";
import { i18n } from "@/i18n";

import type { Failure } from "@/features/failures";

import type { RunDetail } from "../api.js";
import "../i18n.js";
import { RunDetailView } from "./run-sheet.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function run(over: Partial<RunDetail> = {}): RunDetail {
  return {
    id: "r1",
    kind: "backup",
    status: "succeeded",
    startedAt: "2026-09-30T10:00:00.000Z",
    finishedAt: "2026-09-30T10:03:12.000Z",
    snapshotId: "0123456789abcdef",
    errorCount: 0,
    interruptedOnly: false,
    checkIncomplete: false,
    failure: null,
    filesNew: 10,
    dataAdded: 2048,
    totalBytesProcessed: 10_000_000,
    progress: null,
    taskId: null,
    errors: [],
    logTail: "using parent snapshot 1234\nsnapshot 0123 saved",
    stats: {
      filesNew: 10,
      filesChanged: 4,
      filesUnmodified: 986,
      dataAdded: 2048,
      totalFilesProcessed: 1000,
      totalBytesProcessed: 10_000_000,
    },
    ...over,
  };
}

const render_ = (value: RunDetail) => render(<RunDetailView run={value} />);

describe("RunDetailView", () => {
  it("shows the facts, the statistics and the log tail of a good run", () => {
    const html = render_(run());
    expect(html).toContain("Succeeded");
    expect(html).toContain("01234567");
    expect(html).toContain("Files processed");
    expect(html).toContain("986");
    expect(html).toContain("Data added to storage");
    expect(html).toContain("The run reported no errors.");
    expect(html).toContain("snapshot 0123 saved");
    expect(html).toContain("font-mono");
    expect(html).toContain("overflow-auto");
    expect(html).toContain("Secrets are never part of it.");
  });

  it("lists the files a partial run could not read, and says what partial means", () => {
    const html = render_(
      run({
        status: "partial",
        errorCount: 2,
        errors: [
          { path: "/var/lib/db/lock", message: "permission denied", code: "EACCES" },
          { message: "file changed while reading" },
        ],
      }),
    );
    expect(html).toContain("With warnings");
    expect(html).toContain("some files could not be read");
    expect(html).toContain("missing from this snapshot");
    expect(html).toContain("2 errors");
    expect(html).toContain("/var/lib/db/lock");
    expect(html).toContain("permission denied");
    expect(html).toContain("EACCES");
    expect(html).toContain("file changed while reading");
  });

  it("words the codes of the agent and keeps the agent's own message as the detail", () => {
    const html = render_(
      run({
        status: "partial",
        errors: [
          { path: "/srv/db.sql", message: "exit status 1", code: "pre_hook_failed" },
          { path: "/srv/a", message: "permission denied", code: "read_error" },
          { message: "exit status 3", code: "restic_exit_3" },
          { message: "something odd", code: "weird_code" },
        ],
      }),
    );
    expect(html).toContain("The command before the backup failed, so the backup did not run");
    expect(html).toContain("A file could not be read");
    expect(html).toContain("restic ended with exit code 3");
    expect(html).toContain("Error code weird_code");
    // The agent's own (English) text is a collapsed detail under the translated meaning.
    expect(html).toMatch(
      /<details[^>]*><summary[^>]*>Technical message from the agent<\/summary><p[^>]*>exit status 1<\/p><\/details>/,
    );
    expect(html).toContain("something odd");
  });

  it("words a restore whose target folder could not be used and a restic error", () => {
    const html = render_(
      run({
        status: "failed",
        errors: [
          {
            message: "the folder /srv does not exist; restore into an existing folder",
            code: "target_unusable",
          },
          { message: "Fatal: unable to open repository", code: "restic_error" },
        ],
      }),
    );
    expect(html).toContain("The target folder could not be used");
    expect(html).toContain("restic stopped with an error");
    expect(html).not.toContain("Error code target_unusable");
    expect(html).not.toContain("Error code restic_error");
  });

  it("does not show a run that was only interrupted as a failure", () => {
    const html = render_(
      run({
        status: "failed",
        snapshotId: null,
        stats: null,
        errorCount: 1,
        errors: [{ message: "agent restarted", code: "interrupted" }],
      }),
    );
    expect(html).toContain("Interrupted");
    expect(html).toContain("Interrupted, continues automatically");
    expect(html).toContain('data-run-note="interrupted"');
    expect(html).toContain("This is not a failure");
    expect(html).not.toContain("Failed");
    expect(html).not.toContain("nothing new was saved");
  });

  it("still shows a failed run that has other errors next to an interruption as failed", () => {
    const html = render_(
      run({
        status: "failed",
        errors: [
          { message: "agent restarted", code: "interrupted" },
          { message: "no space", code: "read_error" },
        ],
      }),
    );
    expect(html).toContain("Failed");
    expect(html).not.toContain('data-run-note="interrupted"');
  });

  describe("a restore test on the machine", () => {
    const stopped: Failure = {
      code: "endpoint.restic_failed",
      category: "endpoint",
      transient: false,
      retryable: false,
      params: { exitCode: 1 },
      technical: { message: "write /tmp/x: no space left on device" },
      occurredAt: "2026-09-30T10:03:12.000Z",
      step: null,
      retry: null,
      steps: [],
      docsUrl: "https://docs.example.test/troubleshooting",
    };
    const incomplete = (over: Partial<RunDetail> = {}) =>
      run({
        kind: "verify_sample",
        status: "failed",
        stats: null,
        errorCount: 1,
        errors: [{ message: "no space left on device", code: "restic_exit_1" }],
        failure: stopped,
        checkIncomplete: true,
        ...over,
      });

    it("shows a test that could not complete neutrally, with its cause, never as failed", () => {
      const html = render_(incomplete());
      expect(html).toContain("Not completed, will be retried");
      expect(html).toContain('data-run-mark="incomplete"');
      expect(html).toContain('data-run-note="incomplete"');
      expect(html).toContain("says nothing about the backup");
      // Why it stopped is still explained, in the neutral tone.
      expect(html).toContain("The backup program ended with an error");
      expect(html).toContain('data-variant="info"');
      expect(html).not.toContain('data-variant="destructive"');
      expect(html).not.toContain('data-tone="destructive"');
      expect(html).not.toContain('data-tone="success"');
      expect(html).not.toContain("Failed");
      expect(html).not.toContain("nothing new was saved");
    });

    it("says incomplete rather than interrupted when the agent was stopped mid-test", () => {
      const html = render_(
        incomplete({
          failure: null,
          errors: [{ message: "agent stopping", code: "interrupted" }],
        }),
      );
      expect(html).toContain('data-run-note="incomplete"');
      expect(html).not.toContain('data-run-note="interrupted"');
      expect(html).not.toContain("Failed");
    });

    it("promises no further test on a revoked machine", () => {
      const html = render(<RunDetailView run={incomplete()} willRetry={false} />);
      expect(html).toContain("Not completed");
      expect(html).not.toContain("will be retried");
      expect(html).toContain("gets no more restore checks");
    });

    it("keeps red for a test that proved the backup broken and green for one that passed", () => {
      const red = render_(
        run({
          kind: "verify_sample",
          status: "failed",
          errors: [{ path: "/etc/hosts", message: "SHA-256 mismatch", code: "hash_mismatch" }],
        }),
      );
      expect(red).toContain("Failed");
      expect(red).toContain('data-tone="destructive"');
      expect(red).not.toContain('data-run-note="incomplete"');
      const green = render_(run({ kind: "verify_sample", status: "succeeded", stats: null }));
      expect(green).toContain('data-tone="success"');
      expect(green).toContain("Succeeded");
    });
  });

  it("says a failed run saved nothing new", () => {
    const html = render_(
      run({
        status: "failed",
        snapshotId: null,
        stats: null,
        errors: [{ message: "repository locked" }],
      }),
    );
    expect(html).toContain("Failed");
    expect(html).toContain("nothing new was saved");
    expect(html).toContain("repository locked");
    expect(html).not.toContain("Snapshot</dt>");
  });

  it("follows a running run with live progress and the current file", () => {
    const html = render_(
      run({
        status: "running",
        finishedAt: null,
        snapshotId: null,
        stats: null,
        logTail: null,
        progress: {
          filesDone: 250,
          bytesDone: 500,
          totalFiles: 1000,
          totalBytes: 2000,
          currentPath: "/srv/data/big.iso",
          updatedAt: "2026-09-30T10:01:00.000Z",
        },
      }),
    );
    expect(html).toContain("Running");
    expect(html).toContain('data-slot="run-progress"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("25%");
    expect(html).toContain("250 of 1,000 files");
    expect(html).toContain("/srv/data/big.iso");
    expect(html).toContain("Still running");
    expect(html).toContain("The log is reported when the run ends.");
  });

  it("does not invent a percentage when the machine reports no total", () => {
    const html = render_(
      run({
        status: "running",
        finishedAt: null,
        snapshotId: null,
        stats: null,
        logTail: null,
        progress: { filesDone: 42, bytesDone: 1000, updatedAt: "2026-09-30T10:01:00.000Z" },
      }),
    );
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain("42 files");
    expect(html).not.toContain("%");
  });

  it("says when no progress arrived yet", () => {
    const html = render_(
      run({ status: "running", finishedAt: null, stats: null, logTail: null, progress: null }),
    );
    expect(html).toContain("The machine has not reported progress yet.");
  });

  it("cuts a very long error list and says how many are not shown", () => {
    const errors = Array.from({ length: 130 }, (_, i) => ({ path: `/f/${i}`, message: "denied" }));
    const html = render_(run({ status: "partial", errorCount: 130, errors }));
    expect(count(html, "denied")).toBe(100);
    expect(html).toContain("30 more errors are not shown here.");
  });

  it("speaks German", async () => {
    await i18n.changeLanguage("de");
    try {
      const html = render_(run({ status: "partial", errors: [{ message: "x" }] }));
      expect(html).toContain("Mit Warnungen");
      expect(html).toContain("Ende des Protokolls");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
