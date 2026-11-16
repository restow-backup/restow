/**
 * Redaction of what an agent reports about a run (docs/AGENT.md, "Grenzen, die
 * der Server erzwingt"): the error messages and the log tail are stored and
 * shown in the web app, so they go through the same redaction as every other
 * failure text (../failures/redact.ts) before they are stored. The agent
 * redacts as well; the server does not rely on that, because a log line can
 * carry whatever a hook or restic printed.
 *
 * A log keeps its lines: every line is redacted on its own, and a line with
 * nothing to remove is kept exactly as it came (the shared redaction puts text
 * on one line and collapses whitespace, which would make a log unreadable).
 */
import { redactSensitiveText } from "../failures/redact.js";

/** Key material spans lines, so it is removed from the whole text before the lines are looked at. */
const KEY_BLOCK = /-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is stripped
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

/** What the shared redaction makes of a line that holds nothing to remove. */
function normalised(line: string): string {
  return line
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function redactLine(line: string): string {
  const redacted = redactSensitiveText(line, Number.MAX_SAFE_INTEGER);
  return redacted === normalised(line) ? line : redacted;
}

/** An agent's log tail without credentials, line by line. */
export function redactAgentLog(text: string): string {
  if (text === "") {
    return text;
  }
  return text.replace(KEY_BLOCK, "[redacted]").split(/\r?\n/).map(redactLine).join("\n");
}

/**
 * Terminal escape sequences (CSI, OSC and the other ESC forms) and the C1 control characters: a
 * recovery log comes from a console program and is shown as text (docs/BAREMETAL.md 9.8).
 */
const ANSI_SEQUENCES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what is stripped
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]|[\u0080-\u009f]/g;

/** `text` without terminal escape sequences and C1 control characters. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCES, "");
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is stripped
const LINE_CONTROLS = /[\u0000-\u0008\u000a-\u001f\u007f]/g;

const REDACTED_LINE = "[redacted]";
const KEY_BEGIN = /-----BEGIN [A-Z ]+-----/;
const KEY_END = /-----END [A-Z ]+-----/;
const KEY_BLOCK_ON_LINE = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g;

/** One line of a recovery log, and whether a key block is still open after it. */
function redactRecoveryLine(line: string, open: boolean): { text: string; open: boolean } {
  let rest = line;
  let prefix = "";
  if (open) {
    const end = KEY_END.exec(rest);
    if (!end) {
      return { text: REDACTED_LINE, open: true };
    }
    prefix = REDACTED_LINE;
    rest = rest.slice(end.index + end[0].length);
  }
  const closed = rest.replace(KEY_BLOCK_ON_LINE, REDACTED_LINE);
  const begin = KEY_BEGIN.exec(closed);
  if (begin) {
    const before = closed.slice(0, begin.index);
    return { text: `${prefix}${before ? redactLine(before) : ""}${REDACTED_LINE}`, open: true };
  }
  if (prefix === "" && closed === rest) {
    return { text: redactLine(rest), open: false };
  }
  return { text: `${prefix}${closed ? redactLine(closed) : ""}`, open: false };
}

/** A batch of recovery log lines as stored, and whether it ends inside a key block. */
export interface RecoveryLogBatch {
  lines: string[];
  inKeyBlock: boolean;
}

/**
 * The lines of a recovery log as they are stored (docs/BAREMETAL.md 9.8): without escape sequences
 * and control characters (a tab becomes a space), each redacted. Key material spans lines: from a
 * BEGIN line to its END line every line is masked, also across batches (`inKeyBlock` is where the
 * previous batch of the session ended).
 */
export function redactRecoveryLogBatch(
  lines: readonly string[],
  inKeyBlock = false,
): RecoveryLogBatch {
  let open = inKeyBlock;
  const out: string[] = [];
  for (const line of lines) {
    const cleaned = stripAnsi(line).replace(/\t/g, " ").replace(LINE_CONTROLS, "");
    const step = redactRecoveryLine(cleaned, open);
    out.push(step.text);
    open = step.open;
  }
  return { lines: out, inKeyBlock: open };
}

/** {@link redactRecoveryLogBatch} for lines that start outside a key block. */
export function redactRecoveryLogLines(lines: readonly string[]): string[] {
  return redactRecoveryLogBatch(lines).lines;
}

/** One error message of an agent without credentials, on one line, at most `maxLength` characters. */
export function redactAgentMessage(text: string, maxLength: number): string {
  return redactSensitiveText(text, maxLength);
}
