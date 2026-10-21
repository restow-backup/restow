import * as React from "react";

/** The CSS variable that carries the height of the shell's sticky header (banner + top bar). */
export const SHELL_HEADER_HEIGHT_VAR = "--shell-header-height";

/**
 * Publish the height of the shell's sticky header as {@link SHELL_HEADER_HEIGHT_VAR} on the
 * document: the maintenance banner above the top bar is one line or several (a narrow screen),
 * and what lies below must know (0.4.2): pages of `full` width size themselves by it, the
 * sticky section navigation keeps clear of it and anchors scroll beneath it
 * (`scroll-padding-top` in index.css). Without the element (or a ResizeObserver) the variable
 * keeps its default, the top bar's height.
 */
export function useShellHeaderHeight(ref: React.RefObject<HTMLElement | null>): void {
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof document === "undefined") {
      return;
    }
    const root = document.documentElement;
    const publish = () => {
      const height = element.getBoundingClientRect().height;
      if (height > 0) {
        root.style.setProperty(SHELL_HEADER_HEIGHT_VAR, `${Math.ceil(height)}px`);
      }
    };
    publish();
    if (typeof ResizeObserver === "undefined") {
      return () => root.style.removeProperty(SHELL_HEADER_HEIGHT_VAR);
    }
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty(SHELL_HEADER_HEIGHT_VAR);
    };
  }, [ref]);
}
