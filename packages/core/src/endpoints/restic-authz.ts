/**
 * Who may do what on an endpoint's restic repository (docs/AGENT.md, security
 * model). The restic REST backend protocol (v2) has these operations:
 *
 *   HEAD/GET  /config                 read the repository config
 *   POST      /config                 write it (once, by `restic init`)
 *   GET       /{type}/                list a type
 *   HEAD/GET  /{type}/{name}          read an object (GET honours `Range`)
 *   POST      /{type}/{name}          write an object
 *   DELETE    /{type}/{name}          delete an object
 *   POST      /?create=true           create the repository (`restic init`)
 *
 * with the types `data`, `keys`, `locks`, `snapshots` and `index`.
 *
 * Two principals exist:
 *
 *   agent        append-only. It reads everything and adds objects that do not
 *                exist yet, nothing more: an existing object is never
 *                overwritten (403), `POST /config` and the repository
 *                creation are refused (the server initialised the repository),
 *                and only the lock files it wrote itself can be deleted
 *                (restic refreshes and releases its own locks that way; the
 *                server records the name of every lock the agent writes).
 *                Another lock, the server's exclusive prune lock among them,
 *                stays. Everything else is 403. A machine that is compromised
 *                can therefore add garbage but cannot destroy or replace a
 *                single backup, nor lift a lock of the server's maintenance.
 *   maintenance  full access. Used by the server itself (retention, check,
 *                downloads, restore tests, `init`) over a loopback listener
 *                that only lives as long as one operation; the credential is
 *                random per session and never leaves the process.
 */

export const RESTIC_TYPES = ["data", "keys", "locks", "snapshots", "index"] as const;
export type ResticType = (typeof RESTIC_TYPES)[number];

export type ResticPrincipal = "agent" | "maintenance";

/** What a request addresses, parsed from its path. */
export type ResticResource =
  | { kind: "repository" }
  | { kind: "config" }
  | { kind: "list"; type: ResticType }
  | { kind: "object"; type: ResticType; name: string };

export type ResticAction = "head" | "read" | "write" | "delete" | "create" | "list";

export type ResticDecision =
  | { allowed: true }
  | { allowed: false; reason: "read_only_type" | "exists" | "not_allowed" | "foreign_lock" };

/** Every object name restic uses is the SHA-256 (hex) of the object's content. */
export const RESTIC_NAME = /^[0-9a-f]{64}$/;

export function isResticType(value: string): value is ResticType {
  return (RESTIC_TYPES as readonly string[]).includes(value);
}

/**
 * The resource a path addresses (relative to the repository root, without a
 * leading slash), or null when it is none restic uses. Names are validated
 * here, so nothing that reaches storage can contain a path separator or `..`.
 */
export function parseResticPath(path: string): ResticResource | null {
  const trimmed = path.replace(/^\/+/, "");
  if (trimmed === "") {
    return { kind: "repository" };
  }
  if (trimmed === "config") {
    return { kind: "config" };
  }
  const parts = trimmed.split("/");
  const type = parts[0] ?? "";
  if (!isResticType(type)) {
    return null;
  }
  if (parts.length === 1 || (parts.length === 2 && parts[1] === "")) {
    return { kind: "list", type };
  }
  if (parts.length === 2) {
    const name = parts[1] as string;
    return RESTIC_NAME.test(name) ? { kind: "object", type, name } : null;
  }
  return null;
}

/** The action a method performs on a resource. */
export function actionOf(method: string, resource: ResticResource): ResticAction | null {
  const verb = method.toUpperCase();
  switch (resource.kind) {
    case "repository":
      return verb === "POST" ? "create" : verb === "DELETE" ? "delete" : null;
    case "config":
      return verb === "HEAD"
        ? "head"
        : verb === "GET"
          ? "read"
          : verb === "POST"
            ? "write"
            : verb === "DELETE"
              ? "delete"
              : null;
    case "list":
      return verb === "GET" ? "list" : null;
    case "object":
      return verb === "HEAD"
        ? "head"
        : verb === "GET"
          ? "read"
          : verb === "POST"
            ? "write"
            : verb === "DELETE"
              ? "delete"
              : null;
  }
}

/**
 * The authorization matrix. `exists` is whether the addressed object is
 * already stored (only asked for writes, see {@link needsExistenceCheck});
 * `ownLock` whether a lock the agent wants to delete is one it wrote (only
 * asked for that, see {@link needsLockOwnership}).
 */
export function authorizeResticAction(
  principal: ResticPrincipal,
  action: ResticAction,
  resource: ResticResource,
  exists: boolean,
  ownLock = false,
): ResticDecision {
  if (principal === "maintenance") {
    return { allowed: true };
  }
  switch (action) {
    case "head":
    case "read":
    case "list":
      return { allowed: true };
    case "write":
      if (resource.kind === "config") {
        return { allowed: false, reason: "read_only_type" };
      }
      return exists ? { allowed: false, reason: "exists" } : { allowed: true };
    case "delete":
      if (resource.kind !== "object" || resource.type !== "locks") {
        return { allowed: false, reason: "not_allowed" };
      }
      return ownLock ? { allowed: true } : { allowed: false, reason: "foreign_lock" };
    case "create":
      return { allowed: false, reason: "not_allowed" };
  }
}

/** Only an append-only principal's write depends on whether the object exists. */
export function needsExistenceCheck(principal: ResticPrincipal, action: ResticAction): boolean {
  return principal === "agent" && action === "write";
}

/** Only an append-only principal's deletion of a lock depends on who wrote the lock. */
export function needsLockOwnership(
  principal: ResticPrincipal,
  action: ResticAction,
  resource: ResticResource,
): boolean {
  return (
    principal === "agent" &&
    action === "delete" &&
    resource.kind === "object" &&
    resource.type === "locks"
  );
}
