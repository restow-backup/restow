import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A small, safe Markdown renderer for release notes.
 *
 * The notes come from a release page somebody else wrote (a public repository,
 * or a custom one the operator pointed Restow at), so they are treated as
 * untrusted text:
 *
 *  - The output is React elements only. There is no `dangerouslySetInnerHTML`
 *    and no HTML passthrough: raw HTML in the source (tags, `<script>`,
 *    `<img onerror>`, `<iframe>`) is shown as literal text. HTML comments,
 *    which a reader never sees on GitHub either, are dropped.
 *  - Links keep only `http:`, `https:` and `mailto:` (checked on the parsed
 *    URL, so `java\tscript:` and friends do not slip through). Everything else
 *    (`javascript:`, `data:`, `vbscript:`, relative and protocol-relative
 *    links) is shown as plain text. External links open in a new tab with
 *    `rel="noopener noreferrer nofollow"`.
 *  - Images are never loaded (no request leaves the page for a tracking
 *    pixel): an image with a safe address becomes a link showing its alt text.
 *  - Headings are demoted below the card title they sit in.
 *  - Nesting, table size and input length are bounded, so a hostile or huge
 *    document cannot exhaust the stack or the page.
 *
 * The supported subset: ATX headings, paragraphs, bullet and ordered lists
 * (nested), block quotes, fenced code, horizontal rules, GFM tables, inline
 * code, bold, italic, strikethrough, links, autolinks and bare `https://`
 * addresses, backslash escapes and hard line breaks.
 */

// --- Limits ---------------------------------------------------------------------------------

/** Longer sources are cut (the api cuts at 20,000 characters already). */
export const MAX_MARKDOWN_CHARS = 60_000;
const MAX_BLOCK_DEPTH = 6;
const MAX_INLINE_DEPTH = 12;
const MAX_LINK_LENGTH = 2_000;
const MAX_TABLE_COLUMNS = 12;
const MAX_TABLE_ROWS = 200;
/** How far a link text or an emphasis may reach; a hostile run of unclosed brackets costs a bounded scan each. */
const MAX_LINK_TEXT_LENGTH = 1_000;
const MAX_EMPHASIS_SPAN = 1_500;
const MAX_TITLE_LENGTH = 500;

// --- Syntax tree ----------------------------------------------------------------------------

export type Inline =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "emphasis" | "strong" | "strike"; children: Inline[] }
  /** `href` is `null` for a link whose address is not allowed: its text stays, as plain text. */
  | { type: "link"; href: string | null; children: Inline[] }
  | { type: "break" };

export type TableAlign = "left" | "center" | "right" | null;

export type Block =
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; language: string | null; value: string }
  | { type: "quote"; children: Block[] }
  | { type: "rule" }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "table"; align: TableAlign[]; head: Inline[][]; rows: Inline[][][] };

// --- Links ------------------------------------------------------------------------------------

/**
 * The address to link to, or `null` when it may not be linked. Only absolute
 * `http`, `https` and `mailto` addresses pass; the returned string is the
 * parsed, normalized form, never the raw input.
 */
export function safeHref(raw: string): string | null {
  const candidate = raw.trim();
  if (candidate.length === 0 || candidate.length > MAX_LINK_LENGTH) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return parsed.hostname.length > 0 ? parsed.href : null;
  }
  if (parsed.protocol === "mailto:") {
    return parsed.pathname.length > 0 ? parsed.href : null;
  }
  return null;
}

// --- Inline parsing -----------------------------------------------------------------------

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const UNICODE_PUNCTUATION = /[\p{P}\p{S}]/u;

function isWhitespace(character: string): boolean {
  return character === "" || /\s/u.test(character);
}

function isPunctuation(character: string): boolean {
  return (
    character !== "" && (ASCII_PUNCTUATION.test(character) || UNICODE_PUNCTUATION.test(character))
  );
}

/** Flat token stream before emphasis is resolved. */
type Token =
  | { kind: "node"; node: Inline }
  | {
      kind: "delimiter";
      char: "*" | "_" | "~";
      count: number;
      original: number;
      canOpen: boolean;
      canClose: boolean;
    };

function textNode(value: string): Token {
  return { kind: "node", node: { type: "text", value } };
}

