/**
 * Text that the PDF's built-in fonts can show.
 *
 * Reports use only the PDF standard fonts (Helvetica), so nothing is fetched
 * or embedded. Those fonts cover Windows-1252 (Latin-1 plus a few typographic
 * characters such as the euro sign and dashes); any other character would be
 * drawn as unrelated glyphs. Data in a report (object names, failure causes)
 * can hold anything, so every string is passed through {@link pdfText}:
 * look-alike spaces and minus signs are mapped to their plain forms, accented
 * letters outside the set lose their accent, and whatever still cannot be
 * shown becomes "?" — visibly replaced instead of silently garbled.
 */

/** The characters Windows-1252 places in 0x80-0x9F (the rest of 0xA0-0xFF is Latin-1). */
const CP1252_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/** Replacements by code point, written as numbers so invisible characters stay readable. */
const LOOKALIKES = new Map<string, string>(
  (
    [
      [0x202f, 0x00a0], // narrow no-break space (Intl number formats) -> no-break space
      [0x2009, 0x0020], // thin space
      [0x2007, 0x0020], // figure space
      [0x2212, 0x002d], // minus sign
      [0x2010, 0x002d], // hyphen
      [0x2011, 0x002d], // non-breaking hyphen
      // Letters with a stroke have no decomposition; their base letter is the usual spelling.
      [0x0141, 0x004c], // L with stroke
      [0x0142, 0x006c], // l with stroke
      [0x0110, 0x0044], // D with stroke
      [0x0111, 0x0064], // d with stroke
      [0x0131, 0x0069], // dotless i
    ] as const
  ).map(([from, to]) => [String.fromCodePoint(from), String.fromCodePoint(to)]),
);

const REPLACEMENT = "?";

function isShowable(char: string): boolean {
  const code = char.codePointAt(0) as number;
  return (
    code === 0x0a ||
    (code >= 0x20 && code <= 0x7e) ||
    (code >= 0xa0 && code <= 0xff) ||
    CP1252_EXTRA.has(char)
  );
}

/** Map a string onto the characters the standard PDF fonts can draw. */
export function pdfText(value: string): string {
  let result = "";
  for (const char of value.normalize("NFC")) {
    if (isShowable(char)) {
      result += char;
      continue;
    }
    const lookalike = LOOKALIKES.get(char);
    if (lookalike !== undefined) {
      result += lookalike;
      continue;
    }
    // "ő" -> "o": drop the combining marks when the base letter is showable.
    const base = char.normalize("NFD").replace(/\p{M}/gu, "");
    result += base.length > 0 && [...base].every(isShowable) ? base : REPLACEMENT;
  }
  return result;
}
