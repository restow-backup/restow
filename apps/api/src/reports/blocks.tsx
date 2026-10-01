import { StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReactNode } from "react";
import { pdfText } from "./text.js";
import { type Tone, colors, fontSize, fonts, space, toneColor } from "./theme.js";

/**
 * Building blocks between the frame and the figures: titled sections, a
 * notice for data that is not available (said plainly, never drawn as zero),
 * chart legends and a list of explanatory notes.
 */

const styles = StyleSheet.create({
  section: { marginBottom: space(6) },
  title: { fontFamily: fonts.bold, fontSize: fontSize.heading, marginBottom: space(1) },
  description: { fontSize: fontSize.small, color: colors.muted, marginBottom: space(3) },
  notice: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    backgroundColor: colors.surface,
    paddingVertical: space(2),
    paddingHorizontal: space(3),
  },
  noticeTitle: { fontFamily: fonts.bold },
  legend: { flexDirection: "row", flexWrap: "wrap", marginTop: space(2) },
  legendItem: { flexDirection: "row", alignItems: "center", marginRight: space(4) },
  swatch: { width: 8, height: 8, marginRight: space(1), borderRadius: 1 },
  legendLabel: { fontSize: fontSize.small, color: colors.muted },
  noteTitle: { fontFamily: fonts.bold, fontSize: fontSize.lead, marginBottom: space(2) },
  note: { fontSize: fontSize.small, color: colors.muted, marginBottom: space(1) },
});

export interface SectionProps {
  readonly title: string;
  readonly description?: string;
  /** Keep the section on one page (charts); tables may break across pages. */
  readonly keepTogether?: boolean;
  readonly children: ReactNode;
}

export function Section(props: SectionProps) {
  return (
    <View style={styles.section} wrap={!props.keepTogether} minPresenceAhead={space(20)}>
      <Text style={styles.title} minPresenceAhead={space(10)}>
        {pdfText(props.title)}
      </Text>
      {props.description ? (
        <Text style={styles.description}>{pdfText(props.description)}</Text>
      ) : null}
      {props.children}
    </View>
  );
}

export interface NoticeProps {
  readonly title: string;
  readonly text: string;
  readonly tone?: Tone;
}

/** A plain statement in place of a figure: why there is nothing to show. */
export function Notice(props: NoticeProps) {
  const accent = toneColor[props.tone ?? "neutral"];
  return (
    <View style={[styles.notice, { borderLeftColor: accent }]} wrap={false}>
      <Text>
        <Text style={styles.noticeTitle}>{pdfText(`${props.title}: `)}</Text>
        {pdfText(props.text)}
      </Text>
    </View>
  );
}

export interface LegendEntry {
  readonly label: string;
  readonly color: string;
}

export function Legend(props: { readonly entries: readonly LegendEntry[] }) {
  return (
    <View style={styles.legend}>
      {props.entries.map((entry) => (
        <View key={entry.label} style={styles.legendItem}>
          <View style={[styles.swatch, { backgroundColor: entry.color }]} />
          <Text style={styles.legendLabel}>{pdfText(entry.label)}</Text>
        </View>
      ))}
    </View>
  );
}

export function Notes(props: { readonly title: string; readonly items: readonly string[] }) {
  return (
    <View style={styles.section}>
      <Text style={styles.noteTitle} minPresenceAhead={space(10)}>
        {pdfText(props.title)}
      </Text>
      {props.items.map((item) => (
        <Text key={item} style={styles.note}>
          {pdfText(item)}
        </Text>
      ))}
    </View>
  );
}
