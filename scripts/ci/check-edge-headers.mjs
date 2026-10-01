#!/usr/bin/env node
/**
 * CI / release-smoke check: the Restow edge (Caddyfile) sends the security and
 * caching headers it is supposed to, against a real, running edge.
 *
 * Fetches seven things through the edge — the SPA root, a client-side deep link
 * (both served as `index.html` via `try_files`), a hashed file under `/assets/*`
 * (discovered from the SPA root's own markup, so it never goes stale), an API
 * route (`/api/v1/setup/state`, public before any admin exists), `/healthz`,
 * `/readyz`, and the M365 consent callback with no `state` param (also public,
 * and answered by the api itself with no Entra configuration needed) — and
 * asserts:
 *
 *   - the baseline hardening headers (nosniff, Referrer-Policy, Permissions-
 *     Policy, a CSP with a `frame-ancestors` of `'none'` or `'self'` and a
 *     `default-src`, and no `X-Frame-Options` that would allow framing) are
 *     present on the first six,
 *   - no response carries a `Server` header,
 *   - `index.html` (root and the deep link) is `Cache-Control: no-cache`,
 *   - the `/assets/*` file is `Cache-Control: ...immutable`,
 *   - the API route's `Cache-Control` is not the assets policy (the edge must
 *     leave `/api/*` caching to the api service, not impose its own),
 *   - `/healthz` and `/readyz` answer JSON (never the SPA's `index.html`) with
 *     a `status` field — not just a `200`, which the SPA fallback also answers
 *     when the edge's `handle /healthz`/`handle /readyz` block is missing or
 *     misrouted, the exact regression these two checks exist to catch,
 *   - the consent callback's own `Content-Security-Policy` (`default-src
 *     'none'; ...`) and `Referrer-Policy` (`no-referrer`) — deliberately
 *     stricter than the edge's SPA defaults, apps/api/src/features/sources/
 *     landing.ts — reach the browser unchanged rather than being overwritten
 *     by the edge's own defaults (the edge must only fill in headers a route
 *     did not already set, never replace ones it did), while that same
 *     response still gets the edge's own `X-Frame-Options` and
 *     `Permissions-Policy` defaults, since the route leaves those two unset
 *     (each of the five default headers is its own independently gated
 *     directive, so a route setting one of them must not suppress the
 *     other four),
 *   - `Strict-Transport-Security` is present only when `--expect-hsts` says the
 *     edge under test was started with `RESTOW_EDGE_HSTS=true` (public mode with
 *     a real TLS-terminated domain), and absent otherwise — never inferred from
 *     the URL alone, so the same script checks both a local/IP edge and a public
 *     one correctly.
 *
 * Usage:
 *   node scripts/ci/check-edge-headers.mjs --base-url http://localhost:8080
 *     [--deep-link /login] [--expect-hsts]
 *
 * Intended for the release smoke check (docs/TESTING.md, CI job
 * `release-smoke`): once wired in (not yet called from any workflow), it runs
 * this against the compose stack's published edge port for both a
 * local-mode and a public-mode run (the latter with `--expect-hsts`). Run it
 * by hand against a running edge until then.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BASELINE_HEADERS = /** @type {const} */ ([
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
]);

/**
 * Problems with the baseline hardening headers on one response. An empty array
 * means every check passed. `headers` is anything with a case-insensitive
 * `get(name)` (a real `Headers`, or a plain lookup in the tests below).
 */
