/**
 * The Graph application permissions an own app registration needs, in the
 * order the checklist shows them. Mirrors GRAPH_APPLICATION_PERMISSIONS in
 * packages/core/src/entra/permissions.ts (own-app-permissions.test.ts keeps
 * both in step); the web app does not depend on the core package.
 */
export interface OwnAppPermission {
  permission: string;
  required: boolean;
  /** Key under `sources:m365.permissions.purpose`. */
  purpose: string;
}

export const OWN_APP_PERMISSIONS: readonly OwnAppPermission[] = [
  { permission: "Mail.ReadWrite", required: true, purpose: "mail" },
  { permission: "MailboxSettings.Read", required: true, purpose: "mailboxSettings" },
  { permission: "Calendars.ReadWrite", required: true, purpose: "calendar" },
  { permission: "Contacts.ReadWrite", required: true, purpose: "contacts" },
  { permission: "Files.ReadWrite.All", required: true, purpose: "onedrive" },
  { permission: "User.Read.All", required: true, purpose: "users" },
  { permission: "Group.Read.All", required: true, purpose: "groups" },
  { permission: "Directory.Read.All", required: true, purpose: "directory" },
  { permission: "Organization.Read.All", required: true, purpose: "organization" },
  { permission: "Mail.Send", required: false, purpose: "notifications" },
];

/** The token failure hints the API reports (packages/core/src/entra/verify.ts). */
export const OWN_APP_TOKEN_HINTS = [
  "consent_missing",
  "invalid_credentials",
  "credentials_expired",
  "tenant_unknown",
  "unknown",
] as const;

export type OwnAppTokenHint = (typeof OWN_APP_TOKEN_HINTS)[number];

export function ownAppTokenHint(value: unknown): OwnAppTokenHint | null {
  return typeof value === "string" && (OWN_APP_TOKEN_HINTS as readonly string[]).includes(value)
    ? (value as OwnAppTokenHint)
    : null;
}
