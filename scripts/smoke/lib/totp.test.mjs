import assert from "node:assert/strict";
import { test } from "node:test";
import { secretFromOtpauth, totp } from "./totp.mjs";

// RFC 6238 appendix B, SHA-1, secret "12345678901234567890" (base32 below).
// The public test secret of RFC 6238, appendix B, not a credential.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // gitleaks:allow

test("totp matches the RFC 6238 test vectors (last six digits of the 8 digit codes)", () => {
  assert.equal(totp(RFC_SECRET, 59_000), "287082");
  assert.equal(totp(RFC_SECRET, 1_111_111_109_000), "081804");
  assert.equal(totp(RFC_SECRET, 1_234_567_890_000), "005924");
  assert.equal(totp(RFC_SECRET, 2_000_000_000_000), "279037");
});

test("secretFromOtpauth reads the secret parameter", () => {
  assert.equal(
    secretFromOtpauth("otpauth://totp/Restow:me%40example.com?secret=ABC234&issuer=Restow"),
    "ABC234",
  );
  assert.throws(() => secretFromOtpauth("otpauth://totp/x?issuer=y"));
});
