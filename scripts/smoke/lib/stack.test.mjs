import assert from "node:assert/strict";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JOURNAL_HOST, JOURNAL_TLS_MOUNT, Stack } from "./stack.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function envOf(stack) {
  return Object.fromEntries(
    readFileSync(join(stack.dir, ".env"), "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

function withStack(run, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "restow-smoke-stack-"));
  try {
    const stack = new Stack({
      repoRoot,
      dir,
      project: "restow-smoke-test",
      portBase: 38300,
      tag: "test",
      ...options,
    });
    stack.writeFiles();
    return run(stack, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the stack serves the journal receiver a real certificate for the journal host, not an opt-out", () => {
  withStack((stack, dir) => {
    const env = envOf(stack);
    assert.equal(env.JOURNAL_TLS_CERT_PATH, `${JOURNAL_TLS_MOUNT}/fullchain.pem`);
    assert.equal(env.JOURNAL_TLS_KEY_PATH, `${JOURNAL_TLS_MOUNT}/privkey.pem`);
    assert.equal(env.JOURNAL_TLS_DIR, join(dir, "journal-tls"));
    assert.equal(env.JOURNAL_ALLOW_INSECURE, undefined);

    const certPem = readFileSync(join(dir, "journal-tls/fullchain.pem"), "utf8");
    const keyPem = readFileSync(join(dir, "journal-tls/privkey.pem"), "utf8");
    const certificate = new X509Certificate(certPem);
    assert.equal(certificate.checkHost(JOURNAL_HOST), JOURNAL_HOST);
    assert.equal(certificate.checkPrivateKey(createPrivateKey(keyPem)), true);
    assert.ok(new Date(certificate.validTo).getTime() > Date.now() + 24 * 60 * 60 * 1000);
    assert.equal(certPem, stack.journalCertificate.certPem);
    // The key is private to the user that runs the smoke; the container reads it as root.
    assert.equal(statSync(join(dir, "journal-tls/privkey.pem")).mode & 0o077, 0);
  });
});

test("the release compose mounts that directory where the stack points the receiver", () => {
  const compose = readFileSync(join(repoRoot, "deploy/release/docker-compose.yml"), "utf8");
  assert.ok(
    compose.includes(`\${JOURNAL_TLS_DIR:-./journal-tls}:${JOURNAL_TLS_MOUNT}:ro`),
    "the api service mounts JOURNAL_TLS_DIR read-only",
  );
});

test("every stack gets a certificate of its own", () => {
  withStack((first) =>
    withStack((second) => {
      assert.notEqual(first.journalCertificate.keyPem, second.journalCertificate.keyPem);
    }),
  );
});

test("the stack names the updater's image, so the release compose file validates with its profile", () => {
  withStack((stack) => {
    assert.equal(envOf(stack).RESTOW_UPDATER_IMAGE, "restow-smoke/app:test");
  });
});

test("the stack sets no edition: licensed features come from a key, RESTOW_EDITION is demo only", () => {
  withStack((stack) => {
    const env = envOf(stack);
    assert.equal(env.RESTOW_EDITION, undefined);
    assert.equal(env.RESTOW_LICENSE_PUBLIC_KEY, undefined);
  });
  withStack(
    (stack) => {
      const env = envOf(stack);
      assert.equal(env.RESTOW_EDITION, undefined);
      assert.equal(env.RESTOW_LICENSE_PUBLIC_KEY, "test-public-key_base64url");
    },
    { licensePublicKey: "test-public-key_base64url" },
  );
});

test("the release compose hands the stack's .env, the verification key included, to the api", () => {
  const compose = readFileSync(join(repoRoot, "deploy/release/docker-compose.yml"), "utf8");
  assert.match(compose, /x-restow-app: &restow-app\n(?:.*\n)*?\s+env_file:\n\s+- \.env\n/);
  assert.match(compose, /\n {2}api:\n {4}<<: \*restow-app\n/);
});
