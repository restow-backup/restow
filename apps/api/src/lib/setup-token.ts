import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { ProblemError } from "../problem.js";

/**
 * The one-time setup token: proof that whoever completes the setup wizard
 * operates the server, not just its address.
 *
 * Until the first administrator exists, the setup routes are public by
 * nature. Without a secret, the first caller of `POST /api/v1/setup` would
 * become the owner: a page the operator happens to visit (cross-site, or by
 * DNS rebinding in local mode), or anyone who finds a public installation
 * through the certificate-transparency logs before the operator gets to it.
 * So completing the setup requires this token, which only someone with
 * access to the server can read:
 *
 *   - generated at random when the api starts on an installation that is not
 *     set up, and written to the api's own log in a clearly marked block
 *     (`docker compose logs api`); a restart issues a new one;
 *   - or taken from `RESTOW_SETUP_TOKEN` when the operator sets it (then it is
 *     never written to the log);
 *   - sent by the wizard as `X-Restow-Setup-Token`, and dropped from memory
 *     as soon as the setup is complete. The setup routes answer 409 for good
 *     after that anyway.
 *
 * Twenty characters from a 30-letter alphabet are close to 100 bits: guessing
 * is hopeless, so a wrong token is not rate-limited (a limiter keyed on the
 * client address would only let an attacker lock the operator out).
 *
 * The public demo (RESTOW_DEMO) has no setup token: its seed process
 * completes the setup with its own seed token (lib/demo.ts).
 */

/** The request header that carries the token. */
export const SETUP_TOKEN_HEADER = "x-restow-setup-token";

/** Problem type of a setup request without the right token. */
export const SETUP_TOKEN_PROBLEM = "urn:restow:problem:setup-token-invalid";

/** No 0/O, 1/I/L or U: a token is read off a terminal and typed in. */
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const GROUPS = 4;
const GROUP_LENGTH = 5;

/** The shortest `RESTOW_SETUP_TOKEN` accepted, counted after normalization. */
export const MIN_SETUP_TOKEN_LENGTH = 16;

export type SetupTokenSource = "log" | "environment";

/** A new random token, e.g. `K7PQX-3MZRA-T9WHE-2BNCV`. */
export function generateSetupToken(): string {
  const groups: string[] = [];
  for (let group = 0; group < GROUPS; group++) {
    let text = "";
    for (let index = 0; index < GROUP_LENGTH; index++) {
      text += ALPHABET[randomInt(ALPHABET.length)];
    }
    groups.push(text);
  }
  return groups.join("-");
}

/** Case, spaces and dashes do not matter: what the operator copies is what counts. */
export function normalizeSetupToken(value: string): string {
  return value.replace(/[\s-]+/g, "").toUpperCase();
}

/**
 * Why a configured `RESTOW_SETUP_TOKEN` cannot be used, or null when it can
 * (or is not set). server.ts refuses to start while this is non-null.
 */
export function setupTokenConfigProblem(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  if (normalizeSetupToken(value).length < MIN_SETUP_TOKEN_LENGTH) {
    return `RESTOW_SETUP_TOKEN must have at least ${MIN_SETUP_TOKEN_LENGTH} characters (spaces and dashes not counted). Generate one with: openssl rand -hex 16`;
  }
  return null;
}

interface SetupTokenState {
  /** Normalized. */
  token: string;
  /** As shown to the operator. */
  display: string;
  source: SetupTokenSource;
}

let current: SetupTokenState | null = null;
let completed = false;

/** The digest compared in constant time, so the length of a guess reveals nothing. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * The token of this process: `RESTOW_SETUP_TOKEN` when set, else a random
 * one, created on first use. Null once the setup is complete.
 */
export function currentSetupToken(configured: string | undefined): SetupTokenState | null {
  if (completed) {
    return null;
  }
  if (current === null) {
    if (configured !== undefined) {
      current = { token: normalizeSetupToken(configured), display: "", source: "environment" };
    } else {
      const display = generateSetupToken();
      current = { token: normalizeSetupToken(display), display, source: "log" };
    }
  }
  return current;
}

/** Whether `provided` is the token of this process. */
export function setupTokenMatches(
  provided: string | undefined,
  configured: string | undefined,
): boolean {
  const state = currentSetupToken(configured);
  if (state === null || provided === undefined) {
    return false;
  }
  const candidate = normalizeSetupToken(provided);
  return candidate.length > 0 && timingSafeEqual(digest(candidate), digest(state.token));
}

/** The setup is complete: the token is gone for the rest of this process. */
export function retireSetupToken(): void {
  current = null;
  completed = true;
}

/** Tests only: forget the token and the completion, as a fresh process would. */
export function resetSetupTokenForTests(): void {
  current = null;
  completed = false;
}

export function setupTokenProblem(): ProblemError {
  return new ProblemError(403, "Setup token required", {
    type: SETUP_TOKEN_PROBLEM,
    detail:
      "Enter the setup token of this installation. The api prints it to its log when it starts (docker compose logs api), unless RESTOW_SETUP_TOKEN is set.",
  });
}

/**
 * The lines the api writes to its log while the installation is not set up:
 * the token in a block that stands out, or where to find it instead.
 */
export function setupTokenAnnouncement(
  state: Pick<SetupTokenState, "display" | "source">,
  productName: string,
): string[] {
  const rule = "=".repeat(64);
  if (state.source === "environment") {
    return [
      rule,
      `${productName} is not set up yet. The setup wizard asks for the setup token:`,
      "use the value of RESTOW_SETUP_TOKEN from this server's environment.",
      rule,
    ];
  }
  return [
    rule,
    `${productName} is not set up yet. Open the web interface and enter this`,
    "setup token in the first step of the setup wizard:",
    "",
    `    SETUP TOKEN: ${state.display}`,
    "",
    "It is valid until the setup is complete. A restart of the api issues a new",
    "token; use the one printed last.",
    rule,
  ];
}
