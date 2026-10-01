/**
 * The Graph application permissions the Restow backup app needs in a customer
 * tenant (docs/ENTRA-SETUP.md, part 2; docs/MICROSOFT.md, app registration),
 * and the diff between what a tenant granted and what Restow requires.
 *
 * Granted application permissions show up as the `roles` claim of a
 * client-credentials access token, so the check needs no extra Graph call and
 * no `Application.Read.All`. The classic pitfall — consent with `Mail.Read`
 * instead of `Mail.ReadWrite`, backup works, restore fails with 403 — is
 * reported explicitly as `read_only` rather than as a plain "missing".
 */

/** What Restow uses a permission for; the UI maps it to a translated purpose. */
export type PermissionPurpose =
  | "mail"
  | "mailboxSettings"
  | "calendar"
  | "contacts"
  | "onedrive"
  | "users"
  | "groups"
  | "directory"
  | "organization"
  | "notifications"
  | "signIn";

export interface PermissionRequirement {
  /** Graph application permission, e.g. `Mail.ReadWrite`. */
  permission: string;
  /** Required for backup and restore; optional ones only unlock extras. */
  required: boolean;
  purpose: PermissionPurpose;
  /**
   * Weaker permissions an admin may have granted instead. Any of them present
   * while the real one is absent is the "read-only instead of read-write"
   * pitfall and gets its own state.
   */
  weakerVariants: readonly string[];
}

/** The catalogue, in the order the checklist is shown. */
export const GRAPH_APPLICATION_PERMISSIONS: readonly PermissionRequirement[] = [
  {
    permission: "Mail.ReadWrite",
    required: true,
    purpose: "mail",
    weakerVariants: ["Mail.Read", "Mail.ReadBasic", "Mail.ReadBasic.All"],
  },
  {
    permission: "MailboxSettings.Read",
    required: true,
    purpose: "mailboxSettings",
    weakerVariants: [],
  },
  {
    permission: "Calendars.ReadWrite",
    required: true,
    purpose: "calendar",
    weakerVariants: ["Calendars.Read", "Calendars.ReadBasic.All"],
  },
  {
    permission: "Contacts.ReadWrite",
    required: true,
    purpose: "contacts",
    weakerVariants: ["Contacts.Read"],
  },
  {
    permission: "Files.ReadWrite.All",
    required: true,
    purpose: "onedrive",
    weakerVariants: ["Files.Read.All", "Files.Read", "Files.ReadWrite"],
  },
  {
    permission: "User.Read.All",
    required: true,
    purpose: "users",
    weakerVariants: ["User.ReadBasic.All"],
  },
  { permission: "Group.Read.All", required: true, purpose: "groups", weakerVariants: [] },
  {
    permission: "Directory.Read.All",
    required: true,
    purpose: "directory",
    weakerVariants: [],
  },
  {
    permission: "Organization.Read.All",
    required: true,
    purpose: "organization",
    weakerVariants: [],
  },
  { permission: "Mail.Send", required: false, purpose: "notifications", weakerVariants: [] },
];

/** How a permission is granted on the app registration. */
export type PermissionType = "application" | "delegated";

/** One line of the app registration's permission list (docs/ENTRA-SETUP.md, part 2). */
export interface AppRegistrationPermission {
  permission: string;
  type: PermissionType;
  required: boolean;
  purpose: PermissionPurpose;
}

/**
 * Everything the backup app registration lists under "API permissions",
 * Microsoft Graph: the application permissions above, then the delegated
 * OpenID scopes that only let the consenting admin confirm who they are after
 * the consent (no data access). `Sites.ReadWrite.All` is deliberately absent
 * (SharePoint is not part of v1).
 */
export const APP_REGISTRATION_PERMISSIONS: readonly AppRegistrationPermission[] = [
  ...GRAPH_APPLICATION_PERMISSIONS.map((entry) => ({
    permission: entry.permission,
    type: "application" as const,
    required: entry.required,
    purpose: entry.purpose,
  })),
  { permission: "openid", type: "delegated", required: true, purpose: "signIn" },
  { permission: "profile", type: "delegated", required: true, purpose: "signIn" },
];

/** Names of the permissions Restow cannot work without. */
export const REQUIRED_PERMISSIONS: readonly string[] = GRAPH_APPLICATION_PERMISSIONS.filter(
  (entry) => entry.required,
).map((entry) => entry.permission);

