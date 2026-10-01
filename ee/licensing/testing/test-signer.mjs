/**
 * Test-only issuer of license keys: a throwaway Ed25519 key pair per call,
 * for the tests of ee/ and the release smoke (scripts/smoke). It signs the
 * documented `restow-license-v1` format (ee/licensing/src/token.ts) so the
 * product's verifier can be exercised end to end.
 *
 * Never part of a build: nothing under src/ of any app or module imports it,
 * the apps compile only what their loaders reach, and the image build checks
 * that no license signing code is shipped (docs/CI.md). The real issuer lives
 * in the private restow-license repository; its private key never enters this
 * repository.
 */
import { generateKeyPairSync, sign } from "node:crypto";

const PREFIX = "restow-license-v1";
const PAYLOAD_KEYS = [
  "edition",
  "mailbox_limit",
  "multi_tenant",
  "licensee",
  "installation_id",
  "issued_at",
];

/** base64url of the JSON text, members in the documented order. */
function encodePayload(payload) {
  const ordered = Object.fromEntries(PAYLOAD_KEYS.map((key) => [key, payload[key]]));
  return Buffer.from(JSON.stringify(ordered), "utf8").toString("base64url");
}

/** Sign an encoded payload (any text) into a token. */
function signEncoded(encoded, privateKey) {
  const signature = sign(null, Buffer.from(`${PREFIX}.${encoded}`, "ascii"), privateKey);
  return `${PREFIX}.${encoded}.${signature.toString("base64url")}`;
}

/**
 * A fresh signer. `publicKey` is the raw key, base64url: the value for
 * RESTOW_LICENSE_PUBLIC_KEY of the installation under test.
 */
export function createTestLicenseSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "jwk" }).x;
  return {
    publicKey: raw,
    publicKeyObject: publicKey,
    /** The payload a request stands for, exactly as an issued key carries it. */
    payload(request) {
      return {
        edition: request.edition,
        mailbox_limit: null,
        multi_tenant: request.edition === "service_provider",
        licensee: request.licensee,
        installation_id: request.installationId,
        issued_at: (request.issuedAt ?? new Date()).toISOString(),
      };
    },
    /** A signed key for an edition, a licensee and an installation id. */
    sign(request) {
      return signEncoded(encodePayload(this.payload(request)), privateKey);
    },
    /** A signed key over any payload object, valid or not (for the verifier's tests). */
    signPayload(payload) {
      return signEncoded(encodePayload(payload), privateKey);
    },
    /** A signed key over arbitrary payload text, bypassing every check. */
    signRaw(payloadText) {
      return signEncoded(Buffer.from(payloadText, "utf8").toString("base64url"), privateKey);
    },
  };
}
