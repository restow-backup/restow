import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createLicenseSigner, installLicenseKey } from "./license.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** A stand-in for the api: the license state before, and what a posted key turns it into. */
function fakeApi({ installationId = "inst-123", answer } = {}) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push(["GET", path]);
      return { edition: "community", source: "environment", installationId };
    },
    async post(path, body) {
      calls.push(["POST", path, body]);
      return answer ?? { edition: "service_provider", source: "key", installationId };
    },
  };
}

test("each run gets its own throwaway signer with a raw base64url public key", async () => {
  const first = await createLicenseSigner(repoRoot);
  const second = await createLicenseSigner(repoRoot);
  assert.match(first.publicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.publicKey, second.publicKey);
});

test("the key installed is a Service Provider key for this installation, signed by the run's key", async () => {
  const signer = await createLicenseSigner(repoRoot);
  const api = fakeApi();
  const state = await installLicenseKey(api, signer);
  assert.equal(state.edition, "service_provider");
  assert.deepEqual(
    api.calls.map(([method, path]) => `${method} ${path}`),
    ["GET /api/v1/license", "POST /api/v1/license"],
  );
  const key = api.calls[1][2].key;
  const [prefix, payload, signature] = key.split(".");
  assert.equal(prefix, "restow-license-v1");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  assert.equal(claims.edition, "service_provider");
  assert.equal(claims.installation_id, "inst-123");
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: signer.publicKey },
    format: "jwk",
  });
  assert.ok(
    verify(
      null,
      Buffer.from(`${prefix}.${payload}`, "ascii"),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
  );
});

test("an installation without an id, or a key the api does not take, fails the step", async () => {
  const signer = await createLicenseSigner(repoRoot);
  await assert.rejects(
    installLicenseKey(fakeApi({ installationId: null }), signer),
    /no installation id/,
  );
  await assert.rejects(
    installLicenseKey(fakeApi({ answer: { edition: "community", source: "environment" } }), signer),
    /reports the edition community from environment/,
  );
});
