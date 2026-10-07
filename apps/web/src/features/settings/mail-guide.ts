/**
 * The language-independent parts of the notification mail guides (Microsoft
 * 365 and Google Workspace): console addresses, the one Gmail scope and the
 * Exchange Online PowerShell commands that restrict the app to the sender
 * mailbox. No visible text lives here; placeholders come in translated.
 */

/** The Microsoft Entra admin center, app registrations list. */
export { ENTRA_ADMIN_CENTER_URL } from "./microsoft-app/presenters";

/** Google Cloud console, the API library (to enable the Gmail API). */
export const GOOGLE_CLOUD_CONSOLE_URL =
  "https://console.cloud.google.com/apis/library/gmail.googleapis.com";

/** Google Admin console, domain-wide delegation. */
export const GOOGLE_ADMIN_CONSOLE_URL = "https://admin.google.com/ac/owl/domainwidedelegation";

/** The only scope the service account is delegated (apps/api notify-google.ts). */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

/** Names the commands give the Exchange objects; neutral, without the product name. */
const SCOPE_NAME = "Notification mail sender";

export interface RestrictCommandValues {
  clientId: string;
  sender: string;
  /** Translated placeholders for values the form does not have yet. */
  placeholders: { clientId: string; objectId: string; sender: string; group: string };
}

/** A value for a PowerShell single-quoted string (a quote is doubled). */
function quoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function valueOr(value: string, placeholder: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : placeholder;
}

/**
 * Exchange Online RBAC for Applications: a management scope for exactly the
 * sender mailbox and the `Application Mail.Send` role assigned to the app
 * within it, then the check.
 */
export function rbacCommands(values: RestrictCommandValues): string {
  const clientId = valueOr(values.clientId, values.placeholders.clientId);
  const sender = valueOr(values.sender, values.placeholders.sender);
  const filter = `PrimarySmtpAddress -eq ${quoted(sender)}`;
  return [
    "Connect-ExchangeOnline",
    `New-ServicePrincipal -AppId ${quoted(clientId)} -ObjectId ${quoted(values.placeholders.objectId)} -DisplayName ${quoted(SCOPE_NAME)}`,
    `New-ManagementScope -Name ${quoted(SCOPE_NAME)} -RecipientRestrictionFilter "${filter}"`,
    `New-ManagementRoleAssignment -App ${quoted(clientId)} -Role 'Application Mail.Send' -CustomResourceScope ${quoted(SCOPE_NAME)}`,
    `Test-ServicePrincipalAuthorization -Identity ${quoted(clientId)} -Resource ${quoted(sender)}`,
  ].join("\n");
}

/**
 * The older Application Access Policy: the app may only reach the members of
 * a mail-enabled security group that holds the sender mailbox.
 */
export function accessPolicyCommands(values: RestrictCommandValues): string {
  const clientId = valueOr(values.clientId, values.placeholders.clientId);
  const sender = valueOr(values.sender, values.placeholders.sender);
  return [
    "Connect-ExchangeOnline",
    `New-ApplicationAccessPolicy -AppId ${quoted(clientId)} -PolicyScopeGroupId ${quoted(values.placeholders.group)} -AccessRight RestrictAccess -Description ${quoted(SCOPE_NAME)}`,
    `Test-ApplicationAccessPolicy -Identity ${quoted(sender)} -AppId ${quoted(clientId)}`,
  ].join("\n");
}
