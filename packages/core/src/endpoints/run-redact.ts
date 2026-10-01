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

/** One error message of an agent without credentials, on one line, at most `maxLength` characters. */
export function redactAgentMessage(text: string, maxLength: number): string {
  return redactSensitiveText(text, maxLength);
}
