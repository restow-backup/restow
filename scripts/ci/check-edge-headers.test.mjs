/**
 * Self-test of the edge header checks (check-edge-headers.mjs):
 * `node --test scripts/ci/check-edge-headers.test.mjs`. Exercises the pure
 * header/Cache-Control assertions and argument parsing against synthetic
 * `Headers` objects; it never starts a real edge (that only happens against a
 * live Caddy in the release smoke check).
 *
 * Not yet wired into a workflow: neither this suite nor check-edge-headers.mjs
 * itself is called from .github/workflows/ci.yml or a release-smoke job today.
 * Run it by hand until that lands.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkBaselineHeaders,
  checkHsts,
  checkStatusEndpointBody,
  checkUpstreamHeadersPreserved,
  findAssetPath,
  isImmutableCacheControl,
  isNoCacheControl,
  parseArgs,
} from "./check-edge-headers.mjs";

const GOOD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";

// The api's own hardening on the M365 consent-landing page (LANDING_CSP,
// apps/api/src/features/sources/landing.ts): stricter than, and different
// from, the edge's SPA defaults above, so a test that mixes the two up would
// be caught.
const UPSTREAM_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function headersFrom(entries) {
  return new Headers(entries);
}

const GOOD_HEADERS = () =>
  headersFrom({
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=()",
    "content-security-policy": GOOD_CSP,
    "x-frame-options": "DENY",
  });

describe("checkBaselineHeaders", () => {
  it("passes a fully hardened response", () => {
    assert.deepEqual(checkBaselineHeaders(GOOD_HEADERS()), []);
  });

  it("catches a missing nosniff header", () => {
    const headers = GOOD_HEADERS();
    headers.delete("x-content-type-options");
    const problems = checkBaselineHeaders(headers);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /x-content-type-options/);
  });

  it("catches a weaker referrer-policy", () => {
    const headers = GOOD_HEADERS();
    headers.set("referrer-policy", "unsafe-url");
    const problems = checkBaselineHeaders(headers);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /referrer-policy/);
  });

  it("catches a missing permissions-policy", () => {
    const headers = GOOD_HEADERS();
    headers.delete("permissions-policy");
    assert.deepEqual(checkBaselineHeaders(headers), ["permissions-policy: missing"]);
  });

  it("catches a missing CSP entirely", () => {
    const headers = GOOD_HEADERS();
    headers.delete("content-security-policy");
    assert.deepEqual(checkBaselineHeaders(headers), ["content-security-policy: missing"]);
  });

  it("catches a CSP with no frame-ancestors", () => {
    const headers = GOOD_HEADERS();
    headers.set("content-security-policy", "default-src 'self'");
    const problems = checkBaselineHeaders(headers);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /frame-ancestors/);
  });

  it("catches a frame-ancestors wildcard as insufficient, even though it is 'set'", () => {
    const headers = GOOD_HEADERS();
    headers.set("content-security-policy", "default-src 'self'; frame-ancestors *");
    const problems = checkBaselineHeaders(headers);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /frame-ancestors must be 'none' or 'self'/);
  });

  it("catches a frame-ancestors naming an origin instead of 'none'/'self'", () => {
    const headers = GOOD_HEADERS();
    headers.set(
      "content-security-policy",
      "default-src 'self'; frame-ancestors https://attacker.example",
    );
    const problems = checkBaselineHeaders(headers);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /frame-ancestors must be 'none' or 'self'/);
  });

  it("accepts a frame-ancestors of 'self'", () => {
    const headers = GOOD_HEADERS();
    headers.set("content-security-policy", "default-src 'self'; frame-ancestors 'self'");
    assert.deepEqual(checkBaselineHeaders(headers), []);
  });

  it("catches a CSP with no default-src", () => {
    const headers = GOOD_HEADERS();
    headers.set("content-security-policy", "frame-ancestors 'none'");
    const problems = checkBaselineHeaders(headers);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /default-src/);
  });

  it("accepts SAMEORIGIN as well as DENY for the legacy header", () => {
    const headers = GOOD_HEADERS();
    headers.set("x-frame-options", "SAMEORIGIN");
    assert.deepEqual(checkBaselineHeaders(headers), []);
  });

  it("catches an x-frame-options that would allow framing", () => {
    const headers = GOOD_HEADERS();
    headers.set("x-frame-options", "ALLOWALL");
    const problems = checkBaselineHeaders(headers);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /x-frame-options/);
  });

  it("catches a Server header that should have been removed", () => {
    const headers = GOOD_HEADERS();
    headers.set("server", "Caddy");
    const problems = checkBaselineHeaders(headers);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /server: present/);
  });

  it("reports every problem at once, not just the first", () => {
    const headers = headersFrom({});
    const problems = checkBaselineHeaders(headers);
    // nosniff, referrer-policy, permissions-policy, CSP: four independent gaps.
    assert.equal(problems.length, 4);
  });
});

describe("checkHsts", () => {
  it("is happy when HSTS is expected and present", () => {
    const headers = headersFrom({
      "strict-transport-security": "max-age=63072000; includeSubDomains",
    });
    assert.deepEqual(checkHsts(headers, true), []);
  });

  it("is happy when HSTS is not expected and absent", () => {
    assert.deepEqual(checkHsts(headersFrom({}), false), []);
  });

  it("flags a missing HSTS header when it was expected (public mode)", () => {
    const problems = checkHsts(headersFrom({}), true);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /missing/);
  });

  it("flags a present HSTS header when it was not expected (local/IP mode)", () => {
    const headers = headersFrom({ "strict-transport-security": "max-age=63072000" });
    const problems = checkHsts(headers, false);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /present/);
  });
});

describe("checkStatusEndpointBody", () => {
  it("passes a JSON body with the expected status", () => {
    assert.deepEqual(
      checkStatusEndpointBody("application/json; charset=utf-8", '{"status":"ok"}', {
        expectedStatus: "ok",
      }),
      [],
    );
  });

  it("passes a JSON body with any string status when none is required", () => {
    assert.deepEqual(
      checkStatusEndpointBody("application/json", '{"status":"ready","checks":{"database":true}}'),
      [],
    );
  });

  it("catches the SPA fallback answering instead of the api (text/html, 200)", () => {
    const problems = checkStatusEndpointBody("text/html; charset=utf-8", "<!doctype html>...");
    assert.equal(problems.length, 1);
    assert.match(problems[0], /content-type/);
    assert.match(problems[0], /SPA fallback/);
  });

  it("catches a missing content-type", () => {
    const problems = checkStatusEndpointBody(null, '{"status":"ok"}');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /\(absent\)/);
  });

  it("catches an unparsable body", () => {
    const problems = checkStatusEndpointBody("application/json", "not json");
    assert.equal(problems.length, 1);
    assert.match(problems[0], /expected JSON/);
  });

  it("catches a JSON body with no status field", () => {
    const problems = checkStatusEndpointBody("application/json", '{"ok":true}');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /string "status" field/);
  });

  it("catches a JSON array instead of an object", () => {
    const problems = checkStatusEndpointBody("application/json", "[]");
    assert.equal(problems.length, 1);
    assert.match(problems[0], /string "status" field/);
  });

  it("catches the wrong status value", () => {
    const problems = checkStatusEndpointBody("application/json", '{"status":"degraded"}', {
      expectedStatus: "ok",
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /expected status "ok", got "degraded"/);
  });
});

describe("checkUpstreamHeadersPreserved", () => {
  // The route sets its own CSP and Referrer-Policy but never touches
  // X-Frame-Options or Permissions-Policy, so a correctly behaving edge still
  // fills those two in with its own defaults (each of the five default
  // headers has its own independent "only if unset" gate).
  const UPSTREAM_HEADERS = () =>
    headersFrom({
      "content-security-policy": UPSTREAM_CSP,
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "permissions-policy": "camera=(), microphone=()",
    });

  it("passes when the api's own headers reached the browser unchanged and the edge filled in the rest", () => {
    assert.deepEqual(checkUpstreamHeadersPreserved(UPSTREAM_HEADERS()), []);
  });

  it("catches the edge overwriting the CSP with its own SPA default", () => {
    const headers = UPSTREAM_HEADERS();
    headers.set("content-security-policy", GOOD_CSP);
    const problems = checkUpstreamHeadersPreserved(headers);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /content-security-policy/);
  });

  it("catches a missing CSP", () => {
    const headers = UPSTREAM_HEADERS();
    headers.delete("content-security-policy");
    const problems = checkUpstreamHeadersPreserved(headers);
    assert.match(problems[0], /content-security-policy.*\(absent\)/s);
  });

  it("catches the edge overwriting no-referrer with its own default", () => {
    const headers = UPSTREAM_HEADERS();
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
    const problems = checkUpstreamHeadersPreserved(headers);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /referrer-policy/);
  });

  it("catches the edge failing to default X-Frame-Options on a route that left it unset", () => {
    const headers = UPSTREAM_HEADERS();
    headers.delete("x-frame-options");
    const problems = checkUpstreamHeadersPreserved(headers);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /x-frame-options/);
  });

  it("catches the edge failing to default Permissions-Policy on a route that left it unset", () => {
    const headers = UPSTREAM_HEADERS();
    headers.delete("permissions-policy");
    const problems = checkUpstreamHeadersPreserved(headers);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /permissions-policy/);
  });

  it("catches a Server header the edge should have stripped even here", () => {
    const headers = UPSTREAM_HEADERS();
    headers.set("server", "Caddy");
    const problems = checkUpstreamHeadersPreserved(headers);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /server: present/);
  });

  it("reports every problem at once", () => {
    // Missing CSP, Referrer-Policy, X-Frame-Options and Permissions-Policy:
    // four independent gaps (Server is absent too, but that is correct, not
    // a problem).
    assert.equal(checkUpstreamHeadersPreserved(headersFrom({})).length, 4);
  });
});

describe("isImmutableCacheControl / isNoCacheControl", () => {
  it("recognizes the assets policy", () => {
    assert.equal(isImmutableCacheControl("public, max-age=31536000, immutable"), true);
  });

  it("rejects a bare max-age without immutable", () => {
    assert.equal(isImmutableCacheControl("public, max-age=31536000"), false);
  });

  it("rejects an absent header", () => {
    assert.equal(isImmutableCacheControl(null), false);
  });

  it("recognizes the index.html policy", () => {
    assert.equal(isNoCacheControl("no-cache"), true);
  });

  it("rejects an absent header", () => {
    assert.equal(isNoCacheControl(null), false);
  });
});

describe("findAssetPath", () => {
  it("finds a script src", () => {
    const html = '<script type="module" crossorigin src="/assets/index-CXFz5lSC.js"></script>';
    assert.equal(findAssetPath(html), "/assets/index-CXFz5lSC.js");
  });

  it("finds a stylesheet href when no script matches first", () => {
    const html = '<link rel="stylesheet" crossorigin href="/assets/index-eNOXZi3K.css">';
    assert.equal(findAssetPath(html), "/assets/index-eNOXZi3K.css");
  });

  it("returns null when nothing under /assets/ is referenced", () => {
    assert.equal(findAssetPath("<html><body>empty</body></html>"), null);
  });
});

describe("parseArgs", () => {
  it("requires --base-url", () => {
    assert.throws(() => parseArgs([]), /--base-url is required/);
  });

  it("defaults the deep link and expectHsts", () => {
    const args = parseArgs(["--base-url", "http://localhost:8080"]);
    assert.deepEqual(args, {
      baseUrl: "http://localhost:8080",
      deepLink: "/login",
      expectHsts: false,
    });
  });

  it("accepts an overridden deep link and --expect-hsts", () => {
    const args = parseArgs([
      "--base-url",
      "https://app.example.com",
      "--deep-link",
      "/dashboard",
      "--expect-hsts",
    ]);
    assert.deepEqual(args, {
      baseUrl: "https://app.example.com",
      deepLink: "/dashboard",
      expectHsts: true,
    });
  });

  it("rejects an unknown flag", () => {
    assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
  });
});
