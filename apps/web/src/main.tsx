import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { ThemeProvider } from "@/components/theme-provider";
import { i18n } from "@/i18n";
import { queryClient } from "@/lib/query";
import { SessionProvider } from "@/lib/session";
import { router } from "@/router";

import "@/fonts.css";
import "@/index.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Root element #root not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <SessionProvider>
            <RouterProvider router={router} />
          </SessionProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nextProvider>
  </React.StrictMode>,
);
