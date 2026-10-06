import type { SourceProvider } from "./schemas.js";

/**
 * Where releases come from (docs/ARCHITECTURE.md, Updates): the public releases
 * of the project on GitHub, or another repository the administrator names
 * (GitHub, or Forgejo/Gitea, whose releases API is compatible).
 *
 * A source is only ever read: the release list, and for the `source` install
 * mode the tag's archive. The URL is validated here once; nothing else in the
 * feature builds a request URL from a string an administrator typed.
 */

/** The public repository whose releases are the default source. */
export const DEFAULT_SOURCE_URL = "https://github.com/restow-backup/restow";
const DEFAULT_REPOSITORY = "restow-backup/restow";

/**
 * The project's alpha repository: its releases announce unsigned test builds (images in
 * ghcr.io/restow-backup/restow-alpha, digests in the notes). They are installed like the
 * published images, so an updater that verifies signatures refuses them; the operator
 * switches that check off for a test installation (docs/UPDATING.md, "Alpha builds").
 */
export const ALPHA_SOURCE_URL = "https://github.com/restow-backup/restow-alpha";
const ALPHA_REPOSITORY = "restow-backup/restow-alpha";

/** How many releases one request asks for (one page covers the recent history). */
const PAGE_SIZE = 30;

export interface ParsedSource {
  provider: SourceProvider;
  /** The URL to show: the repository, or the feed for a feed-only override. */
  url: string;
  /** `owner/repo` when the source is a repository. */
  repository: string | null;
  /** Where the release list is read. */
  releasesUrl: string;
  /** The tarball of a tag (`source` install mode); null for a feed-only source. */
  archiveUrl: (tag: string) => string | null;
  /** The project's own public repository: releases come with published images. */
  isDefault: boolean;
  /** The project's alpha repository: unsigned test builds that are installed as images too. */
  isAlpha: boolean;
}

export type SourceProblem = "invalid_url" | "not_https" | "credentials_in_url" | "not_a_repository";

export type SourceParse =
  | { ok: true; source: ParsedSource }
  | { ok: false; problem: SourceProblem };

function safeUrl(input: string): URL | null {
  try {
    return new URL(input.trim());
  } catch {
    return null;
  }
}

function trimSlashes(path: string): string {
  return path.replace(/\/+$/, "");
}

function stripGitSuffix(name: string): string {
  return name.replace(/\.git$/i, "");
}

const NAME = /^[A-Za-z0-9_.-]+$/;

function isName(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && NAME.test(value);
}

function github(owner: string, repo: string, url: string): ParsedSource {
  const repository = `${owner}/${repo}`;
  return {
    provider: "github",
    url,
    repository,
    releasesUrl: `https://api.github.com/repos/${repository}/releases?per_page=${PAGE_SIZE}`,
    archiveUrl: (tag) =>
      `https://api.github.com/repos/${repository}/tarball/${encodeURIComponent(tag)}`,
    isDefault: repository.toLowerCase() === DEFAULT_REPOSITORY,
    isAlpha: repository.toLowerCase() === ALPHA_REPOSITORY,
  };
}

function forgejo(origin: string, prefix: string, owner: string, repo: string): ParsedSource {
  const repository = `${owner}/${repo}`;
  const api = `${origin}${prefix}/api/v1/repos/${repository}`;
  return {
    provider: "forgejo",
    url: `${origin}${prefix}/${repository}`,
    repository,
    releasesUrl: `${api}/releases?limit=${PAGE_SIZE}`,
    archiveUrl: (tag) => `${api}/archive/${encodeURIComponent(tag)}.tar.gz`,
    isDefault: false,
    isAlpha: false,
  };
}

/**
 * A repository URL an administrator types: `https://github.com/owner/repo`, or
 * the address of a Forgejo or Gitea repository, also below a path prefix
 * (`https://git.example.com/forge/owner/repo`). Anything but https is refused
 * because an access token travels with the request.
 */
