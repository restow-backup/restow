/**
 * Which repositories `source` mode may build from (docs/UPDATING.md, "Two modes").
 *
 * `source` mode downloads a repository archive and builds the application image
 * from it on the host's Docker. Whoever chooses that repository chooses the code
 * that runs as the api, the worker and the scheduler, with the database and the
 * master key. It is therefore the operator's decision alone, made in the
 * environment of the host (`RESTOW_UPDATER_SOURCE_HOSTS` in `.env`), never in the
 * web interface: without that variable, `source` mode is off.
 *
 * An entry is a host (`git.example.com`: every repository on it) or a repository
 * (`git.example.com/acme/restow`, `github.com/acme/restow`: that one only).
 * GitHub repositories are named by `github.com`; its API host `api.github.com`
 * means the same. Entries are separated by commas and compared without case.
 *
 * Shared by the updater (which enforces it) and the api (which explains it), so
 * it imports nothing (updater/boundary.test.ts).
 */

export const SOURCE_ALLOWLIST_VARIABLE = "RESTOW_UPDATER_SOURCE_HOSTS";

export interface SourceAllowEntry {
  /** Lowercase host name; GitHub hosts are `github.com`. */
  host: string;
  /** Lowercase `owner/repo`, or null for every repository on the host. */
  repository: string | null;
}

export interface ParsedAllowlist {
  entries: SourceAllowEntry[];
  /** One message per entry that could not be read (the updater refuses to start with any). */
  problems: string[];
}

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const NAME = /^[a-z0-9_.-]{1,100}$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com", "api.github.com"]);

/** The host a repository is named by: GitHub's API and web hosts are one. */
export function canonicalHost(host: string): string {
  const lower = host.trim().toLowerCase().replace(/\.$/, "");
  return GITHUB_HOSTS.has(lower) ? "github.com" : lower;
}

/** Read the value of {@link SOURCE_ALLOWLIST_VARIABLE}. Unset or empty: no entry, `source` mode is off. */
export function parseSourceAllowlist(raw: string | undefined | null): ParsedAllowlist {
  const entries: SourceAllowEntry[] = [];
  const problems: string[] = [];
  for (const item of (raw ?? "").split(",")) {
    const text = item.trim().toLowerCase().replace(/\/+$/, "");
    if (text.length === 0) {
      continue;
    }
    const [host = "", owner, repo, ...rest] = text.split("/");
    const repositoryGiven = owner !== undefined || repo !== undefined;
    if (
      !HOST.test(host) ||
      rest.length > 0 ||
      (repositoryGiven && !(owner && repo && NAME.test(owner) && NAME.test(repo)))
    ) {
      problems.push(
        `"${item.trim()}" is neither a host name nor host/owner/repository (for example git.example.com or github.com/acme/restow)`,
      );
      continue;
    }
    entries.push({
      host: canonicalHost(host),
      repository: repositoryGiven ? `${owner}/${(repo as string).replace(/\.git$/, "")}` : null,
    });
  }
  return { entries, problems };
}

/** An entry as the operator would write it. */
export function formatAllowEntry(entry: SourceAllowEntry): string {
  return entry.repository ? `${entry.host}/${entry.repository}` : entry.host;
}

export interface SourceTarget {
  /** Canonical host (see {@link canonicalHost}). */
  host: string;
  /** Lowercase `owner/repo`, when the URL names one. */
  repository: string | null;
}

/**
 * Host and repository of an archive or releases URL:
 * `https://api.github.com/repos/<owner>/<repo>/...` and
 * `https://<host>[/<prefix>]/api/v1/repos/<owner>/<repo>/...` (Forgejo, Gitea).
 * Null for a URL that cannot be parsed.
 */
export function sourceTargetOf(value: string | URL): SourceTarget | null {
  let url: URL;
  try {
    url = typeof value === "string" ? new URL(value) : value;
  } catch {
    return null;
  }
  const host = canonicalHost(url.hostname);
  const segments = url.pathname.split("/").filter(Boolean);
  let at = -1;
  if (host === "github.com" && segments[0] === "repos") {
    at = 0;
  } else {
    const api = segments.indexOf("api");
    if (api >= 0 && segments[api + 1] === "v1" && segments[api + 2] === "repos") {
      at = api + 2;
    }
  }
  const owner = at >= 0 ? segments[at + 1]?.toLowerCase() : undefined;
  const repo = at >= 0 ? segments[at + 2]?.toLowerCase() : undefined;
  return {
    host,
    repository: owner && repo && NAME.test(owner) && NAME.test(repo) ? `${owner}/${repo}` : null,
  };
}

/** Whether the allowlist names this host and repository. An empty list allows nothing. */
export function isSourceAllowed(
  entries: readonly SourceAllowEntry[],
  target: SourceTarget,
): boolean {
  return entries.some(
    (entry) =>
      entry.host === target.host &&
      (entry.repository === null || entry.repository === target.repository),
  );
}

/** Whether the allowlist names the host at all (for any repository). */
export function isSourceHostListed(entries: readonly SourceAllowEntry[], host: string): boolean {
  const canonical = canonicalHost(host);
  return entries.some((entry) => entry.host === canonical);
}