export function checkBaselineHeaders(headers) {
  const problems = [];
  for (const [name, expected] of BASELINE_HEADERS) {
    const value = headers.get(name);
    if (value !== expected) {
      problems.push(
        `${name}: expected "${expected}", got ${value === null ? "(absent)" : `"${value}"`}`,
      );
    }
  }

  if (!headers.get("permissions-policy")) {
    problems.push("permissions-policy: missing");
  }

  const csp = headers.get("content-security-policy");
  if (!csp) {
    problems.push("content-security-policy: missing");
  } else {
    const frameAncestors = csp.match(/(?:^|;)\s*frame-ancestors\s+([^;]+)/i);
    if (!frameAncestors) {
      problems.push("content-security-policy: no frame-ancestors directive");
    } else {
      // Anything short of 'none'/'self' (a wildcard, a scheme, a bare host)
      // defeats the point of the directive, so this is not a "some value is
      // set" check: every source token must be one of the two Restow uses.
      const tokens = frameAncestors[1].trim().toLowerCase().split(/\s+/);
      const allowed = new Set(["'none'", "'self'"]);
      if (tokens.length === 0 || !tokens.every((token) => allowed.has(token))) {
        problems.push(
          `content-security-policy: frame-ancestors must be 'none' or 'self', got "${frameAncestors[1].trim()}"`,
        );
      }
    }
    if (!/(?:^|;)\s*default-src\s+[^;]+/i.test(csp)) {
      problems.push("content-security-policy: no default-src directive");
    }
  }

  // The modern frame-ancestors directive above is authoritative; this legacy
  // header only needs to not contradict it by allowing framing outright.
  const frameOptions = headers.get("x-frame-options");
  if (frameOptions !== null && !/^(DENY|SAMEORIGIN)$/i.test(frameOptions)) {
    problems.push(`x-frame-options: unexpected value "${frameOptions}"`);
  }

  if (headers.get("server") !== null) {
    problems.push(`server: present ("${headers.get("server")}"), should be removed`);
  }

  return problems;
}

/**
 * Problems where the edge overwrote a header a route set for itself, instead
 * of only defaulting a header the route left unset (the Caddyfile's `?`
 * operator on `security_headers_base`), plus the mirror-image bug that
 * operator used to have: five headers gated by one combined "all absent"
 * requirement, so a route setting even one of them (see below) suppressed
 * the edge's defaults for the other four as well. Checked against the one
 * live route this script can hit in any environment, without Entra
 * configuration or an existing session, that answers with its own fixed
 * hardening headers: GET /api/v1/sources/m365/consent/callback with no
 * `state` query param, which the api rejects deterministically
 * (apps/api/src/features/sources/service.ts, `invalid_state`/`missing`)
 * with `Content-Security-Policy: default-src 'none'; ...` and
 * `Referrer-Policy: no-referrer` — both deliberately stricter than the
 * edge's own SPA defaults, so overwriting either is easy to spot. That same
 * route leaves X-Frame-Options and Permissions-Policy unset, so those two
 * must still arrive with the edge's own default values.
 */
export function checkUpstreamHeadersPreserved(headers) {
  const problems = [];

  const csp = headers.get("content-security-policy");
  if (!csp || !/(?:^|;)\s*default-src\s+'none'\s*(?:;|$)/i.test(csp)) {
    problems.push(
      `content-security-policy: expected the api's own "default-src 'none'; ...", got ${csp === null ? "(absent)" : `"${csp}"`} — the edge may be overwriting an upstream header instead of only defaulting it`,
    );
  }

  const referrer = headers.get("referrer-policy");
  if (referrer !== "no-referrer") {
    problems.push(
      `referrer-policy: expected the api's own "no-referrer", got ${referrer === null ? "(absent)" : `"${referrer}"`} — the edge may be overwriting an upstream header instead of only defaulting it`,
    );
  }

  // The route above sets its own CSP and Referrer-Policy but never these two,
  // so the edge must still fill them in with its own defaults. A regression
  // where the five default headers share one combined "set only if every one
  // of them is absent" gate (instead of each header having its own) would
  // fail exactly here: with Referrer-Policy already present, that combined
  // gate is closed, and X-Frame-Options/Permissions-Policy silently never
  // get their default values either.
  const frameOptions = headers.get("x-frame-options");
  if (frameOptions !== "DENY") {
    problems.push(
      `x-frame-options: expected the edge's own default "DENY" (this route sets its own CSP and Referrer-Policy but not this header), got ${frameOptions === null ? "(absent)" : `"${frameOptions}"`} — a header the route did set may be suppressing the edge's defaults for headers it left unset`,
    );
  }

  if (!headers.get("permissions-policy")) {
    problems.push(
      "permissions-policy: expected the edge's own default (this route sets its own CSP and Referrer-Policy but not this header), got (absent) — a header the route did set may be suppressing the edge's defaults for headers it left unset",
    );
  }

  if (headers.get("server") !== null) {
    problems.push(`server: present ("${headers.get("server")}"), should be removed`);
  }

  return problems;
}

