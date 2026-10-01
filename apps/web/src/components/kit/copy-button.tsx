import { Check, Copy } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components/ui/sonner";

import { copyToClipboard } from "./clipboard.js";
import { UI_NAMESPACE } from "./i18n.js";
import { IconButton, type IconButtonProps } from "./icon-button.js";

/** How long the check mark stays after a successful copy. */
const CONFIRMATION_MS = 2000;

export interface CopyButtonProps
  extends Omit<IconButtonProps, "icon" | "label" | "onClick" | "value"> {
  /** The text that goes to the clipboard. */
  value: string;
  /** Accessible name, e.g. "Copy redirect URI"; defaults to "Copy". */
  label?: string;
  /** Called after the value reached the clipboard. */
  onCopied?: () => void;
}

/**
 * Copies `value` to the clipboard, also on plain-HTTP installations where the
 * browser has no Clipboard API (see `copyToClipboard`). Success shows a check
 * mark for two seconds (and is announced to screen readers); a failure says
 * so in a toast and asks the user to copy by hand.
 */
export function CopyButton({ value, label, onCopied, ...props }: CopyButtonProps) {
  const { t } = useTranslation(UI_NAMESPACE);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), CONFIRMATION_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async (button: HTMLElement) => {
    try {
      await copyToClipboard(value, button);
      setCopied(true);
      onCopied?.();
    } catch {
      toast.error(t("copy.failed"));
    }
  };

  const name = label ?? t("copy.action");
  return (
    <>
      <IconButton
        {...props}
        icon={copied ? Check : Copy}
        label={name}
        tooltip={copied ? t("copy.copied") : name}
        onClick={(event) => void copy(event.currentTarget)}
      />
      <span className="sr-only" aria-live="polite">
        {copied ? t("copy.copied") : ""}
      </span>
    </>
  );
}
