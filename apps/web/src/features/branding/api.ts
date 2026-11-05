import { apiFetch } from "@/lib/api";

/**
 * Client of the branding routes (0.5.0, apps/api features/branding): the provider's branding
 * under `/settings/branding` (edition Business, gate `branding.provider`) and a tenant's own
 * under `/tenants/:id/branding` (edition Service Provider, gate `branding.tenant`). The GET
 * routes answer in every edition, so the pages can show the lock.
 */

export interface LogoDto {
  /** The public, unguessable path the instance serves the image under. */
  url: string;
  contentType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  bytes: number;
}

export interface BrandingDto {
  senderName: string | null;
  fromAddress: string | null;
  replyTo: string | null;
  accentColor: string | null;
  onAccent: "light" | "dark" | null;
  footerText: string | null;
  logo: LogoDto | null;
  updatedAt: string | null;
}

/** How the configured mail transport sends, and whether branding may change the From. */
export interface MailSenderFacts {
  transport: "smtp" | "graph" | "google" | null;
  /** Microsoft 365 and Google Workspace always send from the configured mailbox. */
  fromLocked: boolean;
  defaultFrom: string | null;
  allowedSenders: string[];
}

export interface ProviderBrandingView {
  available: { provider: boolean; tenant: boolean; customerReport: boolean };
  productName: string;
  provider: BrandingDto;
  mail: MailSenderFacts;
  publicUrl: string | null;
  publicUrlHttps: boolean;
}

export interface TenantBrandingView {
  available: boolean;
  /** The tenant uses the provider's branding (it has no override). */
  inherits: boolean;
  override: BrandingDto | null;
  /** What the tenant's messages carry right now. */
  effective: BrandingDto;
}

/** The body of PUT /settings/branding and of a tenant's override. */
export interface BrandingInput {
  senderName: string | null;
  fromAddress: string | null;
  replyTo: string | null;
  accentColor: string | null;
  footerText: string | null;
}

export const PREVIEW_KINDS = ["alert", "digest", "summary", "customer"] as const;
export type PreviewKind = (typeof PREVIEW_KINDS)[number];

export interface BrandingPreview {
  subject: string;
  /** The mail's HTML; the logo is referenced by its public path (shown in a sandboxed frame). */
  html: string;
  text: string;
}

const PROVIDER = "/settings/branding";
const tenantBase = (tenantId: string) => `/tenants/${encodeURIComponent(tenantId)}/branding`;

// Installation-wide: no tenant header.
export const fetchProviderBranding = () =>
  apiFetch<ProviderBrandingView>(PROVIDER, { tenantId: null });
export const putProviderBranding = (input: BrandingInput) =>
  apiFetch<BrandingDto>(PROVIDER, { method: "PUT", body: input, tenantId: null });
export const putProviderLogo = (file: Blob) =>
  apiFetch<LogoDto>(`${PROVIDER}/logo`, { method: "PUT", body: file, tenantId: null });
export const deleteProviderLogo = () =>
  apiFetch<void>(`${PROVIDER}/logo`, { method: "DELETE", tenantId: null });

export function previewQuery(kind: PreviewKind, tenantId: string | null, lang: string): string {
  const params = new URLSearchParams({ kind });
  if (tenantId) params.set("tenantId", tenantId);
  if (lang === "de" || lang === "en") params.set("lang", lang);
  return `?${params.toString()}`;
}

export const fetchBrandingPreview = (kind: PreviewKind, tenantId: string | null, lang: string) =>
  apiFetch<BrandingPreview>(`${PROVIDER}/preview${previewQuery(kind, tenantId, lang)}`, {
    tenantId: null,
  });
export const sendBrandingTest = (tenantId: string | null) =>
  apiFetch<{ to: string }>(`${PROVIDER}/test`, {
    method: "POST",
    body: tenantId ? { tenantId } : {},
    tenantId: null,
  });

export const fetchTenantBranding = (tenantId: string) =>
  apiFetch<TenantBrandingView>(tenantBase(tenantId));
export const putTenantBranding = (tenantId: string, input: BrandingInput | { inherit: true }) =>
  apiFetch<TenantBrandingView>(tenantBase(tenantId), { method: "PUT", body: input });
export const putTenantLogo = (tenantId: string, file: Blob) =>
  apiFetch<LogoDto>(`${tenantBase(tenantId)}/logo`, { method: "PUT", body: file });
export const deleteTenantLogo = (tenantId: string) =>
  apiFetch<void>(`${tenantBase(tenantId)}/logo`, { method: "DELETE" });
