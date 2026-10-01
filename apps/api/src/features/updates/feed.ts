import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { guardedLookup, isBlockedAddressError, refuseHostBeforeConnect } from "@restow/core";
import type { StoredUpdateRelease } from "@restow/db";
import { z } from "zod";
import { compareVersions, parseVersion } from "../../routes/v1/version.js";
import { type ImageVariant, imageNamesOf } from "../../updater/image-variant.js";
import type { CheckError, CheckErrorCode, UpdateChannel } from "./schemas.js";

/**
 * Reading a release list (docs/ARCHITECTURE.md, Updates). GitHub and the
 * Forgejo/Gitea releases API answer with the same fields for what is needed
 * here, as a list or (`/releases/latest`) as one object. Only the list is read:
 * a request carries no data about the installation, and the access token of a
 * private source (when there is one) goes out in one header to the source's own
 * origin and nowhere else.
 *
 * The source is an address an administrator typed, and this server fetches it:
 * without a guard that would let the tab probe the internal network (the
 * database, other containers, the cloud metadata service, the LAN) and read
 * the answers' status codes back. So the connection goes only to public
 * addresses, checked in the socket's own DNS lookup (@restow/core
 * net/address-policy.ts, also against DNS rebinding); loopback and private
 * networks only where the operator decided so (the environment override, or a
 * host named in RESTOW_UPDATER_SOURCE_HOSTS). A refused address, a name that
 * does not resolve and a connection that fails all read the same ("network",
 * no detail), so the refusal tells nothing about what exists behind it, and
 * the body is read as a stream and given up past 8 MiB, whatever the server
 * declared.
 */

/** Longest release-notes text kept per release. */
export const MAX_NOTES_LENGTH = 20_000;

/** Releases kept per check: the newest ones of the channel. */
export const MAX_RELEASES = 10;

