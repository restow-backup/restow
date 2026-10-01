// @vitest-environment happy-dom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_WIDTH,
  PAGE_WIDTH_CONTAINER_CLASS,
  PAGE_WIDTH_MAIN_CLASS,
  PageMain,
  PageProvider,
  type PageWidth,
  pageContentWrapperClass,
  usePageWidth,
  usePageWidthValue,
} from "./page-context.js";
import { render } from "./test-utils.js";

/**
 * Two kinds of tests share this file:
 *
 * - The renderer-independent ones (`render`, from test-utils.js, is
 *   `renderToStaticMarkup`) cover the default every page starts at, the
 *   class tables the shell resolves that default (or a page's opt-in)
 *   against, and `pageContentWrapperClass` — none of it needs a DOM.
 * - The "PageMain (DOM)" tests below need a real one: `usePageWidth` only
 *   takes effect through a `useLayoutEffect`, so proving the full contract —
 *   one hook call switches `PageMain`'s rendered `<main>` to `full`'s class,
 *   and unmounting the caller restores the default — means mounting,
 *   swapping and unmounting actual components, not just reading markup from
 *   a single pass. `@vitest-environment happy-dom` (top of file) switches
 *   this file's environment; the plain tests above are unaffected by it.
 */

// React only batches and flushes effects synchronously inside `act` when it
// knows it is running under a test renderer; nothing else sets this flag for
// us in this workspace (no React Testing Library, no global test setup
// file), and the "PageMain (DOM)" tests below need it for `usePageWidth`'s
// `useLayoutEffect` to run inside `act`.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WIDTHS: readonly PageWidth[] = ["wide", "readable", "full"];

function WidthProbe() {
  return <output>{usePageWidthValue()}</output>;
}

describe("page width default", () => {
  it("is wide: the data-heavy default every page starts at", () => {
    expect(DEFAULT_PAGE_WIDTH).toBe("wide");
  });

  it("is what usePageWidthValue reports outside a provider", () => {
    expect(render(<WidthProbe />)).toContain(">wide<");
  });

  it("is what usePageWidthValue reports for a page that never opts in", () => {
    const html = render(
      <PageProvider>
        <WidthProbe />
      </PageProvider>,
    );
    expect(html).toContain(">wide<");
  });
});

describe("page width class tables", () => {
  it("cover exactly wide, readable and full", () => {
    expect(Object.keys(PAGE_WIDTH_MAIN_CLASS).sort()).toEqual([...WIDTHS].sort());
    expect(Object.keys(PAGE_WIDTH_CONTAINER_CLASS).sort()).toEqual([...WIDTHS].sort());
  });

  it("gives full a fixed height below the top bar instead of the document padding", () => {
    expect(PAGE_WIDTH_MAIN_CLASS.full).toContain("h-[calc(100dvh-var(--topbar-height))]");
    expect(PAGE_WIDTH_MAIN_CLASS.full).not.toContain("py-6");
    // wide and readable scroll with the document at the shell's usual padding.
    expect(PAGE_WIDTH_MAIN_CLASS.wide).toBe(PAGE_WIDTH_MAIN_CLASS.readable);
    expect(PAGE_WIDTH_MAIN_CLASS.wide).toContain("px-4");
    expect(PAGE_WIDTH_MAIN_CLASS.wide).toContain("py-6");
    expect(PAGE_WIDTH_MAIN_CLASS.wide).not.toContain("h-[calc");
  });

  it("caps only readable's content width; wide and full stay edge to edge", () => {
    expect(PAGE_WIDTH_CONTAINER_CLASS.readable).toContain("max-w-6xl");
    expect(PAGE_WIDTH_CONTAINER_CLASS.readable).toContain("mx-auto");
    expect(PAGE_WIDTH_CONTAINER_CLASS.wide).not.toContain("max-w");
    expect(PAGE_WIDTH_CONTAINER_CLASS.full).not.toContain("max-w");
  });

  it("makes full a column its page can grow inside (independent scrolling panes)", () => {
    expect(PAGE_WIDTH_CONTAINER_CLASS.full).toContain("flex-1");
    expect(PAGE_WIDTH_CONTAINER_CLASS.full).toContain("flex-col");
    expect(PAGE_WIDTH_CONTAINER_CLASS.full).toContain("min-h-0");
  });
});

describe("pageContentWrapperClass", () => {
  it("gives full a growing flex item and every other width a transparent box", () => {
    expect(pageContentWrapperClass("full")).toBe("min-h-0 flex-1");
    expect(pageContentWrapperClass("wide")).toBe("contents");
    expect(pageContentWrapperClass("readable")).toBe("contents");
  });

  it("never returns an empty or falsy class, so the wrapper div is never conditionally omitted", () => {
    // ShellMain renders `<div className={pageContentWrapperClass(width)}>{children}</div>`
    // unconditionally for every width; a falsy result here would tempt a future
    // change back toward `width === "full" ? <div>...</div> : children`, which
    // changes the element type at that position in the tree and remounts the
    // routed page (and whatever the user navigates to next) on every width
    // change into or out of full.
    for (const width of WIDTHS) {
      expect(pageContentWrapperClass(width)).toBeTruthy();
    }
  });
});

describe("PageMain (DOM)", () => {
  let container: HTMLDivElement;
  let root: Root;

  function mount(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(node);
    });
  }

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function mainElement(): HTMLElement {
    const element = container.querySelector("main");
    if (!element) {
      throw new Error("expected PageMain to render a <main> element");
    }
    return element;
  }

  it("renders at the default width when no page opts in", () => {
    mount(
      <PageProvider>
        <PageMain>content</PageMain>
      </PageProvider>,
    );
    expect(mainElement().className).toBe(
      `outline-none ${PAGE_WIDTH_MAIN_CLASS[DEFAULT_PAGE_WIDTH]}`,
    );
  });

  it("passes the id through, for the shell's skip-to-content link", () => {
    mount(
      <PageProvider>
        <PageMain id="main-content">content</PageMain>
      </PageProvider>,
    );
    expect(mainElement().id).toBe("main-content");
  });

  it("switches to full from one usePageWidth('full') call in a child, and restores the default when that child goes away", () => {
    function FullPage() {
      usePageWidth("full");
      return <span>full page</span>;
    }

    function Harness({ showFullPage }: { showFullPage: boolean }) {
      return (
        <PageProvider>
          <PageMain>{showFullPage ? <FullPage /> : "wide page"}</PageMain>
        </PageProvider>
      );
    }

    mount(<Harness showFullPage={false} />);
    expect(mainElement().className).toBe(`outline-none ${PAGE_WIDTH_MAIN_CLASS.wide}`);

    act(() => {
      root.render(<Harness showFullPage={true} />);
    });
    expect(mainElement().className).toBe(`outline-none ${PAGE_WIDTH_MAIN_CLASS.full}`);
    expect(mainElement().className).toContain("h-[calc(100dvh-var(--topbar-height))]");

    // Simulates navigating away: the page that called usePageWidth("full")
    // unmounts, same as TanStack Router swapping the routed component out.
    act(() => {
      root.render(<Harness showFullPage={false} />);
    });
    expect(mainElement().className).toBe(
      `outline-none ${PAGE_WIDTH_MAIN_CLASS[DEFAULT_PAGE_WIDTH]}`,
    );
    expect(mainElement().className).not.toContain("h-[calc");
  });
});
