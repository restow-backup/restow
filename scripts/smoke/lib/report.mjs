/**
 * The smoke report (smoke-report.md). One row per check with its result, its
 * duration and the date it ran; a check that did not run says so in plain
 * words. A skipped check is never green: the summary line counts it apart and
 * the reason stands in the row.
 *
 * scripts/ci/release-lib.mjs reads the check table back (parseSmokeReport), so
 * the column layout below is a contract; report.test.mjs pins it.
 */

/**
 * PASS      every step ran and passed
 * PARTIAL   the steps that ran passed, but some step could not run (its reason
 *           stands in the row); never shown as a plain PASS
 * SKIPPED   nothing ran
 * FAIL      a step failed
 */
export const RESULT = Object.freeze({
  PASS: "PASS",
  PARTIAL: "PARTIAL",
  FAIL: "FAIL",
  SKIPPED: "SKIPPED",
});

function cell(text) {
  return String(text ?? "")
    .replace(/\r?\n/gu, " ")
    .replace(/\|/gu, "\\|")
    .trim();
}

/** "95s", "2m 05s": how long a check took. */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The two builds (docs/CI.md, "Two build targets"), as the report names them. */
const BUILD_NAMES = {
  full: "full (core and the Business and Service Provider modules, Dockerfile targets runtime and web)",
  community:
    "Community (the Apache-2.0 core without ee/, Dockerfile targets runtime-community and web-community)",
};

export class Report {
  constructor(meta) {
    this.meta = meta;
    this.checks = [];
    this.startedAt = new Date();
  }

  /**
   * Record one check.
   *   id, name    the row's number ("1", "10") and title
   *   result      RESULT.PASS | FAIL | SKIPPED
   *   summary     one line for the table (why it failed or was skipped)
   *   steps       [{ name, result, detail }] shown under "Details"
   */
  add({ id, name, result, summary = "", durationMs = 0, steps = [], startedAt = new Date() }) {
    this.checks.push({ id: String(id), name, result, summary, durationMs, steps, startedAt });
  }

  get failed() {
    return this.checks.filter((check) => check.result === RESULT.FAIL);
  }

  get skipped() {
    return this.checks.filter((check) => check.result === RESULT.SKIPPED);
  }

  get partial() {
    return this.checks.filter((check) => check.result === RESULT.PARTIAL);
  }

  get passed() {
    return this.checks.filter((check) => check.result === RESULT.PASS);
  }

  /** PASS only when nothing failed; SKIPPED checks are named in the verdict. */
  verdict() {
    if (this.failed.length > 0) {
      return `FAIL: ${this.failed.length} of ${this.checks.length} checks failed`;
    }
    if (this.skipped.length > 0 || this.partial.length > 0) {
      return `PASS with gaps: ${this.passed.length} of ${this.checks.length} checks passed in full, ${this.partial.length} partly, ${this.skipped.length} skipped (see the reasons below)`;
    }
    return `PASS: all ${this.checks.length} checks passed`;
  }

