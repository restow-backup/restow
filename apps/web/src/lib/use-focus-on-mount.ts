import * as React from "react";

/**
 * A ref that takes keyboard focus once, when its element first appears. For a
 * result that replaces a form: the form unmounts and focus would fall back to
 * the document, so a screen reader would say nothing about the outcome. The
 * element gets `tabIndex={-1}` so it can hold focus without joining the tab
 * order.
 */
export function useFocusOnMount<T extends HTMLElement>() {
  const ref = React.useRef<T>(null);
  React.useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return ref;
}
