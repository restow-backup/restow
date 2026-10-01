import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  type Block,
  type Inline,
  MAX_MARKDOWN_CHARS,
  Markdown,
  parseInline,
  parseMarkdown,
  safeHref,
} from "./markdown";

/**
 * Release notes are somebody else's text. These tests pin what the renderer
 * accepts (the Markdown subset) and, more importantly, what it never lets
 * through: markup, scripts, dangerous links and images.
 */

function html(source: string, headingLevel?: 3 | 4 | 5): string {
  return renderToStaticMarkup(<Markdown source={source} headingLevel={headingLevel} />);
}

/** All the text of a rendered document without tags (entities decoded for the few we produce). */
function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "code":
          return node.value;
        case "break":
          return "\n";
        default:
          return inlineText(node.children);
      }
    })
    .join("");
}

/** Every tag name that appears in rendered markup. */
function tagsOf(markup: string): Set<string> {
  return new Set([...markup.matchAll(/<([a-z][a-z0-9]*)/gi)].map((match) => match[1] ?? ""));
}

/** An event-handler attribute inside a real tag (the same words inside escaped text are harmless). */
const EVENT_ATTRIBUTE = /<[^>]*\son[a-z]+=/i;

/** A link target with a script-capable scheme inside a real tag. */
const DANGEROUS_HREF =
  /<[^>]*\s(?:href|src|action|formaction|data)="\s*(?:javascript|data|vbscript):/i;

