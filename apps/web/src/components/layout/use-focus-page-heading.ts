import * as React from "react";

import { MAIN_CONTENT_ID } from "@/components/layout/skip-link";

/** How long to wait for the new page's heading to render (about one second). */
const MAX_FRAMES = 60;

/**
 * After a navigation inside the shell, move focus to the new page's `h1` so
 * keyboard and screen-reader users start at the page they opened instead of
 * the link they left. The first render is left alone (focus stays at the top
 * of the document, where the skip link is), and so is a page that already
 * put focus somewhere inside itself (an autofocused search field). Pages
 * without a heading hand focus to the main region.
 */
export function useFocusPageHeading(pathname: string): void {
  const shownPath = React.useRef(pathname);

  React.useEffect(() => {
    if (shownPath.current === pathname) {
      return;
    }
    shownPath.current = pathname;
    if (typeof document === "undefined" || typeof requestAnimationFrame !== "function") {
      return;
    }

    let frame = 0;
    let attempts = 0;
    const focusHeading = () => {
      const main = document.getElementById(MAIN_CONTENT_ID);
      if (!main) {
        return;
      }
      const active = document.activeElement;
      if (active && active !== main && main.contains(active)) {
        return;
      }
      const heading = main.querySelector<HTMLElement>("h1");
      if (heading) {
        if (!heading.hasAttribute("tabindex")) {
          heading.setAttribute("tabindex", "-1");
        }
        heading.focus({ preventScroll: true });
        return;
      }
      attempts += 1;
      if (attempts < MAX_FRAMES) {
        frame = requestAnimationFrame(focusHeading);
      } else {
        main.focus({ preventScroll: true });
      }
    };

    frame = requestAnimationFrame(focusHeading);
    return () => cancelAnimationFrame(frame);
  }, [pathname]);
}