  toMarkdown(finishedAt = new Date()) {
    const lines = [
      "# Restow release smoke report",
      "",
      `- Build: ${BUILD_NAMES[this.meta.variant ?? "full"]}`,
      `- Version: ${this.meta.version || "unreleased build"}`,
      `- Image: ${this.meta.image}`,
      `- Revision: ${this.meta.revision || "unknown"}`,
      `- Platform: ${this.meta.platform}`,
      `- Started: ${this.startedAt.toISOString()}`,
      `- Finished: ${finishedAt.toISOString()}`,
      `- Run by: ${this.meta.runner}`,
      `- Verdict: ${this.verdict()}`,
      "",
      "| # | Check | Result | Duration | Detail |",
      "| --- | --- | --- | --- | --- |",
    ];
    for (const check of this.checks) {
      lines.push(
        `| ${check.id} | ${cell(check.name)} | ${check.result} | ${formatDuration(check.durationMs)} | ${cell(check.summary)} |`,
      );
    }
    lines.push("");
    const gaps = this.checks.filter(
      (check) => check.result === RESULT.SKIPPED || check.result === RESULT.PARTIAL,
    );
    if (gaps.length > 0) {
      lines.push("## Skipped or partial checks", "");
      for (const check of gaps) {
        lines.push(`- ${check.id}. ${check.name} (${check.result}): ${check.summary}`);
      }
      lines.push("");
    }
    lines.push("## Details", "");
    for (const check of this.checks) {
      lines.push(`### ${check.id}. ${check.name}`, "");
      lines.push(
        `Result: ${check.result}. Ran ${check.startedAt.toISOString()}, took ${formatDuration(check.durationMs)}.`,
        "",
      );
      if (check.summary) {
        lines.push(check.summary, "");
      }
      for (const step of check.steps) {
        const detail = step.detail ? `: ${String(step.detail).replace(/\r?\n/gu, " ")}` : "";
        lines.push(`- ${step.result} ${step.name}${detail}`);
      }
      if (check.steps.length > 0) {
        lines.push("");
      }
    }
    return `${lines.join("\n").replace(/\n{3,}/gu, "\n\n")}\n`;
  }
}

export class StepFailure extends Error {
  constructor(step, message) {
    super(`${step}: ${message}`);
    this.name = "StepFailure";
  }
}

/**
 * Collects the steps of one check while it runs. `step()` runs a function and
 * records PASS or FAIL (a failed step throws, so the check stops there);
 * `skip()` records a step that could not run. The check fails when any step
 * failed.
 */
export class CheckRun {
  constructor(id, name, log = console.log) {
    this.id = id;
    this.name = name;
    this.log = log;
    this.steps = [];
    this.startedAt = new Date();
    this.startedMs = Date.now();
  }

  async step(name, fn) {
    const began = Date.now();
    this.log(`  - ${name}`);
    try {
      const detail = await fn();
      this.steps.push({
        name,
        result: RESULT.PASS,
        detail: typeof detail === "string" ? detail : "",
      });
      return detail;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`    FAILED after ${formatDuration(Date.now() - began)}: ${message.split("\n")[0]}`);
      this.steps.push({ name, result: RESULT.FAIL, detail: message });
      throw new StepFailure(name, message);
    }
  }

  skip(name, reason) {
    this.log(`  - ${name}: skipped, ${reason}`);
    this.steps.push({ name, result: RESULT.SKIPPED, detail: reason });
  }

  /** A step with nothing to run that still belongs in the details. */
  note(name, detail) {
    this.steps.push({ name, result: RESULT.PASS, detail });
  }

  /** The finished check as a row for {@link Report.add}. */
  finish({ skippedSummary, failure } = {}) {
    const failed = this.steps.filter((step) => step.result === RESULT.FAIL);
    const skipped = this.steps.filter((step) => step.result === RESULT.SKIPPED);
    let result = RESULT.PASS;
    let summary = "";
    if (failure || failed.length > 0) {
      result = RESULT.FAIL;
      summary = failure ?? `${failed[0].name}: ${String(failed[0].detail).split("\n")[0]}`;
    } else if (skippedSummary) {
      result = RESULT.SKIPPED;
      summary = skippedSummary;
    } else {
      const passed = this.steps.filter((step) => step.result === RESULT.PASS).length;
      summary = `${passed} steps passed`;
      if (skipped.length > 0) {
        result = RESULT.PARTIAL;
        summary += `; not run: ${skipped.map((step) => `${step.name} (${step.detail})`).join("; ")}`;
      }
    }
    return {
      id: this.id,
      name: this.name,
      result,
      summary,
      durationMs: Date.now() - this.startedMs,
      startedAt: this.startedAt,
      steps: this.steps,
    };
  }
}

/** Thrown by a check that has nothing to do here; the reason goes into the report. */
export class Skip extends Error {
  constructor(reason) {
    super(reason);
    this.name = "Skip";
  }
}