const releaseSchema = z.object({
  tag_name: z.string().min(1),
  name: z.string().nullish(),
  body: z.string().nullish(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  html_url: z.string().nullish(),
  published_at: z.string().nullish(),
  created_at: z.string().nullish(),
});

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function httpsOrNull(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

const DIGEST_LINE =
  /^[\s>*_-]*`?(restow(?:-web)?(?:-community)?)`?\s*[:=]\s*`?(sha256:[0-9a-f]{64})`?\s*$/gim;

/**
 * Image digests a release publishes in its notes, one per line and image:
 *
 *     restow: sha256:<64 hex digits>
 *     restow-web: sha256:<64 hex digits>
 *     restow-community: sha256:<64 hex digits>
 *     restow-web-community: sha256:<64 hex digits>
 *
 * (also tolerated as list items or in code spans). Only the two lines of this
 * installation's build count (`variant`, image-variant.ts): a Community
 * installation reads the `-community` lines and never the digests of the full
 * images, and the other way round. The updater compares the pulled image
 * against them.
 */
export function digestsOf(
  notes: string | null | undefined,
  variant: ImageVariant = "full",
): { app?: string; web?: string } {
  const digests: { app?: string; web?: string } = {};
  if (!notes) {
    return digests;
  }
  const names = imageNamesOf(variant);
  for (const match of notes.matchAll(DIGEST_LINE)) {
    const digest = match[2]?.toLowerCase();
    const name = match[1]?.toLowerCase();
    if (!digest) {
      continue;
    }
    if (name === names.web) {
      digests.web ??= digest;
    } else if (name === names.app) {
      digests.app ??= digest;
    }
  }
  return digests;
}

/**
 * A release entry, or null for a draft and for tags that are not versions. Its
 * digests are those of the images of `variant`.
 */
export function toRelease(
  entry: unknown,
  variant: ImageVariant = "full",
): StoredUpdateRelease | null {
  const parsed = releaseSchema.safeParse(entry);
  if (!parsed.success || parsed.data.draft) {
    return null;
  }
  const release = parsed.data;
  const version = parseVersion(release.tag_name);
  if (!version) {
    return null;
  }
  const source = release.body?.replace(/\r\n?/g, "\n").trim() ?? "";
  const truncated = source.length > MAX_NOTES_LENGTH;
  return {
    version: release.tag_name.trim().replace(/^v/, ""),
    tag: release.tag_name.trim(),
    name: release.name?.trim() || null,
    publishedAt: isoOrNull(release.published_at) ?? isoOrNull(release.created_at),
    url: httpsOrNull(release.html_url),
    prerelease: release.prerelease === true || version.prerelease.length > 0,
    notes: source.length === 0 ? null : source.slice(0, MAX_NOTES_LENGTH),
    notesTruncated: truncated,
    digests: digestsOf(source, variant),
  };
}

/** Every usable release in a response body (list or single object), unsorted. */
export function parseReleases(
  body: unknown,
  variant: ImageVariant = "full",
): StoredUpdateRelease[] {
  const entries = Array.isArray(body) ? body : [body];
  const releases: StoredUpdateRelease[] = [];
  for (const entry of entries) {
    const release = toRelease(entry, variant);
    if (release) {
      releases.push(release);
    }
  }
  return releases;
}

/**
 * The releases of a channel, newest first (semantic version order, so a
 * `1.0.0-rc.2` precedes `1.0.0`). `stable` leaves out pre-releases; `beta`
 * offers them as well.
 */
export function releasesForChannel(
  releases: readonly StoredUpdateRelease[],
  channel: UpdateChannel,
): StoredUpdateRelease[] {
  const seen = new Set<string>();
  return releases
    .filter((release) => channel === "beta" || !release.prerelease)
    .filter((release) => {
      if (seen.has(release.version)) {
        return false;
      }
      seen.add(release.version);
      return true;
    })
    .sort((a, b) => {
      const left = parseVersion(a.version);
      const right = parseVersion(b.version);
      return left && right ? compareVersions(right, left) : 0;
    })
    .slice(0, MAX_RELEASES);
}

// ---------------------------------------------------------------------------
// Reading the source
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FeedRequest {
  releasesUrl: string;
  /** Sent as `Authorization: token <value>` to the source's own origin only. */
  token: string | null;
  /** The connection may reach loopback and private networks (the operator's decision). */
  allowPrivateNetworks?: boolean;
  /** Whose image digests to read from the notes: this installation's build. Default full. */
  imageVariant?: ImageVariant;
  /** Replaces the guarded transport (tests). */
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

export type FeedResult =
  | { ok: true; releases: StoredUpdateRelease[] }
  | { ok: false; error: CheckError };

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function failure(
  code: CheckErrorCode,
  status: number | null = null,
  detail: string | null = null,
  retryAt: string | null = null,
): FeedResult {
  return { ok: false, error: { code, status, retryAt, detail } };
}

/** When a rate limit ends, from the headers GitHub and Forgejo send. */
export function retryAtOf(headers: Headers, nowMs: number): string | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return new Date(nowMs + seconds * 1000).toISOString();
    }
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) {
      return new Date(at).toISOString();
    }
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return new Date(reset * 1000).toISOString();
  }
  return null;
}

/** Turn a non-success answer into the reason shown to the administrator. */
export function classifyStatus(response: Pick<Response, "status" | "headers">, nowMs: number) {
  const { status, headers } = response;
  if (status === 401) {
    return failure("unauthorized", status);
  }
  if (status === 429 || (status === 403 && headers.get("x-ratelimit-remaining") === "0")) {
    return failure("rate_limited", status, null, retryAtOf(headers, nowMs));
  }
  if (status === 403) {
    return failure("forbidden", status);
  }
  if (status === 404) {
    return failure("not_found", status);
  }
  if (status >= 500) {
    return failure("server_error", status);
  }
  return failure("invalid_response", status);
}

/** TLS problems of a host that was allowed and answered; worth naming to the administrator. */
const TLS_CODE = /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;

