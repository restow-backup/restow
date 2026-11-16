import { Section } from "./blocks.js";
import { type ReportBrand, ReportDocument, ReportHeader, ReportPage } from "./document.js";
import {
  formatBytes,
  formatDateTime,
  formatInteger,
  formatMonth,
  formatPercent,
  type ReportLanguage,
} from "./format.js";
import { reportTranslator } from "./i18n.js";
import { KpiGrid } from "./kpi.js";
import { renderPdf } from "./render.js";
import { ReportTable } from "./table.js";

/**
 * The customer monthly report (0.5.0, Service Provider; ee/api reports/customer.ts builds its
 * figures): one page for the customer in the provider's (or the tenant's own) brand, in plain
 * language: what is protected, how reliably it was backed up and checked, what was restored, how
 * much is stored, the most frequent causes of failed runs and how many suspicious findings there
 * were. No prices, nothing technical.
 */

export interface CustomerReportFigures {
  readonly objectsByKind: readonly { readonly kind: string; readonly count: number }[];
  readonly backupSuccessRate: number | null;
  readonly verifiedShare: number | null;
  readonly restores: number | null;
  readonly storedBytes: number | null;
  readonly causes: readonly { readonly cause: string; readonly count: number }[];
  readonly suspicious: number;
}

export interface CustomerReportProps {
  readonly language: ReportLanguage;
  readonly tenantName: string;
  /** `YYYY-MM`. */
  readonly month: string;
  readonly figures: CustomerReportFigures;
  readonly brand?: ReportBrand | null;
  readonly generatedAt: Date;
}

export function CustomerReport(props: CustomerReportProps) {
  const t = reportTranslator(props.language);
  const { figures, language } = props;
  const month = formatMonth(`${props.month}-01`, language);
  const title = t("customer.title");
  const subtitle = t("customer.subtitle", { tenant: props.tenantName, month });
  const author = props.brand?.name ?? t("document.author");
  const none = "–";
  const percent = (value: number | null) =>
    value === null ? none : formatPercent(value, language);
  const integer = (value: number | null) =>
    value === null ? none : formatInteger(value, language);
  return (
    <ReportDocument
      title={`${title} - ${subtitle}`}
      author={author}
      subject={subtitle}
      language={language}
      createdAt={props.generatedAt}
    >
      <ReportPage
        footer={`${author} - ${title} - ${formatDateTime(props.generatedAt, language)}`}
        pageLabel={(page, total) => t("document.page", { page, total })}
      >
        <ReportHeader
          brand={props.brand}
          product={t("document.product")}
          title={title}
          subtitle={subtitle}
          meta={[t("customer.period", { month })]}
        />
        <Section title={t("customer.kpis.title")}>
          <KpiGrid
            tiles={[
              {
                label: t("customer.kpis.backupSuccessRate"),
                value: percent(figures.backupSuccessRate),
              },
              { label: t("customer.kpis.verifiedShare"), value: percent(figures.verifiedShare) },
              { label: t("customer.kpis.restores"), value: integer(figures.restores) },
              {
                label: t("customer.kpis.storedBytes"),
                value:
                  figures.storedBytes === null ? none : formatBytes(figures.storedBytes, language),
              },
              { label: t("customer.kpis.suspicious"), value: integer(figures.suspicious) },
            ]}
          />
        </Section>
        <Section title={t("customer.objects.title")}>
          <ReportTable
            columns={[
              {
                header: t("customer.objects.kind"),
                weight: 3,
                cell: (row) => t(`customer.kinds.${row.kind}`),
              },
              {
                header: t("customer.objects.count"),
                weight: 1,
                align: "right",
                cell: (row) => formatInteger(row.count, language),
              },
            ]}
            rows={figures.objectsByKind}
            empty={t("customer.objects.empty")}
            rowKey={(row) => row.kind}
          />
        </Section>
        <Section title={t("customer.incidents.title")}>
          <ReportTable
            columns={[
              { header: t("customer.incidents.cause"), weight: 3, cell: (row) => row.cause },
              {
                header: t("customer.incidents.count"),
                weight: 1,
                align: "right",
                cell: (row) => formatInteger(row.count, language),
              },
            ]}
            rows={figures.causes}
            empty={t("customer.incidents.empty")}
            rowKey={(row, index) => `${row.cause}-${index}`}
          />
        </Section>
      </ReportPage>
    </ReportDocument>
  );
}

/** Render the customer monthly report to PDF bytes. */
export async function renderCustomerReport(props: CustomerReportProps): Promise<Buffer> {
  return renderPdf(<CustomerReport {...props} />);
}
