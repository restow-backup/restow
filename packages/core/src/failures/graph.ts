/**
 * Classification of Microsoft errors: answers of Microsoft Graph and refusals
 * of the Entra token endpoint.
 *
 * Graph names the problem in `error.code` (`ErrorAccessDenied`,
 * `MailboxNotEnabledForRESTAPI`, `Authorization_RequestDenied`, ...) but never
 * says which application permission is missing; the URL of the failed request
 * does, because each Graph resource needs one known permission
 * (docs/MICROSOFT.md, `GRAPH_APPLICATION_PERMISSIONS`). The permission named
 * here is therefore the one the request needs, not proof that it is absent.
 */
import type { TokenAcquisitionError } from "../graph/auth/token.js";
import type { GraphError } from "../graph/errors.js";
import { redactSensitiveText, redactedPath } from "./redact.js";
import type { FailureCause, FailureParams, FailureTechnical } from "./types.js";

/** What a Graph URL is about; picks the permission and the wording. */
export type GraphResource =
  | "mail"
  | "calendar"
  | "contacts"
  | "onedrive"
  | "users"
  | "groups"
  | "directory"
  | "organization"
  | "other";

interface GraphResourceInfo {
  readonly resource: GraphResource;
  /** The application permission this kind of request needs. */
  readonly permission: string | null;
}

const RESOURCE_TABLE: readonly (readonly [RegExp, GraphResourceInfo])[] = [
  [
    /\/mailfolders|\/messages|\/inferenceclassification|\/mail\b/i,
    { resource: "mail", permission: "Mail.ReadWrite" },
  ],
  [
    /\/calendars?\b|\/events\b|\/calendargroups|\/calendarview/i,
    { resource: "calendar", permission: "Calendars.ReadWrite" },
  ],
  [/\/contactfolders|\/contacts\b/i, { resource: "contacts", permission: "Contacts.ReadWrite" }],
  [/\/drives?\b|\/items\/|\/root\b/i, { resource: "onedrive", permission: "Files.ReadWrite.All" }],
  [/\/mailboxsettings/i, { resource: "mail", permission: "MailboxSettings.Read" }],
  [/\/groups\b/i, { resource: "groups", permission: "Group.Read.All" }],
  [
    /\/directory\/|\/directoryroles|\/roletemplates/i,
    { resource: "directory", permission: "Directory.Read.All" },
  ],
  [
    /\/organization\b|\/subscribedskus/i,
    { resource: "organization", permission: "Organization.Read.All" },
  ],
  [/\/users\b/i, { resource: "users", permission: "User.Read.All" }],
];

