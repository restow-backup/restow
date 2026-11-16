/**
 * The server's check of the release signature is the agent's (agent/internal/release/sshsig.go):
 * the fixtures are the agent's, made with the stock OpenSSH ssh-keygen (-Y sign), so both sides
 * accept and refuse the same files.
 */
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  releaseKeyLineForTests,
  releaseSignatureKeyFingerprint,
  signReleaseForTests,
  verifyReleaseSignature,
} from "./sshsig.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../agent/internal/release/testdata/${name}`, import.meta.url));
const KEY = fixture("test-key.pub").toString("utf8").trim();

describe("verifyReleaseSignature", () => {
  it("accepts ssh-keygen's signatures (SHA-512 and SHA-256) of the release namespace", () => {
    expect(verifyReleaseSignature(fixture("SHA256SUMS"), fixture("SHA256SUMS.sig"), KEY)).toEqual({
      ok: true,
    });
    expect(verifyReleaseSignature(fixture("sha256.txt"), fixture("sha256.txt.sig"), KEY)).toEqual({
      ok: true,
    });
  });

  it("refuses changed bytes, another namespace, another key, no key and garbage", () => {
    const sums = fixture("SHA256SUMS");
    const changed = Buffer.from(sums);
    changed[0] = changed[0] === 0x30 ? 0x31 : 0x30;
    expect(verifyReleaseSignature(changed, fixture("SHA256SUMS.sig"), KEY)).toEqual({
      ok: false,
      problem: "mismatch",
    });
    expect(
      verifyReleaseSignature(fixture("other-ns.txt"), fixture("other-ns.txt.sig"), KEY),
    ).toEqual({ ok: false, problem: "other_namespace" });
    const other = releaseKeyLineForTests(generateKeyPairSync("ed25519").privateKey);
    expect(verifyReleaseSignature(sums, fixture("SHA256SUMS.sig"), other)).toEqual({
      ok: false,
      problem: "other_key",
    });
    expect(verifyReleaseSignature(sums, fixture("SHA256SUMS.sig"), "")).toEqual({
      ok: false,
      problem: "no_key",
    });
    expect(verifyReleaseSignature(sums, fixture("SHA256SUMS.sig"), "# placeholder")).toEqual({
      ok: false,
      problem: "no_key",
    });
    for (const garbage of [
      "signature\n",
      "-----BEGIN SSH SIGNATURE-----\n!!!\n-----END SSH SIGNATURE-----\n",
      "-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n",
      `-----BEGIN SSH SIGNATURE-----\n${"A".repeat(20_000)}\n-----END SSH SIGNATURE-----\n`,
    ]) {
      expect(verifyReleaseSignature(sums, garbage, KEY)).toEqual({
        ok: false,
        problem: "malformed",
      });
    }
  });

  it("verifies what the test signer writes, and the fingerprint is ssh-keygen's", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const key = releaseKeyLineForTests(privateKey);
    const message = "c".repeat(64).concat("  recovery/restow-recovery_0.5.0_amd64.iso\n");
    const signature = signReleaseForTests(privateKey, message);
    expect(verifyReleaseSignature(message, signature, key)).toEqual({ ok: true });
    expect(verifyReleaseSignature(`${message} `, signature, key)).toEqual({
      ok: false,
      problem: "mismatch",
    });
    // In the form `ssh-keygen -l` prints: SHA256: and 43 characters of unpadded base64.
    expect(releaseSignatureKeyFingerprint(KEY)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});
