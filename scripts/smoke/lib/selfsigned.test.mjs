import assert from "node:assert/strict";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { test } from "node:test";
import { createSelfSignedCertificate } from "./selfsigned.mjs";

test("the certificate parses, names its hosts and belongs to its key", () => {
  const { certPem, keyPem } = createSelfSignedCertificate({
    commonName: "archive.smoke.test",
    dnsNames: ["archive.smoke.test", "mail.smoke.test"],
  });
  const certificate = new X509Certificate(certPem);
  assert.equal(certificate.subject, "CN=archive.smoke.test");
  assert.equal(certificate.issuer, "CN=archive.smoke.test");
  assert.equal(certificate.subjectAltName, "DNS:archive.smoke.test, DNS:mail.smoke.test");
  assert.equal(certificate.checkHost("archive.smoke.test"), "archive.smoke.test");
  assert.equal(certificate.checkHost("mail.smoke.test"), "mail.smoke.test");
  assert.equal(certificate.checkHost("other.smoke.test"), undefined);
  assert.equal(certificate.checkPrivateKey(createPrivateKey(keyPem)), true);
  assert.equal(certificate.verify(certificate.publicKey), true);
  assert.match(certPem, /^-----BEGIN CERTIFICATE-----\n/u);
  assert.match(keyPem, /^-----BEGIN PRIVATE KEY-----\n/u);
});

test("two certificates never share a key", () => {
  const first = createSelfSignedCertificate();
  const second = createSelfSignedCertificate();
  assert.notEqual(first.keyPem, second.keyPem);
  assert.equal(
    new X509Certificate(first.certPem).checkPrivateKey(createPrivateKey(second.keyPem)),
    false,
  );
});

test("the validity window is the one asked for, in UTCTime and in GeneralizedTime", () => {
  const past = createSelfSignedCertificate({
    notBefore: new Date("2020-01-01T00:00:00Z"),
    notAfter: new Date("2020-01-02T00:00:00Z"),
  });
  const expired = new X509Certificate(past.certPem);
  assert.equal(new Date(expired.validFrom).toISOString(), "2020-01-01T00:00:00.000Z");
  assert.equal(new Date(expired.validTo).toISOString(), "2020-01-02T00:00:00.000Z");

  const far = createSelfSignedCertificate({
    notBefore: new Date("2049-12-31T00:00:00Z"),
    notAfter: new Date("2051-01-01T00:00:00Z"),
  });
  const future = new X509Certificate(far.certPem);
  assert.equal(new Date(future.validFrom).toISOString(), "2049-12-31T00:00:00.000Z");
  assert.equal(new Date(future.validTo).toISOString(), "2051-01-01T00:00:00.000Z");
});

test("by default it is valid now for about a week", () => {
  const certificate = new X509Certificate(createSelfSignedCertificate().certPem);
  const now = Date.now();
  assert.ok(new Date(certificate.validFrom).getTime() < now);
  assert.ok(new Date(certificate.validTo).getTime() > now + 6 * 24 * 60 * 60 * 1000);
});
