import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { DEFAULT_PRODUCT_NAME } from "@restow/i18n";
import type { ReactNode } from "react";
import { pdfText } from "./text.js";
import { colors, fontSize, fonts, page, space } from "./theme.js";

/**
 * The frame of every report: the document with its metadata, A4 pages with
 * the margins of the theme, the title block on the first page and a running
 * footer with the product, the generation time and "page x of y" on every
 * page.
 */

const styles = StyleSheet.create({
  page: {
    paddingTop: page.marginTop,
    paddingBottom: page.marginBottom,
    paddingHorizontal: page.marginX,
    fontFamily: fonts.regular,
    fontSize: fontSize.body,
    color: colors.text,
    backgroundColor: colors.background,
    lineHeight: 1.35,
  },
  header: {
    paddingBottom: space(4),
    marginBottom: space(5),
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  product: {
    fontFamily: fonts.bold,
    fontSize: fontSize.lead,
    color: colors.text,
    marginBottom: space(1),
  },
  // The wordmark's second part: mono, smaller, in the secondary colour.
  productTag: {
    fontFamily: fonts.mono,
    fontSize: fontSize.caption,
    color: colors.muted,
  },
  title: {
    fontFamily: fonts.bold,
    fontSize: fontSize.title,
    lineHeight: 1.2,
    marginBottom: space(2),
  },
  subtitle: { fontSize: fontSize.lead, marginBottom: space(2) },
  meta: { fontSize: fontSize.small, color: colors.muted },
  footer: {
    // Anchored from the top: react-pdf misplaces a bottom-anchored fixed
    // element whose page-number text inherits a line height.
    position: "absolute",
    left: page.marginX,
    right: page.marginX,
    top: page.height - space(10),
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: space(2),
    fontSize: fontSize.caption,
    color: colors.muted,
  },
});

export interface ReportDocumentProps {
  readonly title: string;
  readonly author: string;
  readonly subject?: string;
  readonly language: string;
  readonly createdAt: Date;
  readonly children: ReactNode;
}

export function ReportDocument(props: ReportDocumentProps) {
  return (
    <Document
      title={pdfText(props.title)}
      author={pdfText(props.author)}
      creator={pdfText(props.author)}
      producer={pdfText(props.author)}
      subject={props.subject ? pdfText(props.subject) : undefined}
      language={props.language}
      creationDate={props.createdAt}
      modificationDate={props.createdAt}
    >
      {props.children}
    </Document>
  );
}

export interface ReportPageProps {
  /** Left side of the running footer (product, report, generation time). */
  readonly footer: string;
  /** "Page x of y" in the report's language. */
  readonly pageLabel: (page: number, total: number) => string;
  readonly children: ReactNode;
}

/** A4 pages that wrap their content and repeat the footer on every page. */
export function ReportPage(props: ReportPageProps) {
  return (
    <Page size="A4" style={styles.page} wrap>
      {props.children}
      <View style={styles.footer} fixed>
        <Text>{pdfText(props.footer)}</Text>
        <Text
          render={({ pageNumber, totalPages }) => pdfText(props.pageLabel(pageNumber, totalPages))}
        />
      </View>
    </Page>
  );
}

/**
 * The brand of a report (0.5.0, docs/NOTIFICATIONS.md "Branding"): the logo replaces the
 * wordmark, the accent colours the header rule, the name goes into the footer.
 */
export interface ReportBrand {
  readonly name: string;
  readonly logo?: {
    readonly data: Buffer;
    readonly format: "png" | "jpg";
    readonly width: number;
    readonly height: number;
  };
  /** `#rrggbb`, validated when it was saved. */
  readonly accent?: string | null;
}

export interface ReportHeaderProps {
  /** The product name above the title; the default name is set as the wordmark. */
  readonly product: string;
  readonly title: string;
  readonly subtitle?: string;
  /** Lines of context under the subtitle: period, comparison, generation time. */
  readonly meta?: readonly string[];
  /** The brand; absent keeps the product's wordmark. */
  readonly brand?: ReportBrand | null;
}

/** The size a logo is printed at: at most 160 × 48 points, its aspect ratio kept. */
export function reportLogoSize(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) {
    return { width: 160, height: 48 };
  }
  const scale = Math.min(160 / width, 48 / height);
  return { width: width * scale, height: height * scale };
}

function accentOf(brand: ReportBrand | null | undefined): string | null {
  const accent = brand?.accent;
  return accent && /^#[0-9a-f]{6}$/.test(accent) ? accent : null;
}

/**
 * The line above the title (brand guide, section 3): while the product has its
 * default name, the wordmark "restow" in bold and "backup suite" in the mono
 * face, both lowercase; an operator's own name is printed as written.
 */
function ReportProduct(props: { readonly name: string }) {
  if (props.name !== DEFAULT_PRODUCT_NAME) {
    return <Text style={styles.product}>{pdfText(props.name)}</Text>;
  }
  return (
    <Text style={styles.product}>
      restow<Text style={styles.productTag}> backup suite</Text>
    </Text>
  );
}

export function ReportHeader(props: ReportHeaderProps) {
  const accent = accentOf(props.brand);
  const logo = props.brand?.logo;
  return (
    <View
      style={
        accent
          ? [styles.header, { borderBottomColor: accent, borderBottomWidth: 2 }]
          : styles.header
      }
    >
      {logo ? (
        <Image
          src={{ data: logo.data, format: logo.format }}
          style={{ ...reportLogoSize(logo.width, logo.height), marginBottom: space(2) }}
        />
      ) : props.brand ? (
        <Text style={styles.product}>{pdfText(props.brand.name)}</Text>
      ) : (
        <ReportProduct name={props.product} />
      )}
      <Text style={styles.title}>{pdfText(props.title)}</Text>
      {props.subtitle ? <Text style={styles.subtitle}>{pdfText(props.subtitle)}</Text> : null}
      {(props.meta ?? []).map((line) => (
        <Text key={line} style={styles.meta}>
          {pdfText(line)}
        </Text>
      ))}
    </View>
  );
}
