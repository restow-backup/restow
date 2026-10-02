import { readFileSync, readdirSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PAGE_WIDTH_CONTAINER_CLASS, PAGE_WIDTH_MAIN_CLASS } from "./components/kit/page-context";

/**
 * Data views use the full width of the content area (release 0.2.0, "full
 * width"): no page, table, browser, list or dashboard keeps a `max-w-3xl`-style
 * cap or a `container`. Reading width is for running text, forms, dialogs and
 * wizards, which say so in the allowlist below (dialogs and sheets keep theirs
 * without an entry: their opening tags are not looked at). A new cap in a
 * feature has to be added there with its reason, so it is a decision and not
 * an accident.
 *
 * `max-w-prose` (65ch) is the reading width and always fine; so are caps up to
 * `max-w-lg`, which size a paragraph, a field or an empty state, never a table.
 */

const CAP = /(^|:)max-w-(xl|2xl|3xl|4xl|5xl|6xl|7xl|screen(-[a-z0-9]+)?)$/;
const CONTAINER = /(^|:)container$/;

/** Files (relative to the repo root) that may cap a width, and for which classes. */
const ALLOWED: Record<string, { classes: readonly string[]; reason: string }> = {
  "apps/web/src/features/endpoints/components/settings-tab.tsx": {
    classes: ["max-w-3xl"],
    reason: "settings form of one machine",
  },
  "apps/web/src/features/endpoints/components/danger-zone.tsx": {
    classes: ["max-w-xl"],
    reason: "running text next to a destructive button",
  },
  "apps/web/src/features/tenants/invitation-page.tsx": {
    classes: ["max-w-xl"],
    reason: "invitation form, centred like the sign-in page",
  },
  "apps/web/src/features/stats/components/failures-table.tsx": {
    classes: ["max-w-xl"],
    reason: "the cause column holds prose, which wraps at reading width inside its cell",
  },
  "apps/web/src/routes/not-found.tsx": {
    classes: ["max-w-xl"],
    reason: "error text",
  },
};

const WEB = new URL("./", import.meta.url);
const ROOT = new URL("../../../", import.meta.url);

function sourceFiles(directory: URL): URL[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter(
      (name) =>
        /\.tsx$/.test(name) &&
        !/\.test\.tsx$/.test(name) &&
        !/(^|\/)(dom-harness|testing)(\.tsx|\/)/.test(name) &&
        !name.includes("node_modules"),
    )
    .map((name) => new URL(name, directory));
}

/** Overlays keep a reading width: their opening tags are not looked at. */
const OVERLAY_TAG = /<(AlertDialogContent|DialogContent|SheetContent|DrawerContent)\b/g;

/** The source without the opening tags of dialogs and sheets (attributes may hold `=>` and `{}`). */
function withoutOverlayTags(source: string): string {
  let result = "";
  let cursor = 0;
  for (const match of source.matchAll(OVERLAY_TAG)) {
    const start = match.index ?? 0;
    if (start < cursor) {
      continue;
    }
    let depth = 0;
    let end = start + match[0].length;
    for (; end < source.length; end++) {
      const char = source[end];
      if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
      } else if (char === ">" && depth === 0 && source[end - 1] !== "=") {
        break;
      }
    }
    result += source.slice(cursor, start);
    cursor = end + 1;
  }
  return result + source.slice(cursor);
}

/** Class-like tokens: every whitespace-separated word of every string literal. */
function classTokens(rawSource: string): Set<string> {
  const source = withoutOverlayTags(rawSource);
  const tokens = new Set<string>();
  for (const [, literal] of source.matchAll(/(?:"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`)/g)) {
    for (const word of (literal ?? "").split(/\s+/)) {
      if (word) {
        tokens.add(word);
      }
    }
  }
  return tokens;
}

function pagesToScan(): URL[] {
  return [
    ...sourceFiles(new URL("features/", WEB)),
    ...sourceFiles(new URL("routes/", WEB)),
    ...sourceFiles(new URL("ee/web/src/", ROOT)),
  ];
}

describe("full width for data views", () => {
  it("scans the pages", () => {
    const files = pagesToScan().map((file) => relative(fileURLToPath(ROOT), fileURLToPath(file)));
    expect(files).toContain("apps/web/src/features/endpoints/endpoints-page.tsx");
    expect(files).toContain("apps/web/src/features/verify/verify-page.tsx");
    expect(files).toContain("ee/web/src/audit-log/audit-page.tsx");
  });

  it("keeps no width cap or container on a page, a table, a browser or a list", () => {
    const offenders: string[] = [];
    for (const file of pagesToScan()) {
      const name = relative(fileURLToPath(ROOT), fileURLToPath(file));
      const allowed = ALLOWED[name]?.classes ?? [];
      for (const token of classTokens(readFileSync(file, "utf8"))) {
        if ((CAP.test(token) || CONTAINER.test(token)) && !allowed.includes(token)) {
          offenders.push(`${name}: ${token}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("allows only caps that are still used", () => {
    const stale: string[] = [];
    for (const [name, entry] of Object.entries(ALLOWED)) {
      const tokens = classTokens(readFileSync(new URL(name, ROOT), "utf8"));
      for (const cap of entry.classes) {
        if (!tokens.has(cap)) {
          stale.push(`${name}: ${cap} (${entry.reason})`);
        }
      }
    }
    expect(stale).toEqual([]);
  });

  it("caps the running text above the data views at reading width (65ch), not wider", () => {
    for (const page of ["endpoints/endpoints-page.tsx", "verify/verify-page.tsx"]) {
      const source = readFileSync(new URL(`features/${page}`, WEB), "utf8");
      expect(source).not.toContain("max-w-3xl");
      expect(source).toContain("max-w-prose");
    }
  });

  it("gives the shell's content area the full width by default", () => {
    expect(PAGE_WIDTH_CONTAINER_CLASS.wide).not.toMatch(/max-w-/);
    expect(PAGE_WIDTH_MAIN_CLASS.wide).not.toMatch(/max-w-/);
    expect(PAGE_WIDTH_CONTAINER_CLASS.full).not.toMatch(/max-w-/);
    expect(PAGE_WIDTH_MAIN_CLASS.full).not.toMatch(/max-w-/);
  });

  it("never lets the page body scroll sideways on its own", () => {
    // Wide tables scroll inside their own container (components/ui/table.tsx),
    // which is a scroll container; the shell column must be allowed to shrink
    // below its content so a wide table never widens the page.
    const layout = readFileSync(new URL("routes/app-layout.tsx", WEB), "utf8");
    expect(layout).toMatch(/data-slot="sidebar-inset"[^>]*min-w-0/);
    const table = readFileSync(new URL("components/ui/table.tsx", WEB), "utf8");
    expect(table).toContain("overflow-x-auto");
  });
});
