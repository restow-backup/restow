/**
 * A throwaway self-signed X.509 certificate, written with nothing but node:crypto
 * (Node has no certificate generator and the smoke must not depend on an openssl
 * binary on the host). Used by the release smoke for the journal receiver's TLS
 * (the stack's certificate, which the smoke's SMTP client then trusts) and by the
 * receiver's own tests, where the validity dates are chosen freely to get expired
 * and not-yet-valid certificates.
 *
 * The certificate is an ECDSA P-256 / SHA-256 leaf that signs itself, with a
 * subject alternative name per host name so clients verify the name properly.
 * Never use it for anything but a test: the key is generated for the caller and
 * has no protection of its own.
 */
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

function derLength(length) {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const SEQUENCE = 0x30;
const SET = 0x31;
const OCTET_STRING = 0x04;
const BIT_STRING = 0x03;
const INTEGER = 0x02;
const BOOLEAN = 0x01;
const UTF8_STRING = 0x0c;
const UTC_TIME = 0x17;
const GENERALIZED_TIME = 0x18;

// Object identifiers, already in DER (tag and length included).
const OID_ECDSA_WITH_SHA256 = Buffer.from("06082a8648ce3d040302", "hex");
const OID_COMMON_NAME = Buffer.from("0603550403", "hex");
const OID_BASIC_CONSTRAINTS = Buffer.from("0603551d13", "hex");
const OID_SUBJECT_ALT_NAME = Buffer.from("0603551d11", "hex");

function time(date) {
  const iso = date.toISOString(); // 2026-09-30T20:35:00.000Z
  const digits = iso.replace(/[-:T]/gu, "").slice(0, 14);
  const year = date.getUTCFullYear();
  return year >= 1950 && year < 2050
    ? der(UTC_TIME, Buffer.from(`${digits.slice(2)}Z`, "ascii"))
    : der(GENERALIZED_TIME, Buffer.from(`${digits}Z`, "ascii"));
}

function name(commonName) {
  return der(
    SEQUENCE,
    der(SET, der(SEQUENCE, OID_COMMON_NAME, der(UTF8_STRING, Buffer.from(commonName, "utf8")))),
  );
}

function extensions(dnsNames) {
  const basicConstraints = der(
    SEQUENCE,
    OID_BASIC_CONSTRAINTS,
    der(BOOLEAN, Buffer.from([0xff])), // critical
    der(OCTET_STRING, der(SEQUENCE, der(BOOLEAN, Buffer.from([0xff])))), // cA: TRUE
  );
  const names = dnsNames.map((dns) => der(0x82, Buffer.from(dns, "ascii")));
  const subjectAltName = der(
    SEQUENCE,
    OID_SUBJECT_ALT_NAME,
    der(OCTET_STRING, der(SEQUENCE, ...names)),
  );
  return der(0xa3, der(SEQUENCE, basicConstraints, subjectAltName));
}

function pem(label, bytes) {
  const lines = bytes.toString("base64").match(/.{1,64}/gu) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * @typedef {object} SelfSignedOptions
 * @property {string} [commonName]   subject CN (default "localhost")
 * @property {string[]} [dnsNames]   subject alternative names (default: the common name)
 * @property {Date} [notBefore]      default: one hour ago
 * @property {Date} [notAfter]       default: in seven days
 */

/**
 * @param {SelfSignedOptions} [options]
 * @returns {{ certPem: string, keyPem: string }}
 */
export function createSelfSignedCertificate(options = {}) {
  const commonName = options.commonName ?? "localhost";
  const dnsNames = options.dnsNames ?? [commonName];
  const now = Date.now();
  const notBefore = options.notBefore ?? new Date(now - 60 * 60 * 1000);
  const notAfter = options.notAfter ?? new Date(now + 7 * 24 * 60 * 60 * 1000);

  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const serial = randomBytes(16);
  serial[0] = serial[0] & 0x7f || 1; // positive, and the DER integer stays minimal

  const signatureAlgorithm = der(SEQUENCE, OID_ECDSA_WITH_SHA256);
  const tbsCertificate = der(
    SEQUENCE,
    der(0xa0, der(INTEGER, Buffer.from([0x02]))), // version 3
    der(INTEGER, serial),
    signatureAlgorithm,
    name(commonName), // issuer: the certificate signs itself
    der(SEQUENCE, time(notBefore), time(notAfter)),
    name(commonName), // subject
    publicKey.export({ type: "spki", format: "der" }),
    extensions(dnsNames),
  );
  const signature = sign("sha256", tbsCertificate, privateKey);
  const certificate = der(
    SEQUENCE,
    tbsCertificate,
    signatureAlgorithm,
    der(BIT_STRING, Buffer.concat([Buffer.from([0x00]), signature])),
  );
  return {
    certPem: pem("CERTIFICATE", certificate),
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