/** Index of the `]` that closes the `[` at `start`, skipping escapes, code spans and nested brackets. */
function findClosingBracket(source: string, start: number): number {
  let depth = 0;
  const end = Math.min(source.length, start + MAX_LINK_TEXT_LENGTH);
  for (let index = start; index < end; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** Whitespace by character code (a regular expression per character is too slow for a bounded scan of thousands). */
function isSpaceCode(code: number): boolean {
  return (
    code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0x2028 || code === 0x2029
  );
}

interface Destination {
  href: string;
  end: number;
}

/** Parse `(destination "optional title")` starting at the `(`; returns the address and the index after `)`. */
function parseDestination(source: string, start: number): Destination | null {
  let index = start + 1;
  while (index < source.length && /[ \t\n]/.test(source[index] ?? "")) {
    index += 1;
  }
  let href = "";
  if (source[index] === "<") {
    // The search is bounded, so a run of unclosed `<` does not rescan the whole text each time.
    const window = source.slice(index + 1, index + 2 + MAX_LINK_LENGTH);
    const offset = window.indexOf(">");
    if (offset === -1 || window.slice(0, offset).includes("\n")) {
      return null;
    }
    href = window.slice(0, offset);
    index += offset + 2;
  } else {
    let depth = 0;
    const from = index;
    const limit = Math.min(source.length, index + MAX_LINK_LENGTH + 1);
    while (index < limit) {
      const character = source[index] ?? "";
      if (character === "\\" && index + 1 < source.length) {
        index += 2;
        continue;
      }
      if (isSpaceCode(source.charCodeAt(index))) {
        break;
      }
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        if (depth === 0) {
          break;
        }
        depth -= 1;
      }
      index += 1;
    }
    if (index >= limit && limit < source.length) {
      return null;
    }
    href = source.slice(from, index).replace(/\\([!-/:-@[-`{-~])/g, "$1");
  }
  while (index < source.length && /[ \t\n]/.test(source[index] ?? "")) {
    index += 1;
  }
  // An optional title: "..." , '...' or (...).
  const quote = source[index];
  if (quote === '"' || quote === "'" || quote === "(") {
    const closer = quote === "(" ? ")" : quote;
    let scan = index + 1;
    const titleLimit = Math.min(source.length, index + 1 + MAX_TITLE_LENGTH);
    while (scan < titleLimit && source[scan] !== closer) {
      scan += source[scan] === "\\" ? 2 : 1;
    }
    if (scan >= titleLimit) {
      return null;
    }
    index = scan + 1;
    while (index < source.length && /[ \t\n]/.test(source[index] ?? "")) {
      index += 1;
    }
  }
  return source[index] === ")" ? { href, end: index + 1 } : null;
}

function plainText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "code":
          return node.value;
        case "break":
          return " ";
        default:
          return plainText(node.children);
      }
    })
    .join("");
}

const TRAILING_URL_PUNCTUATION = /[?!.,:*_~'";]$/;

/** Trim what a sentence puts after a bare address (`... see https://x.y/z.`). */
function trimBareUrl(url: string): string {
  let trimmed = url;
  for (;;) {
    if (TRAILING_URL_PUNCTUATION.test(trimmed)) {
      trimmed = trimmed.slice(0, -1);
    } else if (trimmed.endsWith(")")) {
      const opening = (trimmed.match(/\(/g) ?? []).length;
      const closing = (trimmed.match(/\)/g) ?? []).length;
      if (closing > opening) {
        trimmed = trimmed.slice(0, -1);
      } else {
        return trimmed;
      }
    } else {
      return trimmed;
    }
  }
}

function tokenizeInline(source: string, depth: number, insideLink: boolean): Token[] {
  const tokens: Token[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer.length > 0) {
      tokens.push(textNode(buffer));
      buffer = "";
    }
  };

  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";

    if (character === "\\") {
      const next = source[index + 1];
      if (next === "\n") {
        flush();
        tokens.push({ kind: "node", node: { type: "break" } });
        index += 2;
        continue;
      }
      if (next !== undefined && ASCII_PUNCTUATION.test(next)) {
        buffer += next;
        index += 2;
        continue;
      }
      buffer += character;
      index += 1;
      continue;
    }

    if (character === "\n") {
      if (buffer.endsWith("  ")) {
        buffer = buffer.replace(/ +$/, "");
        flush();
        tokens.push({ kind: "node", node: { type: "break" } });
      } else {
        buffer = `${buffer.replace(/ +$/, "")} `;
      }
      index += 1;
      // Leading spaces on the next line carry no meaning.
      while (source[index] === " ") {
        index += 1;
      }
      continue;
    }

    if (character === "`") {
      let run = 1;
      while (source[index + run] === "`") {
        run += 1;
      }
      const fence = "`".repeat(run);
      let search = index + run;
      let close = -1;
      while (search < source.length) {
        const found = source.indexOf(fence, search);
        if (found === -1) {
          break;
        }
        let length = 0;
        while (source[found + length] === "`") {
          length += 1;
        }
        if (length === run) {
          close = found;
          break;
        }
        search = found + length;
      }
      if (close === -1) {
        buffer += fence;
        index += run;
        continue;
      }
      flush();
      let content = source.slice(index + run, close).replace(/\n/g, " ");
      if (
        content.length > 2 &&
        content.startsWith(" ") &&
        content.endsWith(" ") &&
        content.trim()
      ) {
        content = content.slice(1, -1);
      }
      tokens.push({ kind: "node", node: { type: "code", value: content } });
      index = close + run;
      continue;
    }

    if (character === "&") {
      const entity = /^&(?:amp|lt|gt|quot|apos|nbsp|#39);/.exec(source.slice(index, index + 8));
      if (entity) {
        buffer += ENTITIES[entity[0]] ?? entity[0];
        index += entity[0].length;
        continue;
      }
    }

    if (character === "<" && !insideLink) {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/i.exec(
        source.slice(index, index + MAX_LINK_LENGTH + 2),
      );
      if (auto?.[1]) {
        const target = auto[1];
        const href = safeHref(/^(?:https?:|mailto:)/i.test(target) ? target : `mailto:${target}`);
        flush();
        const label: Inline[] = [{ type: "text", value: target }];
        tokens.push({ kind: "node", node: { type: "link", href, children: label } });
        index += auto[0].length;
        continue;
      }
      // Any other `<` starts raw HTML in the source; it stays visible as text.
      buffer += character;
      index += 1;
      continue;
    }

    const isImage = character === "!" && source[index + 1] === "[";
    if ((character === "[" || isImage) && depth < MAX_INLINE_DEPTH) {
      const open = isImage ? index + 1 : index;
      const close = findClosingBracket(source, open);
      if (close !== -1 && source[close + 1] === "(") {
        const destination = parseDestination(source, close + 1);
        if (destination) {
          const label = source.slice(open + 1, close);
          flush();
          if (isImage) {
            // Never load an image: a safe address becomes a link showing the alt text.
            const alt = plainText(resolveEmphasis(tokenizeInline(label, depth + 1, true))) || "";
            const href = safeHref(destination.href);
            const children: Inline[] = [{ type: "text", value: alt || destination.href }];
            tokens.push({ kind: "node", node: { type: "link", href, children } });
          } else if (insideLink) {
            buffer += source.slice(index, destination.end);
          } else {
            const children = resolveEmphasis(tokenizeInline(label, depth + 1, true));
            tokens.push({
              kind: "node",
              node: { type: "link", href: safeHref(destination.href), children },
            });
          }
          index = destination.end;
          continue;
        }
      }
    }

    if (
      !insideLink &&
      (character === "h" || character === "H") &&
      (index === 0 || !/[\p{L}\p{N}]/u.test(source[index - 1] ?? ""))
    ) {
      const bare = /^https?:\/\/[^\s<]+/i.exec(source.slice(index, index + MAX_LINK_LENGTH + 1));
      if (bare) {
        const url = trimBareUrl(bare[0]);
        const href = safeHref(url);
        if (href && url.length > 8) {
          flush();
          tokens.push({
            kind: "node",
            node: { type: "link", href, children: [{ type: "text", value: url }] },
          });
          index += url.length;
          continue;
        }
      }
    }

    if (character === "*" || character === "_" || character === "~") {
      let run = 1;
      while (source[index + run] === character) {
        run += 1;
      }
      const before = index === 0 ? "" : (source[index - 1] ?? "");
      const after = source[index + run] ?? "";
      const leftFlanking =
        !isWhitespace(after) &&
        (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
      const rightFlanking =
        !isWhitespace(before) &&
        (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));
      let canOpen = leftFlanking;
      let canClose = rightFlanking;
      if (character === "_") {
        canOpen = leftFlanking && (!rightFlanking || isPunctuation(before));
        canClose = rightFlanking && (!leftFlanking || isPunctuation(after));
      }
      if (character === "~" && run !== 2) {
        buffer += character.repeat(run);
        index += run;
        continue;
      }
      flush();
      tokens.push({
        kind: "delimiter",
        char: character,
        count: run,
        original: run,
        canOpen,
        canClose,
      });
      index += run;
      continue;
    }

    buffer += character;
    index += 1;
  }
  flush();
  return tokens;
}

/**
 * The CommonMark delimiter-stack algorithm on a flat token list, written as a
 * single pass: settled tokens stay in `out`, which doubles as the stack of
 * possible openers; a run that can close looks back through it for its
 * opener, and the tokens between the two become the emphasis. Nothing before
 * the opener is touched, so the cost stays linear in practice (the look-back
 * is bounded by {@link MAX_EMPHASIS_SPAN}).
 */
function resolveEmphasis(input: Token[]): Inline[] {
  const out: Token[] = [];

  for (const token of input) {
    if (token.kind !== "delimiter") {
      out.push(token);
      continue;
    }
    const closer = { ...token };

    while (closer.canClose && closer.count > 0) {
      let found = -1;
      const lowest = Math.max(0, out.length - MAX_EMPHASIS_SPAN);
      for (let index = out.length - 1; index >= lowest; index -= 1) {
        const candidate = out[index];
        if (
          candidate?.kind === "delimiter" &&
          candidate.char === closer.char &&
          candidate.canOpen &&
          candidate.count > 0
        ) {
          // Rule of three: a run that can both open and close needs matching lengths.
          const oddMatch =
            (candidate.canClose || closer.canOpen) &&
            (candidate.original + closer.original) % 3 === 0 &&
            !(candidate.original % 3 === 0 && closer.original % 3 === 0);
          if (!oddMatch) {
            found = index;
            break;
          }
        }
      }
      if (found === -1) {
        break;
      }

      const opener = out[found] as Extract<Token, { kind: "delimiter" }>;
      const strong = opener.count >= 2 && closer.count >= 2;
      if (closer.char === "~" && !strong) {
        break;
      }
      const use = strong ? 2 : 1;
      const type = closer.char === "~" ? "strike" : strong ? "strong" : "emphasis";
      // Everything between the opener and this closer; delimiters in there that found no partner become text.
      const inner = out.splice(found + 1);
      opener.count -= use;
      closer.count -= use;
      if (opener.count === 0) {
        out.splice(found, 1);
      }
      out.push({ kind: "node", node: { type, children: flatten(inner) } });
    }

    if (closer.count > 0) {
      out.push(closer);
    }
  }

  return flatten(out);
}

/** Turn tokens into nodes: leftover delimiters become literal text; adjacent text merges. */
function flatten(tokens: readonly Token[]): Inline[] {
  const nodes: Inline[] = [];
  const push = (node: Inline) => {
    const last = nodes[nodes.length - 1];
    if (node.type === "text" && last?.type === "text") {
      last.value += node.value;
    } else {
      nodes.push(node);
    }
  };
  for (const token of tokens) {
    if (token.kind === "node") {
      push(token.node.type === "text" ? { type: "text", value: token.node.value } : token.node);
    } else if (token.count > 0) {
      push({ type: "text", value: token.char.repeat(token.count) });
    }
  }
  return nodes;
}

/** Parse the inline Markdown of one block (paragraph, heading, table cell). */
export function parseInline(source: string): Inline[] {
  return resolveEmphasis(tokenizeInline(source, 0, false));
}

// --- Block parsing ------------------------------------------------------------------------------

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*$)/;
const TABLE_DELIMITER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

interface ListMarker {
  indent: number;
  ordered: boolean;
  number: number;
  /** Columns from the line start to the item's text (marker, spaces). */
  contentOffset: number;
  text: string;
}

function listMarker(line: string): ListMarker | null {
  const match = LIST_ITEM.exec(line);
  if (!match) {
    return null;
  }
  const indent = match[1]?.length ?? 0;
  const marker = match[2] ?? "";
  const text = match[3] ?? "";
  const spaces = text.length === 0 ? 1 : line.length - indent - marker.length - text.length;
  const ordered = /\d/.test(marker);
  return {
    indent,
    ordered,
    number: ordered ? Number.parseInt(marker, 10) : 0,
    contentOffset: indent + marker.length + Math.min(Math.max(spaces, 1), 4),
    text,
  };
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) {
    row = row.slice(1);
  }
  if (row.endsWith("|") && !row.endsWith("\\|")) {
    row = row.slice(0, -1);
  }
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index] ?? "";
    if (character === "\\" && row[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function tableAlign(cell: string): TableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

/** Whether a line opens a block that ends a running paragraph. */
function interruptsParagraph(line: string): boolean {
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) {
    return true;
  }
  const marker = listMarker(line);
  return marker !== null && marker.text.length > 0 && (!marker.ordered || marker.number === 1);
}

function isTableStart(lines: readonly string[], index: number): boolean {
  const header = lines[index];
  const delimiter = lines[index + 1];
  if (header === undefined || delimiter === undefined) {
    return false;
  }
  if (!header.includes("|") || !TABLE_DELIMITER.test(delimiter) || !delimiter.includes("-")) {
    return false;
  }
  return splitRow(header).length === splitRow(delimiter).length;
}

function dedent(line: string, columns: number): string {
  let removed = 0;
  while (removed < columns && line[removed] === " ") {
    removed += 1;
  }
  return line.slice(removed);
}

function parseBlocks(lines: readonly string[], depth: number): Block[] {
  const blocks: Block[] = [];

  // Past the nesting limit everything is plain paragraph text.
  if (depth >= MAX_BLOCK_DEPTH) {
    const text = lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");
    return text.length > 0 ? [{ type: "paragraph", children: parseInline(text) }] : [];
  }

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const indent = fence[1]?.length ?? 0;
      const marker = fence[2] ?? "```";
      const language = (fence[3] ?? "").match(/^[\w+#.-]{1,30}$/) ? (fence[3] ?? null) : null;
      const content: string[] = [];
      index += 1;
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(current);
        if (closing?.[1]?.[0] === marker[0] && closing[1].length >= marker.length) {
          index += 1;
          break;
        }
        content.push(dedent(current, indent));
        index += 1;
      }
      blocks.push({ type: "code", language: language || null, value: content.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]?.length ?? 1,
        children: parseInline((heading[2] ?? "").trim()),
      });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (QUOTE.test(current)) {
          inner.push(current.replace(/^ {0,3}> ?/, ""));
        } else if (!isBlank(current) && !interruptsParagraph(current) && inner.length > 0) {
          // Lazy continuation of the quoted paragraph.
          inner.push(current);
        } else {
          break;
        }
        index += 1;
      }
      blocks.push({ type: "quote", children: parseBlocks(inner, depth + 1) });
      continue;
    }

    const first = listMarker(line);
    if (first) {
      const items: Block[][] = [];
      const base = first.indent;
      let current: { marker: ListMarker; lines: string[] } | null = null;
      const closeItem = () => {
        if (current) {
          items.push(parseBlocks(current.lines, depth + 1));
          current = null;
        }
      };

      while (index < lines.length) {
        const text = lines[index] ?? "";
        if (isBlank(text)) {
          // A blank line keeps the list going only when an indented or sibling line follows.
          let next = index + 1;
          while (next < lines.length && isBlank(lines[next] ?? "")) {
            next += 1;
          }
          const following = lines[next];
          const followingMarker = following === undefined ? null : listMarker(following);
          const continues =
            following !== undefined &&
            ((followingMarker !== null &&
              followingMarker.ordered === first.ordered &&
              followingMarker.indent >= base &&
              !RULE.test(following)) ||
              (current !== null &&
                /^ +/.test(following) &&
                following.length - following.trimStart().length >= 2));
          if (!continues) {
            break;
          }
          current?.lines.push("");
          index += 1;
          continue;
        }

        const marker = RULE.test(text) ? null : listMarker(text);
        const open: { marker: ListMarker; lines: string[] } | null = current;
        if (marker && open === null) {
          current = { marker, lines: [marker.text] };
          index += 1;
          continue;
        }
        if (marker && open !== null) {
          if (marker.indent >= open.marker.contentOffset) {
            // A nested item: hand it to the item, dedented to its content column.
            open.lines.push(dedent(text, open.marker.contentOffset));
            index += 1;
            continue;
          }
          if (marker.indent >= base && marker.ordered === first.ordered) {
            closeItem();
            current = { marker, lines: [marker.text] };
            index += 1;
            continue;
          }
          break;
        }
        if (open === null) {
          break;
        }
        const indent = text.length - text.trimStart().length;
        if (indent >= open.marker.contentOffset || (indent >= 2 && indent > base)) {
          open.lines.push(dedent(text, open.marker.contentOffset));
          index += 1;
          continue;
        }
        if (interruptsParagraph(text) || isTableStart(lines, index)) {
          break;
        }
        // Lazy continuation of the item's paragraph.
        open.lines.push(text.trim());
        index += 1;
      }
      closeItem();
      blocks.push({
        type: "list",
        ordered: first.ordered,
        start: first.ordered ? first.number : 1,
        items,
      });
      continue;
    }

    if (isTableStart(lines, index)) {
      const headCells = splitRow(line);
      const columns = Math.min(headCells.length, MAX_TABLE_COLUMNS);
      const align = splitRow(lines[index + 1] ?? "")
        .slice(0, columns)
        .map(tableAlign);
      const rows: Inline[][][] = [];
      index += 2;
      while (index < lines.length && rows.length < MAX_TABLE_ROWS) {
        const rowLine = lines[index] ?? "";
        if (isBlank(rowLine) || !rowLine.includes("|") || interruptsParagraph(rowLine)) {
          break;
        }
        const cells = splitRow(rowLine);
        rows.push(Array.from({ length: columns }, (_, column) => parseInline(cells[column] ?? "")));
        index += 1;
      }
      blocks.push({
        type: "table",
        align,
        head: headCells.slice(0, columns).map((cell) => parseInline(cell)),
        rows,
      });
      continue;
    }

    // A paragraph runs until a blank line or the start of another block.
    // Trailing spaces stay on every line but the last: two of them make a hard break.
    const paragraph: string[] = [line.trimStart()];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (isBlank(next) || interruptsParagraph(next) || isTableStart(lines, index)) {
        break;
      }
      paragraph.push(next.trimStart());
      index += 1;
    }
    blocks.push({
      type: "paragraph",
      children: parseInline(paragraph.join("\n").replace(/\s+$/, "")),
    });
  }

  return blocks;
}

/**
 * Parse Markdown into a syntax tree. Never throws and never yields anything
 * executable: the tree holds text, structure and vetted link targets only.
 */
export function parseMarkdown(source: string): Block[] {
  const bounded = source.length > MAX_MARKDOWN_CHARS ? source.slice(0, MAX_MARKDOWN_CHARS) : source;
  const normalized = bounded
    .replace(/\r\n?/g, "\n")
    .replaceAll("\u0000", "\ufffd")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\t/g, "    ");
  return parseBlocks(normalized.split("\n"), 0);
}

