import { z } from "zod";

import type { CredentialKind, MicrosoftAppView, SaveMicrosoftAppInput } from "./api";

/**
 * The form of step 4 ("Enter in Restow"). The rules mirror the API
 * (apps/api/src/features/settings/microsoft-app) so problems show up at the
 * field before a request is made; the API stays authoritative (it parses the
 * certificate) and its 422 issues land on the same fields. The secret and the
 * PEM are never prefilled: the browser never receives them.
 */

export interface MicrosoftAppFormValues {
  clientId: string;
  homeTenantId: string;
  credentialKind: CredentialKind;
  clientSecret: string;
  secretExpiresAt: string;
  certificatePem: string;
  authorityHost: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_DOMAIN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Mirrors ENTRA_AUTHORITY_HOSTS in packages/core/src/graph/auth/token.ts,
 * which the API enforces. Kept here as well because the browser bundle does
 * not depend on @restow/core; both copies are held to the same tests.
 */
const ENTRA_AUTHORITY_HOSTS: readonly string[] = [
  "https://login.microsoftonline.com",
  "https://login.microsoftonline.us",
  "https://login.chinacloudapi.cn",
  "https://login.partner.microsoftonline.cn",
];

export function isGuid(value: string): boolean {
  return GUID.test(value.trim());
}

export function isTenantReference(value: string): boolean {
  const tenant = value.trim();
  return GUID.test(tenant) || TENANT_DOMAIN.test(tenant);
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value.trim());
    const bare =
      url.protocol === "https:" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === "";
    return bare && ENTRA_AUTHORITY_HOSTS.includes(url.origin);
  } catch {
    return false;
  }
}

