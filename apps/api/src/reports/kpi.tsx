import { StyleSheet, Text, View } from "@react-pdf/renderer";
import { pdfText } from "./text.js";
import { type Tone, colors, contentWidth, fontSize, fonts, space, toneColor } from "./theme.js";

/**
 * A grid of key figures: label, value, and the change against the previous
 * period in the tone that says whether the change is good news.
 */

export interface KpiTile {
  readonly label: string;
  /** The formatted value, or the "not available" text. */
  readonly value: string;
  /** The formatted change, e.g. "+3 vs. previous period". */
  readonly delta?: string;
  readonly deltaTone?: Tone;
  /** Grey out a value that is not available. */
  readonly muted?: boolean;
}

const GAP = space(2);

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", marginRight: -GAP },
  tile: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 3,
    paddingVertical: space(2),
    paddingHorizontal: space(3),
    marginRight: GAP,
    marginBottom: GAP,
  },
  label: { fontSize: fontSize.small, color: colors.muted, marginBottom: space(1) },
  value: { fontFamily: fonts.bold, fontSize: 14, marginBottom: space(1) },
  delta: { fontSize: fontSize.caption },
});

export function KpiGrid(props: { readonly tiles: readonly KpiTile[]; readonly columns?: number }) {
  const columns = props.columns ?? 3;
  const width = (contentWidth - GAP * (columns - 1)) / columns;
  return (
    <View style={styles.grid} wrap={false}>
      {props.tiles.map((tile) => (
        <View key={tile.label} style={[styles.tile, { width }]}>
          <Text style={styles.label}>{pdfText(tile.label)}</Text>
          <Text style={[styles.value, { color: tile.muted ? colors.subtle : colors.text }]}>
            {pdfText(tile.value)}
          </Text>
          <Text style={[styles.delta, { color: toneColor[tile.deltaTone ?? "neutral"] }]}>
            {pdfText(tile.delta ?? " ")}
          </Text>
        </View>
      ))}
    </View>
  );
}
