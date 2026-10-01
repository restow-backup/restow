/**
 * Plain text of an HTML document, in linear time and without a parser: the tags go, script,
 * style and head blocks go, entities are decoded, blank lines collapse. For the search text of
 * an imported message and as the fallback of the mail preview (a message whose formatted view
 * could not be prepared in time still shows its text). Every step is linear in the input: the
 * input is a hostile message body.
 *
 * It has its own entry point in the package (`@restow/core/html-text`) so a process that
 * only needs this does not load the rest of the package.
 */

/** Block elements whose content is not text for the reader. */
const SKIPPED_ELEMENTS = ["script", "style", "head"] as const;

/**
 * Take out `<script>`, `<style>` and `<head>` blocks in one linear pass. A block that is
 * never closed stays as it is (its tags are removed like any other tag afterwards).
 */
function removeSkippedBlocks(html: string): string {
  const lower = html.toLowerCase();
  let result = "";
  let position = 0;
  // The next opening tag of each element at or after `position`; -1 once there is none.
  const nextOpen = new Map<string, number>();
  // A closing tag that does not exist after one opening tag does not exist after a later one.
  const noCloseFrom = new Map<string, number>();
  const openingAt = (name: string): number => {
    const known = nextOpen.get(name);
    if (known !== undefined && (known === -1 || known >= position)) {
      return known;
    }
    const found = lower.indexOf(`<${name}`, position);
    nextOpen.set(name, found);
    return found;
  };
  while (position < html.length) {
    let start = -1;
    let element = "";
    for (const name of SKIPPED_ELEMENTS) {
      const found = openingAt(name);
      if (found !== -1 && (start === -1 || found < start)) {
        start = found;
        element = name;
      }
    }
    if (start === -1) {
      break;
    }
    // `<headline>` is not `<head>`: the name must end at a word boundary.
    if (/[a-z0-9]/.test(lower.charAt(start + 1 + element.length))) {
      result += html.slice(position, start + 1);
      position = start + 1;
      continue;
    }
    const missingFrom = noCloseFrom.get(element);
    const close =
      missingFrom !== undefined && missingFrom <= start ? -1 : lower.indexOf(`</${element}`, start);
    if (close === -1) {
      noCloseFrom.set(element, start);
      result += html.slice(position, start + 1);
      position = start + 1;
      continue;
    }
    const end = html.indexOf(">", close);
    result += `${html.slice(position, start)} `;
    position = end === -1 ? html.length : end + 1;
  }
  return result + html.slice(position);
}

/**
 * Remove `<...>` tags in one linear pass, the way `/<[^>]*>/g` does (a `<` inside a tag
 * belongs to it), except that a `<` with no `>` anywhere after it is plain text.
 */
function removeTags(html: string): string {
  let result = "";
  let position = 0;
  while (position < html.length) {
    const open = html.indexOf("<", position);
    if (open === -1) {
      break;
    }
    const close = html.indexOf(">", open + 1);
    if (close === -1) {
      break;
    }
    result += `${html.slice(position, open)} `;
    position = close + 1;
  }
  return result + html.slice(position);
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  euro: "€",
  copy: "©",
  reg: "®",
  hellip: "…",
  ndash: "-",
  mdash: "-",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  laquo: "«",
  raquo: "»",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  aacute: "á",
  ccedil: "ç",
  ntilde: "ñ",
};

/** Decode numeric and the common named HTML entities in one pass (so `&amp;lt;` stays `&lt;`). */
function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,8});/gi,
    (match, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1] === "x" || name[1] === "X"
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : match;
      }
      return NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? match;
    },
  );
}

/** Longest HTML (in characters) the stripper reads unless the caller names another limit. */
export const HTML_TEXT_DEFAULT_LIMIT = 800_000;

/**
 * Crude tag stripper. Reads at most `maxChars` characters of `html` (default
 * {@link HTML_TEXT_DEFAULT_LIMIT}); pass `Number.POSITIVE_INFINITY` for all of it.
 */
export function htmlToPlainText(html: string, maxChars: number = HTML_TEXT_DEFAULT_LIMIT): string {
  const text = decodeEntities(
    removeTags(
      removeSkippedBlocks(html.length > maxChars ? html.slice(0, maxChars) : html).replace(
        /<br\s*\/?>|<\/(p|div|li|tr|h[1-6])\s*>/gi,
        "\n",
      ),
    ),
  ).replace(/[ \t]+/g, " ");
  // Whitespace around line breaks goes and blank lines collapse (a trim per line is linear).
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}