function isDate(value: string): boolean {
  if (!DATE.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** What the form compares against: the credential that is stored, and for which app. */
export interface StoredCredential {
  kind: CredentialKind;
  clientId: string;
  authorityHost: string | null;
  thumbprint: string | null;
}

export function storedCredential(view: MicrosoftAppView): StoredCredential | null {
  if (view.source !== "database" || !view.credential.kind || !view.clientId) {
    return null;
  }
  return {
    kind: view.credential.kind,
    clientId: view.clientId,
    authorityHost: view.authorityHost,
    thumbprint: view.credential.certificate?.thumbprint ?? null,
  };
}

/**
 * The stored secret or certificate is only kept for the app and the login host
 * it was saved for, and only for its own kind (the API enforces the same rule).
 */
export function mayKeepCredential(
  values: Pick<MicrosoftAppFormValues, "clientId" | "authorityHost" | "credentialKind">,
  stored: StoredCredential | null,
): boolean {
  if (!stored || stored.kind !== values.credentialKind) {
    return false;
  }
  const authority = values.authorityHost.trim();
  const origin = authority.length > 0 ? originOf(authority) : null;
  if (authority.length > 0 && origin === null) {
    return false;
  }
  return (
    stored.clientId.toLowerCase() === values.clientId.trim().toLowerCase() &&
    (stored.authorityHost ?? null) === origin
  );
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** What the form's starting point is derived from. */
export type StoredFormSource = Pick<
  MicrosoftAppView,
  "clientId" | "homeTenantId" | "authorityHost" | "credential"
>;

/** The form's starting point for a registration; the credential fields always start empty. */
export function formFromView(view: StoredFormSource): MicrosoftAppFormValues {
  const kind = view.credential.kind ?? "secret";
  return {
    clientId: view.clientId ?? "",
    homeTenantId: view.homeTenantId ?? "",
    credentialKind: kind,
    clientSecret: "",
    secretExpiresAt:
      kind === "secret" && view.credential.expiresAt ? view.credential.expiresAt.slice(0, 10) : "",
    certificatePem: "",
    authorityHost: view.authorityHost ?? "",
  };
}

type Issue = { path: (keyof MicrosoftAppFormValues)[]; message: string };

function credentialIssues(
  values: MicrosoftAppFormValues,
  stored: StoredCredential | null,
): Issue[] {
  const keep = mayKeepCredential(values, stored);
  if (values.credentialKind === "secret") {
    const secret = values.clientSecret.trim();
    if (secret.length === 0) {
      return keep ? [] : [{ path: ["clientSecret"], message: "credentialRequired" }];
    }
    if (isGuid(secret)) {
      return [{ path: ["clientSecret"], message: "secretIsId" }];
    }
    return secret.length > 1024 ? [{ path: ["clientSecret"], message: "tooLong" }] : [];
  }
  const pem = values.certificatePem.trim();
  if (pem.length === 0) {
    return keep ? [] : [{ path: ["certificatePem"], message: "credentialRequired" }];
  }
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(pem)) {
    return [{ path: ["certificatePem"], message: "privateKeyEncrypted" }];
  }
  if (!/-----BEGIN CERTIFICATE-----/.test(pem)) {
    return [{ path: ["certificatePem"], message: "certificateMissing" }];
  }
  if (!/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(pem)) {
    return [{ path: ["certificatePem"], message: "privateKeyMissing" }];
  }
  return pem.length > 64 * 1024 ? [{ path: ["certificatePem"], message: "tooLong" }] : [];
}

export function microsoftAppFormSchema(stored: StoredCredential | null) {
  return z
    .object({
      clientId: z.string(),
      homeTenantId: z.string(),
      credentialKind: z.enum(["secret", "certificate"]),
      clientSecret: z.string(),
      secretExpiresAt: z.string(),
      certificatePem: z.string(),
      authorityHost: z.string(),
    })
    .superRefine((values, ctx) => {
      const issues: Issue[] = [];
      const clientId = values.clientId.trim();
      if (clientId.length === 0) {
        issues.push({ path: ["clientId"], message: "required" });
      } else if (!isGuid(clientId)) {
        issues.push({ path: ["clientId"], message: "guid" });
      }
      const tenant = values.homeTenantId.trim();
      if (tenant.length > 0 && !isTenantReference(tenant)) {
        issues.push({ path: ["homeTenantId"], message: "tenantId" });
      }
      const authority = values.authorityHost.trim();
      if (authority.length > 0 && !isHttpsOrigin(authority)) {
        issues.push({ path: ["authorityHost"], message: "authorityHost" });
      }
      if (
        values.credentialKind === "secret" &&
        values.secretExpiresAt.length > 0 &&
        !isDate(values.secretExpiresAt)
      ) {
        issues.push({ path: ["secretExpiresAt"], message: "date" });
      }
      issues.push(...credentialIssues(values, stored));
      for (const issue of issues) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, ...issue });
      }
    });
}

/** The API payload for validated form values; empty credential fields keep the stored one. */
export function toSaveInput(values: MicrosoftAppFormValues): SaveMicrosoftAppInput {
  const tenant = values.homeTenantId.trim();
  const authority = values.authorityHost.trim();
  const secret = values.clientSecret.trim();
  const pem = values.certificatePem.trim();
  return {
    clientId: values.clientId.trim(),
    homeTenantId: tenant.length > 0 ? tenant : null,
    authorityHost: authority.length > 0 ? authority : null,
    secretExpiresAt:
      values.credentialKind === "secret" && values.secretExpiresAt.length > 0
        ? values.secretExpiresAt
        : null,
    ...(values.credentialKind === "secret" && secret.length > 0 ? { clientSecret: secret } : {}),
    ...(values.credentialKind === "certificate" && pem.length > 0 ? { certificatePem: pem } : {}),
  };
}

/** Paths of the form an API issue can point at. */
export const MICROSOFT_APP_FIELDS: ReadonlySet<keyof MicrosoftAppFormValues> = new Set([
  "clientId",
  "homeTenantId",
  "clientSecret",
  "secretExpiresAt",
  "certificatePem",
  "authorityHost",
]);
