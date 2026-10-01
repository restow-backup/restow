import type { SupportedLanguage } from "@restow/i18n";
import type { DbExecutor } from "../../lib/tenant-context.js";
import type { RenderedMessage } from "./render.js";

/**
 * Extension point for summary reports: the core queues and delivers them, an
 * extension (ee/api) builds their content. Without a renderer, or while
 * `reports.timed` is off (lib/features.ts), a summary delivery is recorded as
 * skipped.
 */
export interface ReportSummaryRenderer {
  render(input: {
    /** Tenant-pinned reader for the report's figures. */
    readonly db: DbExecutor;
    readonly tenantId: string;
    readonly tenantName: string;
    readonly ruleName: string;
    readonly language: SupportedLanguage;
    readonly payload: Record<string, unknown>;
    readonly test?: boolean;
  }): Promise<RenderedMessage & { headline: Record<string, unknown> }>;
}

declare module "../../extensions.js" {
  interface FeatureHooks {
    reportSummary: ReportSummaryRenderer;
  }
}
