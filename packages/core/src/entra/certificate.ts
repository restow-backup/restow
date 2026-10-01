import { X509Certificate, createHash, createPrivateKey } from "node:crypto";
import { derFromPem } from "../graph/auth/token.js";

/**
 * The certificate credential of the backup app (docs/ENTRA-SETUP.md, part 3):
 * one PEM text holding the private key and the X.509 certificate whose public
 * part was uploaded to the app registration. Parsed with node:crypto only.
 *
 * Nothing here returns or reports key material: problems are named by a
 * reason, the certificate by its thumbprint, subject and validity.
 */

/** An unencrypted private key block (PKCS#8, or PKCS#1 / SEC 1). */
export const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC )?PRIVATE KEY-----/;
/** An X.509 certificate block. */
export const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;
const ENCRYPTED_KEY_BLOCK = /-----BEGIN ENCRYPTED PRIVATE KEY-----/;

/** Clock skew tolerated for a certificate created a moment ago on another machine. */
const NOT_BEFORE_TOLERANCE_MS = 5 * 60 * 1000;

/** What an operator needs to recognise a certificate in the Entra portal. */
export interface CertificateInfo {
  /** SHA-1 thumbprint, upper-case hex, as the Entra portal lists it. */
  thumbprint: string;
  subject: string;
  /** ISO 8601. */
  notBefore: string;
  /** ISO 8601. */
  notAfter: string;
}

/** Why a PEM cannot serve as the app's certificate credential. */
export type CertificateProblem =
  | "certificate_missing"
  | "private_key_missing"
  | "private_key_encrypted"
  | "certificate_invalid"
  | "private_key_invalid"
  | "unsupported_key_type"
  | "key_mismatch"
  | "expired"
  | "not_yet_valid";

export type CertificateInspection =
  | { ok: true; privateKeyPem: string; certificatePem: string; info: CertificateInfo }
  | { ok: false; problem: CertificateProblem };

function iso(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function infoOf(certificate: X509Certificate, certificatePem: string): CertificateInfo {
  return {
    thumbprint: createHash("sha1").update(derFromPem(certificatePem)).digest("hex").toUpperCase(),
    subject: certificate.subject.replace(/\n/g, ", "),
    notBefore: iso(certificate.validFrom),
    notAfter: iso(certificate.validTo),
  };
}

/**
 * The private key as PKCS#8 PEM (`BEGIN PRIVATE KEY`), which every consumer
 * (the client-assertion signer, msal) accepts; the input when it cannot be
 * re-encoded.
 */
export function normalizePrivateKeyPem(privateKeyPem: string): string {
  try {
    return createPrivateKey(privateKeyPem).export({ type: "pkcs8", format: "pem" }).toString();
  } catch {
    return privateKeyPem;
  }
}

/**
 * Validate a PEM an admin pasted or uploaded: it must hold an unencrypted RSA
 * private key (Entra client assertions are RS256) and the certificate that
 * belongs to it, and the certificate must be valid now.
 */
export function inspectCertificatePem(pem: string, now: Date = new Date()): CertificateInspection {
  if (ENCRYPTED_KEY_BLOCK.test(pem)) {
    return { ok: false, problem: "private_key_encrypted" };
  }
  const certificatePem = CERTIFICATE_BLOCK.exec(pem)?.[0];
  if (!certificatePem) {
    return { ok: false, problem: "certificate_missing" };
  }
  const rawKey = PRIVATE_KEY_BLOCK.exec(pem)?.[0];
  if (!rawKey) {
    return { ok: false, problem: "private_key_missing" };
  }

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    return { ok: false, problem: "certificate_invalid" };
  }
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(rawKey);
  } catch {
    return { ok: false, problem: "private_key_invalid" };
  }
  if (privateKey.asymmetricKeyType !== "rsa") {
    return { ok: false, problem: "unsupported_key_type" };
  }
  if (!certificate.checkPrivateKey(privateKey)) {
    return { ok: false, problem: "key_mismatch" };
  }

  const info = infoOf(certificate, certificatePem);
  if (Date.parse(info.notAfter) <= now.getTime()) {
    return { ok: false, problem: "expired" };
  }
  if (Date.parse(info.notBefore) > now.getTime() + NOT_BEFORE_TOLERANCE_MS) {
    return { ok: false, problem: "not_yet_valid" };
  }
  return {
    ok: true,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    certificatePem,
    info,
  };
}

/** Thumbprint, subject and validity of a PEM certificate; null when it cannot be parsed. */
export function describeCertificate(certificatePem: string): CertificateInfo | null {
  try {
    return infoOf(new X509Certificate(certificatePem), certificatePem);
  } catch {
    return null;
  }
}
