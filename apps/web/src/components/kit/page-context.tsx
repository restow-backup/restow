import type { LucideIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Page context: what the shell knows about the current page (the active nav
 * item's icon and the tenant name), a sink for the title the page shows, and
 * the width the page's content area renders at.
 *
 * The shell wraps its outlet in {@link PageProvider}. `PageHeader` reads the
 * icon as its fallback and publishes its title here, so breadcrumbs can show
 * an entity name ("Weekly mail backup") and the browser tab reads
 * "<title> · <tenant> · Restow" without per-page code. Outside a provider
 * everything still works: no icon, no tenant, and publishing is a no-op.
 */

interface PageFrame {
  /** Icon of the active navigation item; the header's fallback icon. */
  icon: LucideIcon | null;
  /** Display name of the active tenant, used in the document title. */
  tenantName: string | null;
  /** Publish the title the page shows, or `null` when the page goes away. */
  publishTitle: (title: string | null) => void;
}

const NO_FRAME: PageFrame = { icon: null, tenantName: null, publishTitle: () => {} };

/**
 * How wide a page's content area renders, chosen by the page itself through
 * {@link usePageWidth}:
 * - `wide` (the default): full width with responsive padding, for tables,
 *   dashboards and other data-heavy pages.
 * - `readable`: a capped, comfortable width for text-heavy forms and
 *   settings, so inputs never stretch across an ultra-wide monitor.
 * - `full`: edge to edge with minimal padding; the shell's `<main>` also
 *   gets a fixed height below the top bar, so the page can lay out its own
 *   independently scrolling panes instead of scrolling with the document.
 */
export type PageWidth = "wide" | "readable" | "full";

export const DEFAULT_PAGE_WIDTH: PageWidth = "wide";

/**
 * Tailwind classes for the shell's `<main>` element, keyed by page width.
 * Exported (rather than kept inside the shell) so the mapping is covered by
 * a plain, renderer-free test alongside the rest of this module.
 */
export const PAGE_WIDTH_MAIN_CLASS: Record<PageWidth, string> = {
  wide: "flex-1 px-4 py-6 md:px-8",
  readable: "flex-1 px-4 py-6 md:px-8",
  // `100dvh`, not `100svh`: on a mobile browser whose toolbar retracts as the
  // page scrolls, `dvh` tracks that shrinking/growing viewport, so a `full`
  // page's panes fill the space the toolbar frees up instead of leaving a
  // gap below them once it retracts.
  full: "flex h-[calc(100dvh-var(--topbar-height))] flex-col overflow-hidden p-2",
};

/** Tailwind classes for the content wrapper inside `<main>`, keyed by page width. */
export const PAGE_WIDTH_CONTAINER_CLASS: Record<PageWidth, string> = {
  wide: "w-full",
  readable: "mx-auto w-full max-w-6xl",
  full: "flex min-h-0 flex-1 flex-col",
};

/**
 * Class for the `<div>` `ShellMain` (app-layout.tsx) wraps the routed page
 * in, keyed by page width. `full` gets a flex item that can grow to the
 * container's height; every other width gets `contents`, so the div takes
 * no part in layout and the page renders exactly as if it sat directly in
 * its parent, same as before this wrapper existed.
 *
 * `ShellMain` renders this div unconditionally — never a `Fragment` in one
 * branch and a `div` in another — so the element type at that position in
 * the tree never changes when the width changes. A conditional element type
 * there would make React unmount and remount the whole subtree (the routed
 * page, and the next one after a navigation) every time a page switches
 * into or out of `full`.
 */
export function pageContentWrapperClass(width: PageWidth): string {
  return width === "full" ? "min-h-0 flex-1" : "contents";
}

export interface PageMainProps {
  /** DOM id the shell's "skip to content" link targets. */
  id?: string;
  children: React.ReactNode;
}

/**
 * The shell's `<main>` landmark, sized by the current page's width (see
 * {@link PageWidth}): everything `ShellMain` (routes/app-layout.tsx) puts
 * inside it — the demo banner, the suspended-tenant notice, then the routed
 * page — passes through as `children` unchanged.
 *
 * Factored out of `ShellMain` so the width mechanism, the one thing this
 * page-width feature actually changes, can be mounted and exercised on its
 * own in page-context.test.tsx. `ShellMain` stays in routes/app-layout.tsx
 * because its other children (the demo banner, the tenant notice) need the
 * query client and i18n providers the app sets up around the whole shell,
 * neither of which this module or its tests pull in.
 */
export function PageMain({ id, children }: PageMainProps) {
  const width = usePageWidthValue();
  return (
    <main id={id} tabIndex={-1} className={cn("outline-none", PAGE_WIDTH_MAIN_CLASS[width])}>
      <div className={PAGE_WIDTH_CONTAINER_CLASS[width]}>{children}</div>
    </main>
  );
}

interface PageWidthFrame {
  width: PageWidth;
  setWidth: (width: PageWidth) => void;
}

const NO_WIDTH_FRAME: PageWidthFrame = { width: DEFAULT_PAGE_WIDTH, setWidth: () => {} };

// Three contexts: the frame changes only on navigation, the title on every
// page, and the width whenever a page opts into a non-default one; headers
// subscribe to the first, breadcrumbs to the second, the shell to the third.
const PageFrameContext = React.createContext<PageFrame>(NO_FRAME);
const PageTitleContext = React.createContext<string | null>(null);
const PageWidthContext = React.createContext<PageWidthFrame>(NO_WIDTH_FRAME);

export interface PageProviderProps {
  /** Icon of the active navigation item. */
  icon?: LucideIcon | null;
  /** Display name of the active tenant. */
  tenantName?: string | null;
  children: React.ReactNode;
}

/** Provided once by the shell around the routed page. */
export function PageProvider({ icon = null, tenantName = null, children }: PageProviderProps) {
  const [title, setTitle] = React.useState<string | null>(null);
  const [width, setWidth] = React.useState<PageWidth>(DEFAULT_PAGE_WIDTH);
  const frame = React.useMemo<PageFrame>(
    () => ({ icon, tenantName, publishTitle: setTitle }),
    [icon, tenantName],
  );
  const widthFrame = React.useMemo<PageWidthFrame>(() => ({ width, setWidth }), [width]);
  return (
    <PageFrameContext.Provider value={frame}>
      <PageTitleContext.Provider value={title}>
        <PageWidthContext.Provider value={widthFrame}>{children}</PageWidthContext.Provider>
      </PageTitleContext.Provider>
    </PageFrameContext.Provider>
  );
}

/** Icon, tenant and title sink of the current page. */
export function usePageFrame(): PageFrame {
  return React.useContext(PageFrameContext);
}

/** Title the current page published, for breadcrumbs; `null` when none. */
export function usePageTitle(): string | null {
  return React.useContext(PageTitleContext);
}

/** The width the shell currently renders its content area at; read by the shell only. */
export function usePageWidthValue(): PageWidth {
  return React.useContext(PageWidthContext).width;
}

/**
 * Opt the calling page into a content width other than the shell's default
 * (`wide`): `usePageWidth("readable")` for a text-heavy form or settings
 * page, `usePageWidth("full")` for a page that builds its own independently
 * scrolling layout (see {@link PageWidth}).
 *
 * Applies for as long as the calling component stays mounted; a `useLayoutEffect`
 * keeps the switch invisible (it lands before the browser paints), and its
 * cleanup puts the width back to the default the moment the page unmounts —
 * so navigating away always restores the default, with nothing to reset by
 * hand. A page that never calls this hook stays at the default throughout.
 *
 * Call it from the routed page component itself, once, not from an
 * arbitrarily-nested child — the context holds one width for the whole
 * shell, not a stack. Two mounted callers race the same `setWidth`: the one
 * that unmounts first resets the width out from under the other, which is
 * still relying on it. One call per page avoids that.
 */
export function usePageWidth(width: PageWidth): void {
  const { setWidth } = React.useContext(PageWidthContext);

  React.useLayoutEffect(() => {
    setWidth(width);
    return () => setWidth(DEFAULT_PAGE_WIDTH);
  }, [setWidth, width]);
}

/** "Storage · Example Ltd · Restow"; empty parts are left out. */
export function documentTitle(
  title: string | null | undefined,
  tenantName: string | null | undefined,
  appName: string,
): string {
  return [title, tenantName, appName]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join(" · ");
}

/**
 * Publish `title` for breadcrumbs and set the browser tab title while the
 * calling component is mounted. `PageHeader` does this for every page; a page
 * with a custom header can call it directly.
 */
export function usePublishedTitle(title: string, appName: string, enabled = true): void {
  const { publishTitle, tenantName } = usePageFrame();

  React.useEffect(() => {
    if (!enabled) {
      return;
    }
    publishTitle(title);
    return () => publishTitle(null);
  }, [enabled, publishTitle, title]);

  React.useEffect(() => {
    if (!enabled) {
      return;
    }
    document.title = documentTitle(title, tenantName, appName);
    // The next page sets its own title in the same commit; a page without a
    // header falls back to the plain product name instead of a stale title.
    return () => {
      document.title = appName;
    };
  }, [enabled, title, tenantName, appName]);
}

const EmbeddedPageContext = React.createContext(false);

/**
 * Marks the pages rendered inside it as a part of a larger page (a section of
 * the tenant page): their `PageHeader` becomes a section heading, one level
 * below the page's own, and no longer publishes the page title or the browser
 * tab title, which the surrounding page owns.
 */
export function EmbeddedPage({ children }: { children: React.ReactNode }) {
  return <EmbeddedPageContext.Provider value={true}>{children}</EmbeddedPageContext.Provider>;
}

/** Whether the calling page is shown inside another page (see {@link EmbeddedPage}). */
export function useEmbeddedPage(): boolean {
  return React.useContext(EmbeddedPageContext);
}
