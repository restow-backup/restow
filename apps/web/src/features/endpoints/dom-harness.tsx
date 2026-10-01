import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { i18n } from "@/i18n";

/**
 * A real DOM mount for the endpoint tests (react-dom/client + act, the same
 * convention as the other interactive suites; there is no React Testing
 * Library in this workspace). Only used by tests that run under happy-dom.
 */

// React only flushes effects synchronously inside `act` when it knows a test
// renderer is driving it, and nothing else in this workspace sets the flag.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface Mounted {
  container: HTMLElement;
  queryClient: QueryClient;
  render: (node: ReactNode) => Promise<void>;
  unmount: () => void;
  /** Everything on the page, including dialogs the mount portals into the body. */
  text: () => string;
  html: () => string;
  click: (element: Element) => Promise<void>;
  type: (input: HTMLInputElement | HTMLTextAreaElement, value: string) => Promise<void>;
  byText: <T extends HTMLElement = HTMLElement>(selector: string, text: string | RegExp) => T;
  maybeByText: <T extends HTMLElement = HTMLElement>(
    selector: string,
    text: string | RegExp,
  ) => T | null;
  settle: () => Promise<void>;
}

export function mount(): Mounted {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  const wrap = (children: ReactNode) => (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </I18nextProvider>
  );

  const settle = async () => {
    await act(async () => {
      await flush();
      await flush();
    });
  };

  const maybeByText = <T extends HTMLElement = HTMLElement>(
    selector: string,
    text: string | RegExp,
  ): T | null => {
    const found = [...document.body.querySelectorAll<T>(selector)].find((element) =>
      typeof text === "string"
        ? element.textContent?.includes(text)
        : text.test(element.textContent ?? ""),
    );
    return found ?? null;
  };

  const mounted: Mounted = {
    container,
    queryClient,
    render: async (next) => {
      await act(async () => {
        root.render(wrap(next));
        await flush();
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      queryClient.clear();
    },
    text: () => document.body.textContent ?? "",
    html: () => document.body.innerHTML,
    click: async (element) => {
      await act(async () => {
        (element as HTMLElement).click();
        await flush();
      });
    },
    type: async (input, value) => {
      await act(async () => {
        const proto =
          input instanceof HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await flush();
      });
    },
    byText: (selector, text) => {
      const found = maybeByText(selector, text);
      if (!found) {
        throw new Error(`no ${selector} with text ${String(text)}`);
      }
      return found as never;
    },
    maybeByText,
    settle,
  };
  return mounted;
}
