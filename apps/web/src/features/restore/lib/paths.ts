/**
 * Logical paths as the snapshot index stores them: "/"-separated, no leading
 * or trailing slash, "" for the root. Pure helpers shared by the explorer,
 * the search results and the version panel.
 */

export const ROOT_PATH = "";

export function normalizePath(path: string | null | undefined): string {
  return (path ?? "").replace(/^\/+|\/+$/g, "");
}

export function parentPathOf(path: string): string {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? ROOT_PATH : normalized.slice(0, slash);
}

export function baseNameOf(path: string): string {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

export function joinPath(parent: string, name: string): string {
  const base = normalizePath(parent);
  return base.length === 0 ? name : `${base}/${name}`;
}

export interface Crumb {
  name: string;
  path: string;
}

/** "Inbox/Projects" -> [{Inbox}, {Inbox/Projects}] (the root is implicit). */
export function breadcrumbOf(path: string): Crumb[] {
  const normalized = normalizePath(path);
  if (normalized.length === 0) {
    return [];
  }
  const crumbs: Crumb[] = [];
  let current = "";
  for (const name of normalized.split("/")) {
    current = joinPath(current, name);
    crumbs.push({ name, path: current });
  }
  return crumbs;
}

/** True when `path` is `folder` itself or lies below it. */
export function isWithin(path: string, folder: string): boolean {
  const target = normalizePath(path);
  const base = normalizePath(folder);
  if (base.length === 0) {
    return true;
  }
  return target === base || target.startsWith(`${base}/`);
}
