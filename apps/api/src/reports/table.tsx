import { StyleSheet, Text, View } from "@react-pdf/renderer";
import { pdfText } from "./text.js";
import { type Tone, colors, fontSize, fonts, space, toneColor } from "./theme.js";

/**
 * A data table that may run over several pages: the header row repeats on
 * every page the table continues on, and a row is never split in half.
 */

export interface TableCell {
  readonly text: string;
  readonly tone?: Tone;
}

export interface TableColumn<Row> {
  readonly header: string;
  /** Relative width (flex grow). */
  readonly weight: number;
  readonly align?: "left" | "right";
  readonly cell: (row: Row) => string | TableCell;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: space(1),
  },
  header: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: colors.subtle,
    paddingBottom: space(1),
  },
  headerText: { fontFamily: fonts.bold, fontSize: fontSize.small, color: colors.muted },
  cell: { fontSize: fontSize.small, paddingRight: space(2) },
  empty: { fontSize: fontSize.small, color: colors.muted, paddingVertical: space(2) },
});

export interface ReportTableProps<Row> {
  readonly columns: readonly TableColumn<Row>[];
  readonly rows: readonly Row[];
  /** Shown instead of rows when there are none. */
  readonly empty: string;
  readonly rowKey: (row: Row, index: number) => string;
}

export function ReportTable<Row>(props: ReportTableProps<Row>) {
  const align = (column: TableColumn<Row>) =>
    ({ flex: column.weight, textAlign: column.align ?? "left" }) as const;
  return (
    <View>
      {/* `fixed` inside the table repeats the header on each page the table spans. */}
      <View style={styles.header} fixed>
        {props.columns.map((column) => (
          <Text key={column.header} style={[styles.cell, styles.headerText, align(column)]}>
            {pdfText(column.header)}
          </Text>
        ))}
      </View>
      {props.rows.length === 0 ? (
        <Text style={styles.empty}>{pdfText(props.empty)}</Text>
      ) : (
        props.rows.map((row, index) => (
          <View key={props.rowKey(row, index)} style={styles.row} wrap={false}>
            {props.columns.map((column) => {
              const value = column.cell(row);
              const cell = typeof value === "string" ? { text: value } : value;
              return (
                <Text
                  key={column.header}
                  style={[
                    styles.cell,
                    align(column),
                    cell.tone ? { color: toneColor[cell.tone], fontFamily: fonts.bold } : {},
                  ]}
                >
                  {pdfText(cell.text)}
                </Text>
              );
            })}
          </View>
        ))
      )}
    </View>
  );
}
