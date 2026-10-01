import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { Toaster as Sonner, type ToasterProps, toast } from "sonner";

import { useTheme } from "@/components/theme-provider";

/**
 * App-wide toast outlet. Follows the app's resolved theme (ThemeProvider, not
 * next-themes), uses the popover tokens and translates the labels sonner
 * would otherwise announce in English.
 */
function Toaster({ toastOptions, ...props }: ToasterProps) {
  const { resolvedTheme } = useTheme();
  const { t } = useTranslation();

  return (
    <Sonner
      theme={resolvedTheme}
      className="toaster group"
      position="bottom-right"
      closeButton
      containerAriaLabel={t("nav.notifications")}
      toastOptions={{ closeButtonAriaLabel: t("actions.close"), ...toastOptions }}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster, toast };
