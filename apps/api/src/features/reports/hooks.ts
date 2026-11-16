import type { SupportedLanguage } from "@restow/i18n";
import type { DbExecutor } from "../../lib/tenant-context.js";
import type { MailAttachment } from "../../notify.js";
import type { MailBrand, RenderedMessage } from "./render.js";

/**
 * The brand of a PDF report (0.5.0): the logo replaces the wordmark, the accent colours the header
 * rule, the name goes into the footer (apps/api reports/document.tsx).
 */
export interface PdfBrand {
  readonly name: string;
  readonly logo?: {
    readonly data: Buffer;
    readonly format: "png" | "jpg";
    readonly width: number;
    readonly height: number;
  };
  readonly accent?: string | null;
}

/** What a report renderer gets. */
export interface ReportRenderInput {
  /** Tenant-pinned reader for a tenant report's figures; unused for the provider scope. */
  readonly db: DbExecutor;
  /** The installation pool: the tenant list and the installation's own facts. */
  readonly providerDb: DbExecutor;
  /**
   * The tenant pool (Row Level Security applies): the provider report reads each tenant's figures
   * through it, one tenant-pinned transaction per tenant.
   */
  readonly tenantPool: DbExecutor;
  /** A tenant's report, or the provider's across tenants (0.5.0). */
  readonly scope: "tenant" | "provider";
  /** The tenant of a tenant report; null for the provider's. */
  readonly tenantId: string | null;
  readonly tenantName: string;
  readonly ruleName: string;
  readonly language: SupportedLanguage;
  readonly payload: Record<string, unknown>;
  readonly test?: boolean;
  /** The brand of the mail (render.ts); absent sends the unbranded frame. */
  readonly brand?: MailBrand | null;
  /** Attach the PDF statistics report (or the customer report's PDF). */
  readonly attachPdf: boolean;
  /** The brand of the PDF; absent prints the product name. */
  readonly pdfBrand?: PdfBrand | null;
}

export type ReportRenderResult = RenderedMessage & {
  headline: Record<string, unknown>;
  /** Files to attach, e.g. the PDF. */
  attachments?: MailAttachment[];
};

/**
 * Extension point for summary reports: the core queues and delivers them, an
 * extension (ee/api) builds their content. Without a renderer, or while
 * `reports.timed` is off (lib/features.ts), a summary delivery is recorded as
 * skipped.
 */
export interface ReportSummaryRenderer {
  render(input: ReportRenderInput): Promise<ReportRenderResult>;
}

/**
 * Extension point for the customer monthly report (0.5.0, Service Provider): an HTML mail in the
 * tenant's brand and its PDF, for the tenant's contacts. Without a renderer, or while
 * `reports.customer` is off, a customer delivery is recorded as skipped (`not_available`).
 */
export interface CustomerReportRenderer {
  render(input: ReportRenderInput & { readonly month: string }): Promise<ReportRenderResult>;
  /** The PDF alone (the tenant page's preview). */
  pdf(input: ReportRenderInput & { readonly month: string }): Promise<Buffer>;
}

declare module "../../extensions.js" {
  interface FeatureHooks {
    reportSummary: ReportSummaryRenderer;
    reportCustomer: CustomerReportRenderer;
  }
}
