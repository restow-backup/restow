/**
 * What the lab reads on the serial consoles of a probe (docs/BAREMETAL.md 12.3). The lab only
 * steers by it (cut the network, type the passphrase, stop waiting); the server rates the boot
 * from the console text the lab hands in (@restow/core `classifyProbeSerial`).
 */
import { createHash } from "node:crypto";

/** `recover` ended its access to the repository: the lab takes the network away. */
export const RELEASED_LINE = /RESTOW-PROBE phase=released/;

/** The line recover writes when an attempt fails; systemd starts it again (Restart=on-failure). */
export const FAILED_LINE = /^RESTOW-RECOVER-RESULT failed\s*$/gm;

/** Failed attempts after which the lab stops the restore: the code is spent after the first. */
export const MAX_RECOVER_FAILURES = 3;

/** How many attempts of recover failed on `text`. */
export function recoverFailures(text: string): number {
  return (text.match(FAILED_LINE) ?? []).length;
}

/** The console up to the end of the first failed attempt of recover (where its reason stands). */
export function firstFailure(text: string): string | null {
  const match = /^RESTOW-RECOVER-RESULT failed\s*$/m.exec(text);
  return match ? text.slice(0, match.index + match[0].length) : null;
}

/** The restored system reached multi-user.target (restow-probe.service). */
export const OK_LINE = /RESTOW-PROBE-OK [0-9a-f-]{32,36} \S{1,128}/;

/**
 * The passphrase prompts of an encrypted root on the serial console, Plymouth off: systemd's
 * cryptsetup and dracut ("Please enter passphrase for disk ..."), cryptsetup itself ("Enter
 * passphrase for ..."), initramfs-tools of Debian and Ubuntu ("Please unlock disk ...").
 */
export const PASSPHRASE_PROMPT =
  /Please enter passphrase for disk|Enter passphrase for |Please enter passphrase|Please unlock disk /g;

/** How many passphrase prompts the console shows. */
export function passphrasePrompts(text: string): number {
  return text.match(PASSPHRASE_PROMPT)?.length ?? 0;
}

/** At most this many passphrases are typed at the serial console (a wrong one asks again). */
export const MAX_PASSPHRASE_TRIES = 3;

/**
 * GRUB asks for the passphrase of an encrypted /boot only on the screen: when the console of the
 * restored disks stays silent this long (the kernel prints on ttyS0 within seconds otherwise), the
 * lab types the passphrase once on the keyboard.
 */
export const GRUB_SILENCE_MS = 45_000;

/**
 * The finish recover writes to the console once the probe released its access (the network is
 * cut, the session cannot hear it): `RESTOW-PROBE-FINISH-BEGIN <bytes> <sha256>`, the JSON in
 * base64 in lines of at most 76 characters, `RESTOW-PROBE-FINISH-END`. The lab hands it to the
 * worker, which stores it with the server's rules.
 */
export const FINISH_BEGIN = "RESTOW-PROBE-FINISH-BEGIN";
export const FINISH_END = "RESTOW-PROBE-FINISH-END";
const FINISH_BEGIN_LINE = /^RESTOW-PROBE-FINISH-BEGIN (\d{1,9}) ([0-9a-f]{64})$/;

/** The largest finish the lab takes (its JSON; recover keeps within it, so does the worker). */
export const MAX_FINISH_BYTES = 160 * 1024;

export type ProbeFinishBlock =
  | { ok: true; finish: Record<string, unknown>; bytes: number }
  | { ok: false; reason: "missing" | "incomplete" | "too_large" | "invalid" | "mismatch" };

function consoleLines(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/\r/g, "").trim());
}

/**
 * The last complete finish block of a console (BEGIN with its END after it): its length and
 * SHA-256 must match, its JSON parse to an object of at most {@link MAX_FINISH_BYTES}. Anything else
 * is no finish, with the reason.
 */
export function probeFinishOf(text: string): ProbeFinishBlock {
  const lines = consoleLines(text);
  let sawBegin = false;
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (line === FINISH_END) {
      end = i;
      continue;
    }
    const head = FINISH_BEGIN_LINE.exec(line);
    if (!head) {
      if (line.startsWith(FINISH_BEGIN)) sawBegin = true;
      continue;
    }
    sawBegin = true;
    if (end < 0) continue;
    const bytes = Number(head[1]);
    if (bytes > MAX_FINISH_BYTES) return { ok: false, reason: "too_large" };
    const body = lines.slice(i + 1, end);
    const encoded = body.join("");
    if (
      body.some((part) => part.length > 76) ||
      encoded.length !== Math.ceil(bytes / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    ) {
      return { ok: false, reason: "invalid" };
    }
    const payload = Buffer.from(encoded, "base64");
    if (
      payload.length !== bytes ||
      createHash("sha256").update(payload).digest("hex") !== head[2]
    ) {
      return { ok: false, reason: "mismatch" };
    }
    try {
      const finish: unknown = JSON.parse(payload.toString("utf8"));
      if (finish === null || typeof finish !== "object" || Array.isArray(finish)) {
        return { ok: false, reason: "invalid" };
      }
      return { ok: true, finish: finish as Record<string, unknown>, bytes };
    } catch {
      return { ok: false, reason: "invalid" };
    }
  }
  return { ok: false, reason: sawBegin ? "incomplete" : "missing" };
}

/**
 * The console without the bodies of its finish blocks (base64 that would fill the tail the
 * worker keeps): each block becomes its BEGIN line with a note.
 */
export function withoutFinishBlocks(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r/g, "").trim();
    if (line.startsWith(FINISH_BEGIN)) {
      inBlock = true;
      out.push(`${line.slice(0, 120)} (relayed to the server, body left out)`);
      continue;
    }
    if (inBlock && line === FINISH_END) {
      inBlock = false;
      continue;
    }
    // A block cut short ends at the first line that is no base64.
    if (inBlock && /^[A-Za-z0-9+/=]{1,76}$/.test(line)) continue;
    inBlock = false;
    out.push(raw);
  }
  return out.join("\n");
}
