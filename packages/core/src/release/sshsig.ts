/**
 * The maintainer's release signature, checked on the server (docs/BAREMETAL.md 8.5, 26.13).
 *
 * The same check the agent does before it installs anything (agent/internal/release/sshsig.go)
 * and `scripts/release/verify-agent-signature.sh` does with `ssh-keygen -Y verify`: an armored
 * OpenSSH signature (SSHSIG, PROTOCOL.sshsig) over the exact bytes of a `SHA256SUMS` file, made
 * with the Ed25519 release key in the namespace `restow-agent-release`. The key is the one the
 * instance ships for its install scripts (`release-signing.pub`, read by `readReleaseKey`); there
 * is no other trust root, and nothing here ever takes a key from the network or the database.
 */
import { createHash, createPublicKey, type KeyObject, sign, verify } from "node:crypto";

/** The SSHSIG namespace of release signatures; a signature for anything else does not verify. */
export const RELEASE_SIGNATURE_NAMESPACE = "restow-agent-release";

const MAGIC = Buffer.from("SSHSIG");
const KEY_TYPE = "ssh-ed25519";
const ARMOR_BEGIN = "-----BEGIN SSH SIGNATURE-----";
const ARMOR_END = "-----END SSH SIGNATURE-----";
/** What is read as a signature file at most (as the agent). */
export const MAX_SIGNATURE_BYTES = 16 * 1024;

export type ReleaseSignatureProblem =
  /** No usable release key (the placeholder of a development build). */
  | "no_key"
  /** Not an armored SSH signature, or malformed inside. */
  | "malformed"
  /** Made with another key than the release key. */
  | "other_key"
  /** Made for another namespace than agent releases. */
  | "other_namespace"
  /** The bytes or the signature were changed. */
  | "mismatch";

export type ReleaseSignatureResult = { ok: true } | { ok: false; problem: ReleaseSignatureProblem };

interface ParsedKey {
  blob: Buffer;
  key: KeyObject;
}

function putString(parts: Buffer[], value: Buffer): void {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  parts.push(length, value);
}

/** Reads SSH wire format strings (uint32 length, bytes). */
class WireReader {
  failed = false;
  constructor(private rest: Buffer) {}

  string(): Buffer {
    if (this.failed || this.rest.length < 4) {
      this.failed = true;
      return Buffer.alloc(0);
    }
    const length = this.rest.readUInt32BE(0);
    if (length > this.rest.length - 4) {
      this.failed = true;
      return Buffer.alloc(0);
    }
    const value = this.rest.subarray(4, 4 + length);
    this.rest = this.rest.subarray(4 + length);
    return value;
  }

  uint32(): number {
    if (this.failed || this.rest.length < 4) {
      this.failed = true;
      return 0;
    }
    const value = this.rest.readUInt32BE(0);
    this.rest = this.rest.subarray(4);
    return value;
  }

  get remaining(): number {
    return this.rest.length;
  }
}

function ed25519Key(raw: Buffer): KeyObject {
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

/** The key of an OpenSSH line `ssh-ed25519 <base64> [comment]`, or null. */
function parseKeyLine(line: string): ParsedKey | null {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 2 || fields[0] !== KEY_TYPE) {
    return null;
  }
  const blob = Buffer.from(fields[1] as string, "base64");
  const reader = new WireReader(blob);
  const type = reader.string();
  const raw = reader.string();
  if (
    reader.failed ||
    reader.remaining !== 0 ||
    type.toString() !== KEY_TYPE ||
    raw.length !== 32
  ) {
    return null;
  }
  try {
    return { blob, key: ed25519Key(raw) };
  } catch {
    return null;
  }
}

/** The SHA256 fingerprint of a key line as `ssh-keygen -l` prints it, or null. */
export function releaseSignatureKeyFingerprint(keyLine: string): string | null {
  const parsed = parseKeyLine(keyLine);
  if (!parsed) {
    return null;
  }
  return `SHA256:${createHash("sha256").update(parsed.blob).digest("base64").replace(/=+$/, "")}`;
}

function dearmor(armored: Buffer | string): Buffer | null {
  const text = (typeof armored === "string" ? armored : armored.toString("utf8"))
    .replaceAll("\r", "")
    .trim();
  if (!text.startsWith(ARMOR_BEGIN) || !text.endsWith(ARMOR_END)) {
    return null;
  }
  const body = text.slice(ARMOR_BEGIN.length, text.length - ARMOR_END.length).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) {
    return null;
  }
  return Buffer.from(body, "base64");
}

