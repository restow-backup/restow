import { describe, expect, it } from "vitest";
import { MAX_FAILURE_TEXT, redactSensitiveText, redactedPath } from "./redact.js";

describe("redactSensitiveText", () => {
  it("removes bearer tokens and JWTs", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl";
    const text = redactSensitiveText(`401 with Bearer abcdef0123456789 and token ${jwt} inside`);
    expect(text).not.toContain("abcdef0123456789");
    expect(text).not.toContain(jwt);
    expect(text).toContain("[redacted]");
  });

  it("removes credentials in key=value pairs and JSON", () => {
    const text = redactSensitiveText(
      'client_secret=Sup3rSecret&password: "hunter2" {"access_token":"tok-123456","note":"ok"}',
    );
    expect(text).not.toContain("Sup3rSecret");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("tok-123456");
    expect(text).toContain("ok");
  });

  it("cuts query strings and user info from URLs", () => {
    const text = redactSensitiveText(
      "GET https://contoso.sharepoint.com/dl?tempauth=abc&sig=zzz failed; db postgres://restow:pa55w0rd@db.internal:5432/app",
    );
    expect(text).not.toContain("tempauth");
    expect(text).not.toContain("pa55w0rd");
    expect(text).toContain("https://contoso.sharepoint.com/dl?…");
  });

  it("removes key material and access key ids", () => {
    const text = redactSensitiveText(
      "key -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY----- and AKIAABCDEFGHIJKLMNOP",
    );
    expect(text).not.toContain("MIIEvQ");
    expect(text).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });

  it("drops the text of a failed query", () => {
    const text = redactSensitiveText(
      "Failed query: insert into secrets values ($1)\nparams: hunter2",
    );
    expect(text).toBe("database query failed");
  });

  it("hides IMAP login arguments", () => {
    const text = redactSensitiveText(
      'a2 LOGIN "user@x.test" "topsecret" then AUTHENTICATE PLAIN AGZvbwBiYXI=',
    );
    expect(text).not.toContain("topsecret");
    expect(text).not.toContain("AGZvbwBiYXI=");
    expect(text).toContain("LOGIN");
  });

  it("removes the product's own tokens, secrets and API keys when they stand alone", () => {
    const token = `rset_${"A1b2-C3d4_".repeat(4)}xyz`;
    const secret = `rsea_${"Zz9_-Yy8".repeat(5)}abc`;
    const apiKey = `rsk_contoso_${"a1B2c3D4e5".repeat(4)}`;
    const text = redactSensitiveText(
      `enroll ${token} failed; agent ${secret} refused; key ${apiKey} unknown`,
    );
    expect(text).not.toContain(token);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(apiKey);
    expect(text).toBe("enroll [redacted] failed; agent [redacted] refused; key [redacted] unknown");
    expect(redactSensitiveText(`endpoint-id:${secret}`)).toBe("endpoint-id:[redacted]");
    // Credential-named variables, as a hook or a shell prints them.
    expect(redactSensitiveText("env RESTIC_PASSWORD=hunter2hunter2 PGPASSWORD='s3cret'")).toBe(
      "env RESTIC_PASSWORD=[redacted] PGPASSWORD=[redacted]",
    );
    expect(redactSensitiveText("fetch.token_unavailable: no token stored")).toBe(
      "fetch.token_unavailable: no token stored",
    );
    // Words that only start like a token stay.
    expect(redactSensitiveText("rsync_failed and rsk_ prefix")).toBe(
      "rsync_failed and rsk_ prefix",
    );
  });

  it("keeps ordinary diagnostics readable", () => {
    const text = "ENOENT: no such file or directory, open '/data/tenants/t/packs/ab/abcdef'";
    expect(redactSensitiveText(text)).toBe(text);
  });

  it("puts multi-line text on one line and bounds it", () => {
    expect(redactSensitiveText("a\n\nb\tc")).toBe("a b c");
    const long = redactSensitiveText("x".repeat(2000));
    expect(long.length).toBe(MAX_FAILURE_TEXT);
    expect(long.endsWith("…")).toBe(true);
  });

  it("is idempotent", () => {
    const once = redactSensitiveText(
      "Bearer abcdef0123456789 password=hunter2 https://x.test/a?b=c",
    );
    expect(redactSensitiveText(once)).toBe(once);
  });
});

describe("redactedPath", () => {
  it("keeps the path and drops query, fragment and host", () => {
    expect(redactedPath("https://graph.microsoft.com/v1.0/users/a@b.de/messages?$top=1#x")).toBe(
      "/v1.0/users/a@b.de/messages",
    );
    expect(redactedPath("/users/a@b.de/messages?$select=id")).toBe("/users/a@b.de/messages");
  });
});
