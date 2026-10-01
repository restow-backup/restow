import { describe, expect, it } from "vitest";
import { REDACTED, Redactor, clip, sensitiveEnvValues } from "./redact.js";

describe("Redactor", () => {
  const redactor = new Redactor();

  it.each([
    ["Authorization: Bearer abcdef123456", "Authorization: [redacted]"],
    ["authorization: token ghp_abcdefghijklmnop", "authorization: [redacted]"],
    ["Authorization: Basic dXNlcjpwYXNz", "Authorization: [redacted]"],
    ['{"Authorization":"Bearer abc.def.ghi"}', '{"Authorization":"[redacted]"}'],
    [
      "sent header Authorization=token 1234567890abcdef ok",
      "sent header Authorization=[redacted] ok",
    ],
  ])("removes the value of an Authorization header: %s", (input, expected) => {
    expect(redactor.redact(input)).toBe(expected);
  });

  it("removes bearer values and token-looking values", () => {
    expect(redactor.redact("got Bearer abc.def-123_456")).toBe(`got Bearer ${REDACTED}`);
    expect(redactor.redact("using token ghp_1234567890abcdefgh now")).toBe(
      `using token ${REDACTED} now`,
    );
    expect(
      redactor.redact(
        "gho_abcdefghijklmnopqrstu github_pat_11ABCDEFG0abcdefghijkl glpat-abcdefghijklmnopqrst",
      ),
    ).toBe(`${REDACTED} ${REDACTED} ${REDACTED}`);
  });

  it("removes the product's own tokens, secrets and API keys when they stand alone", () => {
    const token = `rset_${"A1b2-C3d4_".repeat(4)}xyz`;
    const secret = `rsea_${"Zz9_-Yy8".repeat(5)}abc`;
    const apiKey = `rsk_contoso_${"a1B2c3D4e5".repeat(4)}`;
    expect(redactor.redact(`enroll ${token} then ${secret} with ${apiKey}.`)).toBe(
      `enroll ${REDACTED} then ${REDACTED} with ${REDACTED}.`,
    );
    expect(redactor.redact(`endpoint:${secret}`)).toBe(`endpoint:${REDACTED}`);
    // The placeholder of the documentation is no secret.
    expect(redactor.redact("a key looks like rsk_<tag>_<secret>")).toBe(
      "a key looks like rsk_<tag>_<secret>",
    );
  });

  it("leaves ordinary words after 'token' alone", () => {
    expect(redactor.redact("fetch.token_unavailable: the api has no token stored")).toBe(
      "fetch.token_unavailable: the api has no token stored",
    );
    expect(redactor.redact("the token expired yesterday")).toBe("the token expired yesterday");
  });

  it("removes credentials from URLs", () => {
    expect(redactor.redact("clone https://user:p%40ss@host.example/x.git failed")).toBe(
      `clone https://${REDACTED}@host.example/x.git failed`,
    );
    expect(redactor.redact("postgres://restow:hunter2@db:5432/restow")).toBe(
      `postgres://${REDACTED}@db:5432/restow`,
    );
    expect(redactor.redact("https://ghp_abc@github.com/x/y")).toBe(
      `https://${REDACTED}@github.com/x/y`,
    );
    expect(redactor.redact("see https://example.com/path?a=b for details")).toBe(
      "see https://example.com/path?a=b for details",
    );
  });

  it("removes values of credential-named pairs", () => {
    expect(redactor.redact("POSTGRES_PASSWORD=hunter2 and RESTOW_MASTER_KEY: abcdef")).toBe(
      `POSTGRES_PASSWORD=${REDACTED} and RESTOW_MASTER_KEY: ${REDACTED}`,
    );
    expect(redactor.redact('{"password":"secret value","user":"x"}')).toBe(
      `{"password":"${REDACTED}","user":"x"}`,
    );
    expect(redactor.redact("client_secret='abc def'")).toBe(`client_secret='${REDACTED}'`);
  });

  it("removes registered secrets wherever they appear and forgets them on request", () => {
    const local = new Redactor();
    expect(local.add("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(local.add("short")).toBe(false);
    expect(local.add("")).toBe(false);
    const text = "secret=0123456789abcdef0123456789abcdef; again 0123456789abcdef0123456789abcdef!";
    expect(local.redact(text)).not.toContain("0123456789abcdef");
    expect(local.redact("prefix0123456789abcdef0123456789abcdefsuffix")).toBe(
      `prefix${REDACTED}suffix`,
    );
    local.forget("0123456789abcdef0123456789abcdef");
    expect(local.redact("0123456789abcdef0123456789abcdef")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
  });

  it("removes a secret that contains another one completely", () => {
    const local = new Redactor();
    local.add("abcdef123456");
    local.add("abcdef123456-and-more");
    expect(local.redact("x abcdef123456-and-more y")).toBe(`x ${REDACTED} y`);
  });

  it("keeps a bounded number of secrets", () => {
    const local = new Redactor();
    for (let index = 0; index < 100; index++) {
      local.add(`secret-value-${index}`);
    }
    expect(local.size).toBe(64);
  });

  it("collapses to one line and clips", () => {
    expect(redactor.oneLine("a\n  b\r\n\tc  ")).toBe("a b c");
    const long = redactor.oneLine("x".repeat(5000), 100);
    expect(long).toHaveLength(100);
    expect(long.endsWith("…")).toBe(true);
    expect(redactor.tail("1\n2\n3", 3)).toBe("...2\n3");
  });

  it("clip does not split a surrogate pair", () => {
    const text = `${"a".repeat(9)}\u{1F600}tail`;
    const clipped = clip(text, 11);
    expect(clipped).not.toMatch(/[\ud800-\udbff]$/u);
    expect(clipped.length).toBeLessThanOrEqual(11);
  });
});

describe("sensitiveEnvValues", () => {
  it("returns the values of credential-named variables, unquoted", () => {
    const values = sensitiveEnvValues(
      [
        "# comment",
        "POSTGRES_PASSWORD=super-secret-db-password",
        'BETTER_AUTH_SECRET="quoted secret value" # note',
        "export RESTOW_MASTER_KEY='single-quoted-key'",
        "S3_ACCESS_KEY_ID=short",
        "GRAPH_CLIENT_SECRET=abcdefgh  # trailing",
        "RESTOW_APP_DOMAIN=example.com",
        "POSTGRES_USER=restow",
      ].join("\r\n"),
    );
    expect(values).toEqual([
      "super-secret-db-password",
      "quoted secret value",
      "single-quoted-key",
      "abcdefgh",
    ]);
  });
});