export function parseRepositoryUrl(input: string): SourceParse {
  const url = safeUrl(input);
  if (!url) {
    return { ok: false, problem: "invalid_url" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, problem: "not_https" };
  }
  if (url.username || url.password) {
    return { ok: false, problem: "credentials_in_url" };
  }
  const segments = trimSlashes(url.pathname).split("/").filter(Boolean);
  const host = url.hostname.toLowerCase();

  if (host === "github.com" || host === "www.github.com") {
    const [owner, rawRepo] = segments;
    const repo = rawRepo === undefined ? undefined : stripGitSuffix(rawRepo);
    if (segments.length < 2 || !isName(owner) || !isName(repo)) {
      return { ok: false, problem: "not_a_repository" };
    }
    return { ok: true, source: github(owner, repo, `https://github.com/${owner}/${repo}`) };
  }

  // An API address pasted instead of the repository page.
  const apiAt = segments.indexOf("api");
  if (apiAt >= 0 && segments[apiAt + 1] === "v1" && segments[apiAt + 2] === "repos") {
    const owner = segments[apiAt + 3];
    const repo = segments[apiAt + 4];
    if (isName(owner) && isName(repo)) {
      const prefix = segments.slice(0, apiAt);
      return {
        ok: true,
        source: forgejo(url.origin, prefix.length ? `/${prefix.join("/")}` : "", owner, repo),
      };
    }
  }

  if (segments.length < 2) {
    return { ok: false, problem: "not_a_repository" };
  }
  const repo = stripGitSuffix(segments[segments.length - 1] ?? "");
  const owner = segments[segments.length - 2];
  if (!isName(owner) || !isName(repo)) {
    return { ok: false, problem: "not_a_repository" };
  }
  const prefix = segments.slice(0, -2);
  return {
    ok: true,
    source: forgejo(url.origin, prefix.length ? `/${prefix.join("/")}` : "", owner, repo),
  };
}

/** The default source. */
export function defaultSource(): ParsedSource {
  const parsed = parseRepositoryUrl(DEFAULT_SOURCE_URL);
  if (!parsed.ok) {
    throw new Error("the default update source is not a valid repository URL");
  }
  return parsed.source;
}

/**
 * The value of `RESTOW_UPDATE_CHECK_URL`: an https address that is either a
 * releases endpoint of a repository (`https://api.github.com/repos/o/r/releases`,
 * `.../releases/latest`, a Forgejo `.../api/v1/repos/o/r/releases`) or any other
 * feed with the same JSON. Anything else leaves the check to the tab.
 */
export function parseEnvironmentSource(value: string | undefined): ParsedSource | null {
  const raw = value?.trim();
  if (!raw) {
    return null;
  }
  const url = safeUrl(raw);
  if (!url || url.protocol !== "https:" || url.username || url.password) {
    return null;
  }
  const segments = trimSlashes(url.pathname).split("/").filter(Boolean);
  if (url.hostname.toLowerCase() === "api.github.com" && segments[0] === "repos") {
    const owner = segments[1];
    const repo = segments[2];
    if (isName(owner) && isName(repo)) {
      const repository = github(owner, repo, `https://github.com/${owner}/${repo}`);
      return { ...repository, releasesUrl: raw };
    }
  }
  const apiAt = segments.indexOf("api");
  if (apiAt >= 0 && segments[apiAt + 1] === "v1" && segments[apiAt + 2] === "repos") {
    const owner = segments[apiAt + 3];
    const repo = segments[apiAt + 4];
    if (isName(owner) && isName(repo)) {
      const prefix = segments.slice(0, apiAt);
      const repository = forgejo(
        url.origin,
        prefix.length ? `/${prefix.join("/")}` : "",
        owner,
        repo,
      );
      return { ...repository, releasesUrl: raw };
    }
  }
  return {
    provider: "feed",
    url: raw,
    repository: null,
    releasesUrl: raw,
    archiveUrl: () => null,
    isDefault: false,
    isAlpha: false,
  };
}

/** The stored repository URL, or the default source when none is stored (or the stored one no longer parses). */
export function sourceFromSettings(storedUrl: string | null): ParsedSource {
  if (storedUrl) {
    const parsed = parseRepositoryUrl(storedUrl);
    if (parsed.ok) {
      return parsed.source;
    }
  }
  return defaultSource();
}

/** Whether a URL is the default source (used to keep the default out of the stored column). */
export function isDefaultSourceUrl(input: string): boolean {
  const parsed = parseRepositoryUrl(input);
  return parsed.ok && parsed.source.isDefault && parsed.source.provider === "github";
}