/** Names of the permissions that only unlock optional features. */
export const OPTIONAL_PERMISSIONS: readonly string[] = GRAPH_APPLICATION_PERMISSIONS.filter(
  (entry) => !entry.required,
).map((entry) => entry.permission);

/**
 * `granted`   — the permission is present.
 * `read_only` — absent, but a weaker (read-only) variant was granted instead.
 * `missing`   — absent, nothing similar granted.
 */
export type PermissionState = "granted" | "read_only" | "missing";

export interface PermissionCheck {
  permission: string;
  required: boolean;
  purpose: PermissionPurpose;
  state: PermissionState;
  /** The weaker variant found when `state` is `read_only`. */
  grantedInstead: string | null;
}

export interface PermissionDiff {
  /** One entry per catalogue permission, in catalogue order. */
  checks: PermissionCheck[];
  /** Catalogue permissions that are granted (required and optional). */
  granted: string[];
  /** Required permissions that are not granted (includes the read-only cases). */
  missing: string[];
  /** Read-only pitfalls: which weaker permission stands in for which required one. */
  readOnlyInstead: { expected: string; granted: string }[];
  /** Granted roles Restow did not ask for (shown, never acted on). */
  unexpected: string[];
  /** True when every required permission is granted. */
  complete: boolean;
}

/**
 * Compare the roles a token carries against the catalogue. Role names are
 * compared case-insensitively; Graph reports them in canonical casing but a
 * hand-written list might not.
 */
export function diffPermissions(grantedRoles: readonly string[]): PermissionDiff {
  const granted = new Map<string, string>();
  for (const role of grantedRoles) {
    const trimmed = role.trim();
    if (trimmed.length > 0) {
      granted.set(trimmed.toLowerCase(), trimmed);
    }
  }
  const has = (permission: string) => granted.has(permission.toLowerCase());

  const checks: PermissionCheck[] = GRAPH_APPLICATION_PERMISSIONS.map((entry) => {
    if (has(entry.permission)) {
      return { ...pick(entry), state: "granted", grantedInstead: null };
    }
    const weaker = entry.weakerVariants.find(has);
    if (weaker) {
      return { ...pick(entry), state: "read_only", grantedInstead: weaker };
    }
    return { ...pick(entry), state: "missing", grantedInstead: null };
  });

  const known = new Set(
    GRAPH_APPLICATION_PERMISSIONS.flatMap((entry) => [
      entry.permission.toLowerCase(),
      ...entry.weakerVariants.map((variant) => variant.toLowerCase()),
    ]),
  );
  const unexpected = [...granted.entries()]
    .filter(([key]) => !known.has(key))
    .map(([, original]) => original)
    .sort();

  const missing = checks
    .filter((check) => check.required && check.state !== "granted")
    .map((check) => check.permission);

  return {
    checks,
    granted: checks.filter((check) => check.state === "granted").map((check) => check.permission),
    missing,
    readOnlyInstead: checks
      .filter((check) => check.state === "read_only" && check.grantedInstead !== null)
      .map((check) => ({ expected: check.permission, granted: check.grantedInstead as string })),
    unexpected,
    complete: missing.length === 0,
  };
}

function pick(
  entry: PermissionRequirement,
): Pick<PermissionCheck, "permission" | "required" | "purpose"> {
  return { permission: entry.permission, required: entry.required, purpose: entry.purpose };
}

/**
 * Decode the claims of a JWT without verifying it. The token was just handed
 * to us by Entra over TLS in exchange for our own credentials, so its claims
 * are trusted for *display* purposes (which permissions were granted); nothing
 * is authorized on the basis of this decoding.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2 || parts[1] === undefined || parts[1].length === 0) {
    throw new Error("not a JWT: expected header.payload.signature");
  }
  const json = Buffer.from(parts[1], "base64url").toString("utf8");
  const claims: unknown = JSON.parse(json);
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) {
    throw new Error("not a JWT: payload is not an object");
  }
  return claims as Record<string, unknown>;
}

/** The application permissions (`roles` claim) a client-credentials token carries. */
export function rolesFromAccessToken(token: string): string[] {
  const roles = decodeJwtClaims(token).roles;
  if (!Array.isArray(roles)) {
    return [];
  }
  return roles.filter((role): role is string => typeof role === "string");
}