/** HSTS problems for one response, given whether the edge under test should send it. */
export function checkHsts(headers, expectHsts) {
  const value = headers.get("strict-transport-security");
  if (expectHsts && value === null) {
    return ["strict-transport-security: missing, but --expect-hsts was set"];
  }
  if (!expectHsts && value !== null) {
    return [`strict-transport-security: present ("${value}"), but --expect-hsts was not set`];
  }
  return [];
}

/**
 * Problems with a liveness/readiness endpoint's body (`/healthz`, `/readyz`):
 * it must be JSON with a `status` field, never HTML. This is the exact
 * regression that routing these two paths to the api guards against: with
 * the edge's `handle /healthz { ... }` block removed or misordered, Caddy's
 * catch-all `try_files` silently serves `index.html` instead, which is also
 * `200` and would pass a check that only looked at the status code.
 * `contentType` is the raw header value (or `null`); `body` is the response
 * text.
 */
export function checkStatusEndpointBody(contentType, body, { expectedStatus } = {}) {
  if (!contentType || !/^application\/json/i.test(contentType)) {
    return [
      `content-type: expected "application/json", got ${contentType ? `"${contentType}"` : "(absent)"} — looks like the SPA fallback answered instead of the api`,
    ];
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [`body: expected JSON, got unparsable content: ${body.slice(0, 120)}`];
  }

  if (parsed === null || typeof parsed !== "object" || typeof parsed.status !== "string") {
    return [`body: expected an object with a string "status" field, got ${JSON.stringify(parsed)}`];
  }

  if (expectedStatus !== undefined && parsed.status !== expectedStatus) {
    return [`body: expected status "${expectedStatus}", got "${parsed.status}"`];
  }

  return [];
}

/** True when a Cache-Control value asks for indefinite, immutable caching. */
export function isImmutableCacheControl(value) {
  return value !== null && /immutable/i.test(value) && /max-age=\d+/i.test(value);
}

/** True when a Cache-Control value forces revalidation on every request. */
export function isNoCacheControl(value) {
  return value !== null && /no-cache/i.test(value);
}

/**
 * The first `/assets/...` path referenced by the built SPA's `index.html`
 * (a `<script src>` or `<link href>`), so the check always exercises a file
 * the current build actually ships instead of a hardcoded, staleness-prone name.
 */
export function findAssetPath(html) {
  const match = html.match(/(?:src|href)="(\/assets\/[^"]+)"/);
  return match?.[1] ?? null;
}

function formatResult(label, problems) {
  if (problems.length === 0) {
    return `ok    ${label}`;
  }
  return [`FAIL  ${label}`, ...problems.map((problem) => `        - ${problem}`)].join("\n");
}

/** Fetch one path through the edge and collect every header/status problem found. */
async function checkResponse(baseUrl, path, { expectStatus = 200, extra = () => [] } = {}) {
  const response = await fetch(new URL(path, baseUrl));
  const problems = [];
  if (response.status !== expectStatus) {
    problems.push(`status: expected ${expectStatus}, got ${response.status}`);
  }
  problems.push(...checkBaselineHeaders(response.headers));
  problems.push(...extra(response.headers));
  return { response, problems };
}

