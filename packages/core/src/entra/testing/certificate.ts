import { type KeyObject, generateKeyPairSync, randomBytes, sign } from "node:crypto";

/**
 * Self-signed X.509 certificates for tests, built in memory: node:crypto can
 * parse certificates but not create them, and no key material may live in the
 * repository. A minimal DER encoder assembles the TBSCertificate, which is
 * signed with a freshly generated key (sha256WithRSAEncryption, or ECDSA for
 * the unsupported-key case).
 */

function length(size: number): Buffer {
  if (size < 0x80) {
    return Buffer.from([size]);
  }
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest >>= 8) {
    bytes.unshift(rest & 0xff);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

const sequence = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));

function integer(value: Buffer): Buffer {
  const first = value[0] ?? 0;
  return tlv(0x02, first & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
}

function oid(dotted: string): Buffer {
  const [a = 0, b = 0, ...rest] = dotted.split(".").map(Number);
  const bytes: number[] = [40 * a + b];
  for (const part of rest) {
    const chunk: number[] = [part & 0x7f];
    for (let value = part >> 7; value > 0; value >>= 7) {
      chunk.unshift((value & 0x7f) | 0x80);
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const year = date.getUTCFullYear();
  // UTCTime for 1950..2049, GeneralizedTime otherwise (RFC 5280, 4.1.2.5).
  return year >= 1950 && year < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, "ascii"))
    : tlv(0x18, Buffer.from(`${iso}Z`, "ascii"));
}

function name(commonName: string): Buffer {
  return sequence(set(sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(commonName, "utf8")))));
}

const SHA256_WITH_RSA = sequence(oid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00]));
const ECDSA_WITH_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));

export interface TestCertificate {
  /** The private key, PKCS#8 PEM. */
  keyPem: string;
  certificatePem: string;
  /** Key and certificate in one PEM, as an admin uploads it. */
  combinedPem: string;
  privateKey: KeyObject;
}

export interface TestCertificateOptions {
  commonName?: string;
  notBefore?: Date;
  notAfter?: Date;
  keyType?: "rsa" | "ec";
}

function toPem(label: string, der: Buffer): string {
  const body =
    der
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** A self-signed certificate with its private key. */
export function createTestCertificate(options: TestCertificateOptions = {}): TestCertificate {
  const keyType = options.keyType ?? "rsa";
  const { privateKey, publicKey } =
    keyType === "rsa"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const notBefore = options.notBefore ?? new Date(Date.now() - 60 * 60 * 1000);
  const notAfter = options.notAfter ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const subject = name(options.commonName ?? "Restow Test");
  const algorithm = keyType === "rsa" ? SHA256_WITH_RSA : ECDSA_WITH_SHA256;

  // A positive serial in minimal DER form: no leading zero byte, top bit clear.
  const serial = randomBytes(8);
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x01;

  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    subject,
    sequence(time(notBefore), time(notAfter)),
    subject,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("sha256", tbs, privateKey);
  const certificate = sequence(
    tbs,
    algorithm,
    tlv(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );

  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const certificatePem = toPem("CERTIFICATE", certificate);
  return { keyPem, certificatePem, combinedPem: `${keyPem}${certificatePem}`, privateKey };
}