/** The byte string an SSHSIG signature covers (PROTOCOL.sshsig). */
function signedData(digest: Buffer, hashAlgorithm: string, reserved: Buffer): Buffer {
  const parts: Buffer[] = [MAGIC];
  putString(parts, Buffer.from(RELEASE_SIGNATURE_NAMESPACE));
  putString(parts, reserved);
  putString(parts, Buffer.from(hashAlgorithm));
  putString(parts, digest);
  return Buffer.concat(parts);
}

/**
 * Whether `armored` is the maintainer's signature over exactly `message`, made with `keyLine`
 * (the release key) for agent releases. Like the agent: SHA-512 or SHA-256, Ed25519 only.
 */
export function verifyReleaseSignature(
  message: Buffer | string,
  armored: Buffer | string,
  keyLine: string,
): ReleaseSignatureResult {
  const key = keyLine ? parseKeyLine(keyLine) : null;
  if (!key) {
    return { ok: false, problem: "no_key" };
  }
  if (Buffer.byteLength(armored) > MAX_SIGNATURE_BYTES) {
    return { ok: false, problem: "malformed" };
  }
  const blob = dearmor(armored);
  if (!blob || blob.length < MAGIC.length || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    return { ok: false, problem: "malformed" };
  }
  const reader = new WireReader(blob.subarray(MAGIC.length));
  const version = reader.uint32();
  const publicKey = reader.string();
  const namespace = reader.string();
  const reserved = reader.string();
  const hashAlgorithm = reader.string().toString();
  const signatureBlob = reader.string();
  if (reader.failed || reader.remaining !== 0 || version !== 1) {
    return { ok: false, problem: "malformed" };
  }
  if (!publicKey.equals(key.blob)) {
    return { ok: false, problem: "other_key" };
  }
  if (namespace.toString() !== RELEASE_SIGNATURE_NAMESPACE) {
    return { ok: false, problem: "other_namespace" };
  }
  if (hashAlgorithm !== "sha512" && hashAlgorithm !== "sha256") {
    return { ok: false, problem: "malformed" };
  }
  const signatureReader = new WireReader(signatureBlob);
  const signatureType = signatureReader.string().toString();
  const raw = signatureReader.string();
  if (
    signatureReader.failed ||
    signatureReader.remaining !== 0 ||
    signatureType !== KEY_TYPE ||
    raw.length !== 64
  ) {
    return { ok: false, problem: "malformed" };
  }
  const digest = createHash(hashAlgorithm).update(message).digest();
  const valid = verify(null, signedData(digest, hashAlgorithm, reserved), key.key, raw);
  return valid ? { ok: true } : { ok: false, problem: "mismatch" };
}

/**
 * An armored SSHSIG signature (SHA-512) over `message`, as `ssh-keygen -Y sign -n
 * restow-agent-release` writes it. The server never signs anything; this is for tests and test
 * tools with a throwaway key.
 */
export function signReleaseForTests(privateKey: KeyObject, message: Buffer | string): string {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  const raw = Buffer.from(String(jwk.x), "base64url");
  const keyParts: Buffer[] = [];
  putString(keyParts, Buffer.from(KEY_TYPE));
  putString(keyParts, raw);
  const digest = createHash("sha512").update(message).digest();
  const signature = sign(null, signedData(digest, "sha512", Buffer.alloc(0)), privateKey);
  const signatureParts: Buffer[] = [];
  putString(signatureParts, Buffer.from(KEY_TYPE));
  putString(signatureParts, signature);
  const parts: Buffer[] = [MAGIC, Buffer.from([0, 0, 0, 1])];
  putString(parts, Buffer.concat(keyParts));
  putString(parts, Buffer.from(RELEASE_SIGNATURE_NAMESPACE));
  putString(parts, Buffer.alloc(0));
  putString(parts, Buffer.from("sha512"));
  putString(parts, Buffer.concat(signatureParts));
  const encoded = Buffer.concat(parts).toString("base64");
  const lines = encoded.match(/.{1,70}/g) ?? [];
  return `${ARMOR_BEGIN}\n${lines.join("\n")}\n${ARMOR_END}\n`;
}

/** The OpenSSH public key line of a throwaway Ed25519 key (tests). */
export function releaseKeyLineForTests(
  privateKey: KeyObject,
  comment = "restow-test-only",
): string {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  const raw = Buffer.from(String(jwk.x), "base64url");
  const parts: Buffer[] = [];
  putString(parts, Buffer.from(KEY_TYPE));
  putString(parts, raw);
  return `${KEY_TYPE} ${Buffer.concat(parts).toString("base64")} ${comment}`;
}