export function parseArgs(argv) {
  const args = { baseUrl: null, deepLink: "/login", expectHsts: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--base-url":
        args.baseUrl = argv[++i];
        break;
      case "--deep-link":
        args.deepLink = argv[++i];
        break;
      case "--expect-hsts":
        args.expectHsts = true;
        break;
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (!args.baseUrl) {
    throw new Error("--base-url is required, e.g. --base-url http://localhost:8080");
  }
  return args;
}

async function run(args) {
  const results = [];

  const root = await checkResponse(args.baseUrl, "/", {
    extra: (headers) => [
      ...(isNoCacheControl(headers.get("cache-control"))
        ? []
        : [`cache-control: expected no-cache, got "${headers.get("cache-control")}"`]),
      ...checkHsts(headers, args.expectHsts),
    ],
  });
  results.push(["GET /", root.problems]);

  const deepLink = await checkResponse(args.baseUrl, args.deepLink, {
    extra: (headers) =>
      isNoCacheControl(headers.get("cache-control"))
        ? []
        : [`cache-control: expected no-cache, got "${headers.get("cache-control")}"`],
  });
  results.push([`GET ${args.deepLink}`, deepLink.problems]);

  const html = await root.response.text();
  const assetPath = findAssetPath(html);
  if (!assetPath) {
    results.push(["GET /assets/*", [`could not find an /assets/* reference in ${args.baseUrl}/`]]);
  } else {
    const asset = await checkResponse(args.baseUrl, assetPath, {
      extra: (headers) =>
        isImmutableCacheControl(headers.get("cache-control"))
          ? []
          : [`cache-control: expected immutable, got "${headers.get("cache-control")}"`],
    });
    results.push([`GET ${assetPath}`, asset.problems]);
  }

  const api = await checkResponse(args.baseUrl, "/api/v1/setup/state", {
    extra: (headers) =>
      isImmutableCacheControl(headers.get("cache-control"))
        ? ["cache-control: carries the /assets/* immutable policy, /api/* must stay untouched"]
        : [],
  });
  results.push(["GET /api/v1/setup/state", api.problems]);

  // Not run through checkResponse: catching the SPA-fallback regression needs
  // the response body (content-type + a JSON "status" field), which a
  // headers-only check cannot see — a misrouted /healthz still answers 200.
  const healthResponse = await fetch(new URL("/healthz", args.baseUrl));
  const healthProblems = [];
  if (healthResponse.status !== 200) {
    healthProblems.push(`status: expected 200, got ${healthResponse.status}`);
  }
  healthProblems.push(...checkBaselineHeaders(healthResponse.headers));
  healthProblems.push(
    ...checkStatusEndpointBody(
      healthResponse.headers.get("content-type"),
      await healthResponse.text(),
      {
        expectedStatus: "ok",
      },
    ),
  );
  results.push(["GET /healthz", healthProblems]);

  // /readyz may legitimately answer 503 (a dependency not ready yet), so its
  // status is checked against both possibilities instead of a fixed 200; it
  // must still never be the SPA fallback (see checkStatusEndpointBody).
  const readyResponse = await fetch(new URL("/readyz", args.baseUrl));
  const readyProblems = [];
  if (readyResponse.status !== 200 && readyResponse.status !== 503) {
    readyProblems.push(`status: expected 200 or 503, got ${readyResponse.status}`);
  }
  readyProblems.push(...checkBaselineHeaders(readyResponse.headers));
  readyProblems.push(
    ...checkStatusEndpointBody(
      readyResponse.headers.get("content-type"),
      await readyResponse.text(),
    ),
  );
  results.push(["GET /readyz", readyProblems]);

  // Deliberately not run through checkResponse/checkBaselineHeaders: this route
  // sets its own, stricter Referrer-Policy and CSP on purpose, so the edge's own
  // baseline values (which checkBaselineHeaders expects everywhere else) would
  // fail here even when the edge is behaving correctly.
  const consentCallback = await fetch(
    new URL("/api/v1/sources/m365/consent/callback", args.baseUrl),
  );
  const consentProblems = [];
  if (consentCallback.status !== 400) {
    consentProblems.push(`status: expected 400, got ${consentCallback.status}`);
  }
  consentProblems.push(...checkUpstreamHeadersPreserved(consentCallback.headers));
  results.push([
    "GET /api/v1/sources/m365/consent/callback (upstream headers preserved)",
    consentProblems,
  ]);

  return results;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      "usage: node scripts/ci/check-edge-headers.mjs --base-url <url> [--deep-link <path>] [--expect-hsts]",
    );
    return 1;
  }

  console.log(`Checking edge headers at ${args.baseUrl}\n`);
  const results = await run(args);

  let failed = 0;
  for (const [label, problems] of results) {
    console.log(formatResult(label, problems));
    failed += problems.length > 0 ? 1 : 0;
  }

  if (failed > 0) {
    console.error(`\n${failed} of ${results.length} checks failed.`);
    return 1;
  }
  console.log(`\nAll ${results.length} checks passed.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