/** The resource and required permission of a Graph request path. */
export function graphResourceOf(url: string): GraphResourceInfo {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // A relative path is fine as it is.
  }
  const cut = path.search(/[?#]/);
  const bare = cut === -1 ? path : path.slice(0, cut);
  const segments = bare.split("/").filter((segment) => segment.length > 0);
  if (/^v\d+\.\d+$/i.test(segments[0] ?? "")) {
    segments.shift();
  }
  let tail = segments;
  if (segments[0]?.toLowerCase() === "users") {
    // /users, /users/delta and /users/{id} are the directory; /users/{id}/{rest} is what {rest} is.
    tail = segments.length <= 2 || segments[1]?.toLowerCase() === "delta" ? [] : segments.slice(2);
    if (tail.length === 0) {
      return { resource: "users", permission: "User.Read.All" };
    }
  }
  const relative = `/${tail.join("/")}`;
  for (const [pattern, info] of RESOURCE_TABLE) {
    if (pattern.test(relative)) {
      return info;
    }
  }
  return { resource: "other", permission: null };
}

const NOT_ENABLED_CODES = new Set([
  "mailboxnotenabledforrestapi",
  "errormailboxnotenabledforrestapi",
  "mailboxnothostedinexchangeonline",
  "errormailboxnothostedinexchangeonline",
  "mailboxnotsupportedforrestapi",
]);
const USER_MISSING_CODES = new Set([
  "errorinvaliduser",
  "errornonexistentmailbox",
  "request_resourcenotfound",
  "errorinvalidmailboxitemid",
]);
const THROTTLE_CODES = new Set([
  "toomanyrequests",
  "applicationthrottled",
  "mailboxconcurrency",
  "activitylimitreached",
  "errorexceededmessagelimit",
  "errortoomanyobjectsopened",
  "errorexceededconnectioncount",
  "throttled",
]);
const SERVICE_CODES = new Set([
  "servicenotavailable",
  "errorserverbusy",
  "errortimeoutexpired",
  "errorinternalservererror",
  "generalexception",
  "mailboxserverbusy",
  "serviceunavailable",
  "gatewaytimeout",
  "internalservererror",
  "timeout",
]);
const TOO_LARGE_CODES = new Set([
  "errormessagesizeexceeded",
  "erroritemtoolarge",
  "payloadtoolarge",
  "errorfiletoolarge",
  "requestentitytoolarge",
]);
const CORRUPT_CODES = new Set([
  "errorcorruptdata",
  "erroritemcorrupt",
  "errorinvalidmimecontent",
  "errormimecontentinvalid",
  "errormimecontentinvalidbase64string",
  "errorinvalidproperty",
]);
const QUOTA_CODES = new Set([
  "errorquotaexceeded",
  "quotalimitreached",
  "errormailboxstoragelimitexceeded",
  "insufficientstorage",
  "errorquotaexceededonmailbox",
]);
const ITEM_NOT_FOUND_CODES = new Set([
  "erroritemnotfound",
  "errorfoldernotfound",
  "itemnotfound",
  "errorinvalididmalformed",
  "errorattachmentnotfound",
  "erroritemnotfoundinfolder",
]);
const NOT_FOUND_CODES = new Set([
  "itemnotfound",
  "resourcenotfound",
  "notfound",
  "request_resourcenotfound",
  "errorinvaliduser",
  "errornonexistentmailbox",
]);

function lower(value: string | undefined): string {
  return value ? value.toLowerCase() : "";
}

function hasCode(error: GraphError, set: ReadonlySet<string>): boolean {
  return set.has(lower(error.code)) || set.has(lower(error.innerCode));
}

/** Seconds Graph asked to wait, from `Retry-After`, when it said. */
function retryAfterSeconds(error: GraphError): number | null {
  const ms = error.retryAfterMs;
  return ms === null ? null : Math.ceil(ms / 1000);
}

/** Technical details of a Graph error, redacted (no query string, no token). */
export function graphTechnical(error: GraphError): FailureTechnical {
  const technical: FailureTechnical = { httpStatus: error.status };
  if (error.code) {
    technical.errorCode = redactSensitiveText(error.code, 120);
  }
  if (error.innerCode) {
    technical.innerErrorCode = redactSensitiveText(error.innerCode, 120);
  }
  if (error.requestId) {
    technical.requestId = redactSensitiveText(error.requestId, 80);
  }
  if (error.clientRequestId) {
    technical.clientRequestId = redactSensitiveText(error.clientRequestId, 80);
  }
  if (error.errorDate) {
    technical.serverDate = redactSensitiveText(error.errorDate, 60);
  }
  technical.endpoint = `${error.method} ${redactedPath(error.url)}`;
  if (error.graphMessage) {
    technical.message = redactSensitiveText(error.graphMessage);
  }
  return technical;
}

function cause(
  code: FailureCause["code"],
  transient: boolean,
  params: FailureParams,
  technical: FailureTechnical,
): FailureCause {
  return { code, transient, params, technical };
}

/** Classify a failed Graph call. */
export function classifyGraphError(error: GraphError): FailureCause {
  const technical = graphTechnical(error);
  const { resource, permission } = graphResourceOf(error.url);
  const base: FailureParams = { httpStatus: error.status, resource };
  if (error.code) {
    base.graphCode = redactSensitiveText(error.code, 120);
  }
  const withPermission: FailureParams = permission ? { ...base, permission } : base;

  // Mailbox-level answers first: they can come with 403, 404 or 400.
  if (hasCode(error, NOT_ENABLED_CODES)) {
    const onPremises = /hosted/i.test(`${error.code ?? ""}${error.innerCode ?? ""}`);
    return cause(
      "graph.mailbox_not_licensed",
      false,
      { ...base, reason: onPremises ? "not_in_exchange_online" : "not_enabled" },
      technical,
    );
  }
  if (hasCode(error, THROTTLE_CODES) || error.status === 429) {
    const seconds = retryAfterSeconds(error);
    return cause(
      "graph.throttled",
      true,
      seconds === null ? base : { ...base, retryAfterSeconds: seconds },
      technical,
    );
  }
  if (error.status === 401) {
    return cause("graph.token_rejected", true, base, technical);
  }
  if (error.status === 403) {
    if (
      lower(error.code) === "authorization_requestdenied" ||
      /insufficient privileges/i.test(error.graphMessage ?? "")
    ) {
      return cause("graph.permission_missing", false, withPermission, technical);
    }
    return cause("graph.access_denied", false, withPermission, technical);
  }
  if (error.status === 404 || /spo license/i.test(error.graphMessage ?? "")) {
    if (hasCode(error, ITEM_NOT_FOUND_CODES)) {
      // Deleted or moved between listing and reading; the next run sees the new state.
      return cause("graph.item_not_found", true, base, technical);
    }
    if (
      resource === "onedrive" &&
      (hasCode(error, NOT_FOUND_CODES) ||
        /spo license|not been provisioned/i.test(error.graphMessage ?? ""))
    ) {
      return cause("graph.onedrive_unavailable", false, base, technical);
    }
    if (
      hasCode(error, USER_MISSING_CODES) ||
      (resource === "users" && hasCode(error, NOT_FOUND_CODES))
    ) {
      return cause("graph.user_not_found", false, base, technical);
    }
    if (resource === "mail" || resource === "calendar" || resource === "contacts") {
      if (hasCode(error, NOT_FOUND_CODES)) {
        return cause("graph.user_not_found", false, base, technical);
      }
    }
  }
  if (hasCode(error, USER_MISSING_CODES)) {
    return cause("graph.user_not_found", false, base, technical);
  }
  if (error.status === 410) {
    return cause("graph.delta_expired", true, base, technical);
  }
  if (error.status === 413 || hasCode(error, TOO_LARGE_CODES)) {
    return cause("graph.item_too_large", false, base, technical);
  }
  if (error.status === 507 || hasCode(error, QUOTA_CODES)) {
    return cause("graph.quota_exceeded", false, base, technical);
  }
  if (hasCode(error, CORRUPT_CODES)) {
    return cause("graph.item_unreadable", false, base, technical);
  }
  if (error.status >= 500 || hasCode(error, SERVICE_CODES)) {
    return cause("graph.service_unavailable", true, base, technical);
  }
  return cause("graph.request_rejected", false, base, technical);
}

const CONSENT_AADSTS = new Set(["AADSTS65001", "AADSTS500011", "AADSTS700016", "AADSTS7000112"]);
const CREDENTIAL_AADSTS: Readonly<Record<string, string>> = {
  AADSTS7000215: "invalid_secret",
  AADSTS7000222: "secret_expired",
  AADSTS7000218: "credential_missing",
  AADSTS700027: "invalid_certificate",
  AADSTS700025: "invalid_secret",
  AADSTS7000216: "credential_missing",
  AADSTS700024: "invalid_certificate",
};
const TENANT_AADSTS = new Set(["AADSTS90002", "AADSTS900023", "AADSTS90019", "AADSTS50020"]);

/** Classify a refusal of the Entra token endpoint. */
export function classifyTokenError(error: TokenAcquisitionError): FailureCause {
  const aadsts = /AADSTS\d+/.exec(error.message)?.[0] ?? null;
  const technical: FailureTechnical = {};
  if (error.status !== undefined) {
    technical.httpStatus = error.status;
  }
  if (error.code) {
    technical.errorCode = redactSensitiveText(error.code, 120);
  }
  if (aadsts) {
    technical.aadsts = aadsts;
  }
  if (error.correlationId) {
    technical.correlationId = redactSensitiveText(error.correlationId, 80);
  }
  technical.message = redactSensitiveText(error.message);
  const params: FailureParams = {};
  if (aadsts) {
    params.aadsts = aadsts;
  }
  if (error.status !== undefined) {
    params.httpStatus = error.status;
  }

  if (aadsts && CONSENT_AADSTS.has(aadsts)) {
    return cause("graph.consent_missing", false, params, technical);
  }
  const credentialReason = aadsts ? CREDENTIAL_AADSTS[aadsts] : undefined;
  if (credentialReason || error.code === "invalid_client") {
    return cause(
      "graph.app_credentials_invalid",
      false,
      { ...params, reason: credentialReason ?? "invalid_client" },
      technical,
    );
  }
  if (aadsts && TENANT_AADSTS.has(aadsts)) {
    return cause("graph.tenant_not_found", false, params, technical);
  }
  if (error.status === 429) {
    return cause("graph.throttled", true, params, technical);
  }
  if (error.status !== undefined && error.status >= 500) {
    return cause("graph.service_unavailable", true, params, technical);
  }
  return cause("graph.token_rejected", false, params, technical);
}