/**
 * A network failure. A refused address, a DNS failure and a failed connection
 * all read the same, without detail; only a certificate problem of a host that
 * was reached is named (`CERT_HAS_EXPIRED`, ...). Never the URL.
 */
function networkFailure(error: unknown): FeedResult {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return failure("timeout");
  }
  if (isBlockedAddressError(error)) {
    return failure("network");
  }
  const cause = (error as { cause?: { code?: unknown }; code?: unknown } | null) ?? null;
  const code =
    typeof cause?.cause?.code === "string"
      ? cause.cause.code
      : typeof cause?.code === "string"
        ? cause.code
        : null;
  return failure("network", null, code && TLS_CODE.test(code) ? code : null);
}

/** The body as text, read as a stream and given up past the cap (declared or not). */
async function readCapped(response: Response): Promise<string | null> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface GuardedFetchOptions {
  allowPrivateNetworks: boolean;
  /** Tests only: plain http to a fake server. Never set from configuration. */
  allowInsecureHttp?: boolean;
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * `fetch` for the release list over node's own client, so the socket's DNS
 * lookup can refuse what the policy does not allow. It never follows a
 * redirect (the caller does, within the origin).
 */
export function guardedFetch(options: GuardedFetchOptions): FetchLike {
  return (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(input);
      } catch (error) {
        reject(error);
        return;
      }
      const plain = url.protocol === "http:" && options.allowInsecureHttp === true;
      if (url.protocol !== "https:" && !plain) {
        reject(new TypeError("only https is fetched"));
        return;
      }
      const refused = refuseHostBeforeConnect(url.hostname, options.allowPrivateNetworks);
      if (refused) {
        reject(refused);
        return;
      }
      const headers = (init.headers ?? {}) as Record<string, string>;
      const request = (plain ? http : https).request(
        url,
        {
          method: init.method ?? "GET",
          headers,
          lookup: guardedLookup(options.allowPrivateNetworks),
          // A fresh connection each time: a pooled socket would skip the guarded lookup.
          agent: false,
          signal: init.signal ?? undefined,
        },
        (incoming) => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
              responseHeaders.append(name, item);
            }
          }
          const status = incoming.statusCode ?? 0;
          const body = NULL_BODY_STATUSES.has(status)
            ? null
            : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
          if (body === null) {
            incoming.resume();
          }
          resolve(new Response(body, { status, headers: responseHeaders }));
        },
      );
      request.on("error", (error) => reject(error));
      request.end();
    });
}

/**
 * Read a release list. Redirects are followed by hand (at most three) and only
 * within the origin that was asked, so the token can never reach another host;
 * a redirect elsewhere is reported as such.
 */
export async function fetchReleases(request: FeedRequest): Promise<FeedResult> {
  const fetcher =
    request.fetch ?? guardedFetch({ allowPrivateNetworks: request.allowPrivateNetworks === true });
  const nowMs = (request.now ?? Date.now)();
  let url = request.releasesUrl;
  const origin = new URL(url).origin;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json, application/json",
        "user-agent": "restow-update-check",
      };
      if (request.token) {
        headers.authorization = `token ${request.token}`;
      }
      const response = await fetcher(url, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        const next = location ? safeResolve(location, url) : null;
        if (!next || next.origin !== origin || next.protocol !== "https:") {
          return failure("redirect", response.status);
        }
        url = next.toString();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return classifyStatus(response, nowMs);
      }
      const text = await readCapped(response);
      if (text === null) {
        return failure("invalid_response", response.status, "too_large");
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return failure("invalid_response", response.status, "not_json");
      }
      const releases = parseReleases(body, request.imageVariant);
      return releases.length > 0 ? { ok: true, releases } : failure("no_release", response.status);
    }
    return failure("redirect");
  } catch (error) {
    return networkFailure(error);
  }
}

function safeResolve(location: string, base: string): URL | null {
  try {
    return new URL(location, base);
  } catch {
    return null;
  }
}