// --- Rendering ------------------------------------------------------------------------------------

const LINK_CLASS =
  "font-medium text-primary underline underline-offset-2 hover:no-underline [overflow-wrap:anywhere]";

function renderInline(nodes: readonly Inline[], depth: number): React.ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${depth}-${index}`;
    if (depth > MAX_INLINE_DEPTH && "children" in node) {
      return <React.Fragment key={key}>{plainText(node.children)}</React.Fragment>;
    }
    switch (node.type) {
      case "text":
        return <React.Fragment key={key}>{node.value}</React.Fragment>;
      case "code":
        return (
          <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
            {node.value}
          </code>
        );
      case "emphasis":
        return <em key={key}>{renderInline(node.children, depth + 1)}</em>;
      case "strong":
        return (
          <strong key={key} className="font-semibold">
            {renderInline(node.children, depth + 1)}
          </strong>
        );
      case "strike":
        return <del key={key}>{renderInline(node.children, depth + 1)}</del>;
      case "break":
        return <br key={key} />;
      case "link": {
        if (node.href === null) {
          return (
            <React.Fragment key={key}>{renderInline(node.children, depth + 1)}</React.Fragment>
          );
        }
        const external = node.href.startsWith("http");
        return (
          <a
            key={key}
            href={node.href}
            className={LINK_CLASS}
            {...(external
              ? { target: "_blank", rel: "noopener noreferrer nofollow" }
              : { rel: "nofollow" })}
          >
            {renderInline(node.children, depth + 1)}
          </a>
        );
      }
    }
  });
}

const HEADING_CLASS = [
  "text-sm font-semibold",
  "text-sm font-semibold",
  "text-xs font-semibold uppercase tracking-wide text-muted-foreground",
] as const;

const ALIGN_CLASS: Record<Exclude<TableAlign, null>, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

function renderBlocks(blocks: readonly Block[], headingBase: number): React.ReactNode[] {
  return blocks.map((block, index) => {
    // A parsed document is static: a block's identity is its position.
    const key = `b${index}`;
    switch (block.type) {
      case "heading": {
        // Demoted: `#` becomes the base level, deeper ones step down to h6.
        const level = Math.min(6, headingBase + block.level - 1);
        const Tag = `h${level}` as "h4";
        const className = HEADING_CLASS[Math.min(block.level, 3) - 1];
        return (
          <Tag key={key} className={className}>
            {renderInline(block.children, 0)}
          </Tag>
        );
      }
      case "paragraph":
        return (
          <p key={key} className="leading-relaxed [overflow-wrap:anywhere]">
            {renderInline(block.children, 0)}
          </p>
        );
      case "code":
        return (
          <pre
            key={key}
            className="overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-xs leading-relaxed"
            data-language={block.language ?? undefined}
          >
            <code>{block.value}</code>
          </pre>
        );
      case "quote":
        return (
          <blockquote
            key={key}
            className="space-y-2 border-l-2 border-border pl-3 text-muted-foreground"
          >
            {renderBlocks(block.children, headingBase)}
          </blockquote>
        );
      case "rule":
        return <hr key={key} className="border-border" />;
      case "list": {
        const Tag = block.ordered ? "ol" : "ul";
        return (
          <Tag
            key={key}
            start={block.ordered && block.start !== 1 ? block.start : undefined}
            className={cn("space-y-1 pl-5", block.ordered ? "list-decimal" : "list-disc")}
          >
            {block.items.map((item, itemIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the tree is static; items have no identity.
              <li key={itemIndex} className="space-y-1 pl-0.5 marker:text-muted-foreground">
                {renderBlocks(item, headingBase)}
              </li>
            ))}
          </Tag>
        );
      }
      case "table":
        return (
          <div key={key} className="overflow-x-auto rounded-md border border-border">
            <table className="w-full border-collapse text-xs">
              <thead className="bg-muted/60">
                <tr>
                  {block.head.map((cell, column) => (
                    <th
                      // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional.
                      key={column}
                      scope="col"
                      className={cn(
                        "border-b border-border px-2 py-1.5 font-semibold",
                        ALIGN_CLASS[block.align[column] ?? "left"],
                      )}
                    >
                      {renderInline(cell, 0)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional.
                  <tr key={rowIndex} className="border-b border-border last:border-0">
                    {row.map((cell, column) => (
                      <td
                        // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional.
                        key={column}
                        className={cn(
                          "px-2 py-1.5 align-top",
                          ALIGN_CLASS[block.align[column] ?? "left"],
                        )}
                      >
                        {renderInline(cell, 0)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export interface MarkdownProps {
  /** Markdown source; untrusted. */
  source: string;
  /**
   * The heading level a `#` becomes (default 4): pass the level below the
   * title of the surrounding card so the notes never outrank it.
   */
  headingLevel?: 3 | 4 | 5;
  className?: string;
}

/** Release notes as safe React elements (see the file comment for the rules). */
export function Markdown({ source, headingLevel = 4, className }: MarkdownProps) {
  const blocks = React.useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className={cn("space-y-3 text-sm", className)} data-slot="markdown">
      {renderBlocks(blocks, headingLevel)}
    </div>
  );
}