const ALLOWED_TAGS = new Set([
  "div",
  "p",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "a",
  "em",
  "strong",
  "del",
  "code",
  "pre",
  "blockquote",
  "hr",
  "br",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);

describe("safeHref", () => {
  it("keeps http, https and mailto, in their normalized form", () => {
    expect(safeHref("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
    expect(safeHref("  http://example.com  ")).toBe("http://example.com/");
    expect(safeHref("mailto:ops@example.com")).toBe("mailto:ops@example.com");
  });

  it("refuses every other scheme, however it is spelled", () => {
    for (const raw of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "jav&#x61;script:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://example.com/x",
      "ftp://example.com/x",
      "tel:+491234",
    ]) {
      expect(safeHref(raw), raw).toBeNull();
    }
  });

  it("refuses relative and protocol-relative addresses and junk", () => {
    for (const raw of [
      "/settings",
      "../x",
      "#anchor",
      "//evil.example/x",
      "page.html",
      "",
      "   ",
    ]) {
      expect(safeHref(raw), raw).toBeNull();
    }
    expect(safeHref(`https://example.com/${"a".repeat(3000)}`)).toBeNull();
  });
});

describe("blocks", () => {
  it("renders headings demoted below the card title", () => {
    const markup = html("# One\n## Two\n### Three\n#### Four\n###### Six");
    expect(markup).toContain("<h4");
    expect(markup).toContain("<h5");
    expect(markup).not.toContain("<h1");
    expect(markup).not.toContain("<h2");
    expect(markup).not.toContain("<h3");
    // Levels three and deeper all end at h6.
    expect(markup.match(/<h6/g)).toHaveLength(3);
  });

  it("lets the caller choose the base level", () => {
    expect(html("# Title", 3)).toContain("<h3");
    expect(html("## Title", 5)).toContain("<h6");
  });

  it("needs a space after the hashes", () => {
    expect(html("#nospace")).toContain("<p");
    expect(html("#nospace")).not.toContain("<h4");
  });

  it("renders paragraphs and joins hard-wrapped lines with a space", () => {
    const markup = html("First line\nsecond line\n\nNext paragraph");
    expect(markup.match(/<p /g)).toHaveLength(2);
    expect(textOf(markup)).toContain("First line second line");
  });

  it("renders a hard break for two trailing spaces and for a backslash", () => {
    expect(html("one  \ntwo")).toContain("<br/>");
    expect(html("one\\\ntwo")).toContain("<br/>");
  });

  it("renders bullet and ordered lists, with the start number", () => {
    const markup = html("- one\n- two\n\n3. three\n4. four");
    expect(markup).toContain("<ul");
    expect(markup).toContain("<ol");
    expect(markup).toContain('start="3"');
    expect(markup.match(/<li/g)).toHaveLength(4);
  });

  it("joins the continuation lines of a list item", () => {
    const blocks = parseMarkdown("- a long item that is\n  wrapped across lines\n- next");
    const list = blocks[0];
    expect(list?.type).toBe("list");
    if (list?.type === "list") {
      expect(list.items).toHaveLength(2);
      const first = list.items[0]?.[0];
      expect(first?.type === "paragraph" && inlineText(first.children)).toBe(
        "a long item that is wrapped across lines",
      );
    }
  });

  it("nests lists one level and deeper", () => {
    const blocks = parseMarkdown("- parent\n  - child one\n  - child two\n- second\n  1. numbered");
    const list = blocks[0] as Extract<Block, { type: "list" }>;
    expect(list.items).toHaveLength(2);
    const nested = list.items[0]?.find((block) => block.type === "list");
    expect(nested?.type === "list" && nested.items).toHaveLength(2);
    const numbered = list.items[1]?.find((block) => block.type === "list");
    expect(numbered?.type === "list" && numbered.ordered).toBe(true);
  });

  it("does not turn a bold line into a list", () => {
    const blocks = parseMarkdown("**Full Changelog**: https://github.com/x/y/compare/a...b");
    expect(blocks[0]?.type).toBe("paragraph");
  });

  it("renders block quotes, also nested", () => {
    const markup = html("> quoted\n> more\n>\n> > deeper");
    expect(markup.match(/<blockquote/g)).toHaveLength(2);
  });

  it("renders a horizontal rule", () => {
    expect(html("above\n\n---\n\nbelow")).toContain("<hr");
    expect(html("***")).toContain("<hr");
  });

  it("renders fenced code verbatim, including markup-looking text", () => {
    const markup = html("```sh\ndocker compose pull\n<script>alert(1)</script>\n```");
    expect(markup).toContain("<pre");
    expect(markup).toContain("docker compose pull");
    expect(markup).not.toContain("<script");
    expect(markup).toContain("&lt;script&gt;");
    // The info string is a data attribute only when it is a plain word.
    expect(markup).toContain('data-language="sh"');
  });

  it("treats an unclosed fence as code up to the end", () => {
    const blocks = parseMarkdown("```\nnever closed\nstill code");
    expect(blocks).toEqual([{ type: "code", language: null, value: "never closed\nstill code" }]);
  });

  it("ignores a hostile info string", () => {
    const blocks = parseMarkdown('```" onmouseover="alert(1)\ncode\n```');
    expect(blocks[0]).toMatchObject({ type: "code", language: null });
  });

  it("renders a table with alignment", () => {
    const markup = html("| Name | Count |\n|:-----|------:|\n| a | 1 |\n| b | 2 |");
    expect(markup).toContain("<table");
    expect(markup).toContain('scope="col"');
    expect(markup.match(/<tr/g)).toHaveLength(3);
    expect(markup).toContain("text-right");
  });

  it("does not make a table out of a line with a pipe", () => {
    expect(html("a | b")).not.toContain("<table");
  });

  it("drops HTML comments, which a reader never sees", () => {
    const markup = html(
      "<!-- Release notes generated using configuration in .github/release.yml -->\nText",
    );
    expect(textOf(markup)).toBe("Text");
  });
});

describe("inline", () => {
  it("renders bold, italic, strikethrough and code", () => {
    const markup = html("**bold** and *italic* and ~~gone~~ and `code`");
    expect(markup).toContain("<strong");
    expect(markup).toContain("<em>italic</em>");
    expect(markup).toContain("<del>gone</del>");
    expect(markup).toContain("<code");
  });

  it("supports underscores only at word boundaries", () => {
    expect(html("_italic_ and __bold__")).toContain("<em>italic</em>");
    expect(html("snake_case_name")).not.toContain("<em>");
  });

  it("nests emphasis", () => {
    const [paragraph] = parseMarkdown("**bold with *italic* inside** and ***both***");
    expect(paragraph?.type).toBe("paragraph");
    const nodes = paragraph?.type === "paragraph" ? paragraph.children : [];
    const strong = nodes.find((node) => node.type === "strong");
    expect(
      strong?.type === "strong" && strong.children.some((node) => node.type === "emphasis"),
    ).toBe(true);
    expect(textOf(html("***both***"))).toBe("both");
    expect(html("***both***")).toMatch(
      /<em><strong[^>]*>both<\/strong><\/em>|<strong[^>]*><em>both<\/em><\/strong>/,
    );
  });

  it("keeps unclosed constructs as literal text", () => {
    expect(textOf(html("**unclosed bold"))).toBe("**unclosed bold");
    expect(textOf(html("*a *b *c"))).toBe("*a *b *c");
    expect(textOf(html("`open code"))).toBe("`open code");
    expect(textOf(html("[unclosed link](https://example.com"))).toBe(
      "[unclosed link](https://example.com",
    );
    expect(textOf(html("~~open"))).toBe("~~open");
    expect(html("**unclosed")).not.toContain("<strong");
  });

  it("does not treat a spaced asterisk as emphasis", () => {
    expect(textOf(html("2 * 3 * 4"))).toBe("2 * 3 * 4");
    expect(html("2 * 3 * 4")).not.toContain("<em>");
  });

  it("honours backslash escapes", () => {
    expect(textOf(html("\\*not italic\\*"))).toBe("*not italic*");
    expect(html("\\*not italic\\*")).not.toContain("<em>");
  });

  it("supports code spans with backticks inside", () => {
    expect(textOf(html("``a ` b``"))).toBe("a ` b");
  });

  it("decodes only a few harmless entities, as text", () => {
    expect(textOf(html("a &amp; b &lt;c&gt;"))).toBe("a & b <c>");
    expect(html("a &lt;b&gt;")).not.toContain("<b>");
  });
});

describe("links", () => {
  it("renders http and https links that open safely in a new tab", () => {
    const markup = html("[the notes](https://example.com/notes)");
    expect(markup).toContain('href="https://example.com/notes"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer nofollow"');
  });

  it("renders mailto links without opening a tab", () => {
    const markup = html("[write us](mailto:ops@example.com)");
    expect(markup).toContain('href="mailto:ops@example.com"');
    expect(markup).not.toContain("target=");
  });

  it("shows the text of a link with a refused address as plain text", () => {
    for (const address of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:x",
      "/relative/path",
      "//evil.example",
    ]) {
      const markup = html(`[click me](${address})`);
      expect(markup, address).not.toContain("<a");
      expect(markup, address).not.toContain("href=");
      expect(textOf(markup), address).toBe("click me");
    }
  });

  it("does not let a tab or newline inside the scheme through", () => {
    for (const source of [
      "[x](java\tscript:alert(1))",
      "[x](java\nscript:alert(1))",
      "[x](<java\tscript:alert(1)>)",
    ]) {
      const markup = html(source);
      expect(markup, JSON.stringify(source)).not.toContain("<a");
      expect(markup, JSON.stringify(source)).not.toContain("href=");
    }
  });

  it("handles a javascript: address hidden behind angle brackets, entities or spaces", () => {
    expect(html("[x](<javascript:alert(1)>)")).not.toContain("<a");
    expect(html("[x]( javascript:alert(1) )")).not.toContain("<a");
    expect(html("[x](javascript&colon;alert(1))")).not.toContain("href=");
  });

  it("keeps parentheses inside an address and drops a title", () => {
    const markup = html('[wiki](https://example.com/a_(b) "the title")');
    expect(markup).toContain('href="https://example.com/a_(b)"');
    expect(markup).not.toContain("the title");
  });

  it("turns bare addresses and angle autolinks into links, without the sentence's punctuation", () => {
    const markup = html(
      "See https://example.com/a. And <https://example.org/b> or (https://example.net/c).",
    );
    expect(markup).toContain('href="https://example.com/a"');
    expect(markup).toContain('href="https://example.org/b"');
    expect(markup).toContain('href="https://example.net/c"');
    expect(textOf(markup)).toBe(
      "See https://example.com/a. And https://example.org/b or (https://example.net/c).",
    );
  });

  it("links an e-mail autolink through mailto", () => {
    expect(html("<ops@example.com>")).toContain('href="mailto:ops@example.com"');
  });

  it("does not nest links", () => {
    const markup = html("[outer [inner](https://a.example) text](https://b.example)");
    expect(markup.match(/<a /g)).toHaveLength(1);
  });

  it("never renders an image: a safe one becomes a link with its alt text", () => {
    const markup = html("![a diagram](https://example.com/diagram.png)");
    expect(markup).not.toContain("<img");
    expect(markup).toContain('href="https://example.com/diagram.png"');
    expect(textOf(markup)).toBe("a diagram");
  });

  it("shows the alt text of an unsafe image as plain text", () => {
    const markup = html("![tracker](data:image/gif;base64,R0lGOD)");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<a");
    expect(textOf(markup)).toBe("tracker");
    expect(html("![](javascript:alert(1))")).not.toContain("href=");
  });
});

describe("raw HTML and script payloads", () => {
  const payloads = [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    '<iframe src="https://evil.example"></iframe>',
    '<a href="javascript:alert(1)">click</a>',
    "<svg onload=alert(1)>",
    "<style>body{display:none}</style>",
    '<object data="x"></object>',
    '<div onclick="alert(1)">x</div>',
    "<details open ontoggle=alert(1)>",
    '<form action="https://evil.example"><input name=password></form>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<base href="https://evil.example/">',
    '<link rel="stylesheet" href="https://evil.example/x.css">',
  ];

  it("shows every payload as literal text and renders no such element", () => {
    for (const payload of payloads) {
      for (const source of [
        payload,
        `text ${payload} text`,
        `- ${payload}`,
        `> ${payload}`,
        `# ${payload}`,
        `**${payload}**`,
        `[${payload}](https://example.com)`,
        `| a |\n|---|\n| ${payload} |`,
      ]) {
        const markup = html(source);
        const tags = tagsOf(markup);
        for (const tag of tags) {
          expect(ALLOWED_TAGS.has(tag), `${tag} rendered for: ${source}`).toBe(true);
        }
        expect(markup.toLowerCase(), source).not.toMatch(
          /<(script|img|iframe|svg|style|object|form|input|meta|base|link|details)\b/,
        );
        expect(markup, source).not.toMatch(EVENT_ATTRIBUTE);
        expect(markup, source).not.toMatch(DANGEROUS_HREF);
      }
    }
    // The text itself stays readable as text.
    expect(textOf(html("<script>alert(1)</script>"))).toBe("<script>alert(1)</script>");
  });

  it("never emits an attribute that the renderer did not put there", () => {
    const markup = html(
      [
        '[x](https://example.com "\\" onmouseover=\\"alert(1)")',
        '[y](https://example.com/"onmouseover="alert(1))',
        '<a href="https://example.com" onclick="alert(1)">z</a>',
      ].join("\n\n"),
    );
    expect(markup).not.toMatch(EVENT_ATTRIBUTE);
  });

  it("escapes quotes in an address so the attribute cannot be broken out of", () => {
    const markup = html('[x](https://example.com/a"onmouseover="alert(1))');
    expect(markup).not.toMatch(EVENT_ATTRIBUTE);
  });
});

describe("robustness", () => {
  it("never throws on odd input", () => {
    for (const source of [
      "",
      " ",
      "\n\n\n",
      "\u0000\u0001\u0002",
      "[[[[[[[[",
      "]]]]]]]]",
      "((((((((",
      "![![![![",
      "[a](",
      "[a](<",
      "***___~~~",
      "|||\n|-|\n|||",
      "> > > > > > > > > > > > >",
      "- - - - - - - - - -",
      "1. 1. 1. 1. 1.",
      "`",
      "``` ```",
      "\\",
      "<",
      "<<<<<>>>>>",
      "&amp",
    ]) {
      expect(() => html(source), JSON.stringify(source)).not.toThrow();
    }
  });

  it("bounds nesting depth of quotes and lists", () => {
    const quotes = `${"> ".repeat(200)}deep`;
    expect(() => html(quotes)).not.toThrow();
    expect(textOf(html(quotes))).toContain("deep");

    const lists = Array.from(
      { length: 200 },
      (_, level) => `${"  ".repeat(level)}- item ${level}`,
    ).join("\n");
    expect(() => html(lists)).not.toThrow();
    // Deep nesting collapses to text instead of an ever deeper tree.
    expect((html(lists).match(/<ul/g) ?? []).length).toBeLessThan(10);
  });

  it("bounds nested emphasis", { timeout: 60_000 }, () => {
    const nested = `${"*a ".repeat(500)}${"a* ".repeat(500)}`;
    expect(() => html(nested)).not.toThrow();
    const brackets = `${"[a".repeat(2000)}${"](https://example.com)".repeat(2000)}`;
    expect(() => html(brackets)).not.toThrow();
  });

  it("handles very long input in reasonable time and cuts it", { timeout: 60_000 }, () => {
    const long = `${"word *emph* `code` [link](https://example.com) https://example.org/x\n".repeat(2000)}`;
    const started = performance.now();
    const markup = html(long);
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(markup.length).toBeGreaterThan(1000);

    const huge = "x".repeat(MAX_MARKDOWN_CHARS * 3);
    expect(textOf(html(huge)).length).toBeLessThanOrEqual(MAX_MARKDOWN_CHARS);
  });

  it("stays fast on delimiter-heavy input", { timeout: 60_000 }, () => {
    const started = performance.now();
    parseMarkdown("*a".repeat(15_000));
    parseMarkdown("_a ".repeat(15_000));
    parseMarkdown("**a ".repeat(10_000));
    parseMarkdown("[a](".repeat(5_000));
    parseMarkdown("`a".repeat(15_000));
    // Generous: the suite also runs on a busy machine; quadratic behaviour would take minutes.
    expect(performance.now() - started).toBeLessThan(30_000);
  });

  it("parses inline fragments on their own", () => {
    expect(inlineText(parseInline("a **b** c"))).toBe("a b c");
  });
});

describe("a realistic release body", () => {
  const body = [
    "<!-- Release notes generated using configuration in .github/release.yml at main -->",
    "",
    "## What's Changed",
    "### Added",
    "* Update check with a daily poll by @maintainer in https://github.com/example/restow/pull/12",
    "* Maintenance banner:",
    "  * shows a live countdown",
    "  * respects reduced motion",
    "### Fixed",
    "1. Rare crash when the **notes** were empty (#14)",
    "",
    "> Upgrade with `docker compose pull && docker compose up -d`.",
    "",
    "**Full Changelog**: https://github.com/example/restow/compare/v0.1.0...v0.2.0",
  ].join("\n");

  it("renders headings, nested lists, quotes and links", () => {
    const markup = html(body);
    expect(markup).toContain("<h5");
    expect(markup).toContain("<h6");
    expect(markup.match(/<ul/g)).toHaveLength(2);
    expect(markup).toContain("<ol");
    expect(markup).toContain("<blockquote");
    expect(markup).toContain('href="https://github.com/example/restow/pull/12"');
    expect(markup).toContain('href="https://github.com/example/restow/compare/v0.1.0...v0.2.0"');
    expect(markup).not.toContain("release.yml");
    expect(textOf(markup)).toContain("shows a live countdown");
  });
});
