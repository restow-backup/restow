import { useTranslation } from "react-i18next";

import { CopyButton } from "@/components/kit";
import { cn } from "@/lib/utils";

import "./i18n.js";

/**
 * Commands or configuration to copy into another system (Exchange Online PowerShell, a
 * Postfix map, a Sieve script): a labelled, selectable block with a copy button. Long lines
 * wrap on screen; the copy holds the text exactly as generated.
 */
export function CommandBlock({
  id,
  label,
  value,
  copyLabel,
  className,
}: {
  id: string;
  /** What the block holds; names the block for screen readers and the copy button. */
  label: string;
  value: string;
  copyLabel?: string;
  className?: string;
}) {
  const { t } = useTranslation("archive");
  return (
    <figure className={cn("m-0 min-w-0 space-y-1", className)} data-slot="command-block">
      <figcaption className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        <CopyButton
          value={value}
          label={copyLabel ?? t("commands.copy", { label })}
          variant="outline"
        />
      </figcaption>
      {/* Wraps instead of scrolling, so nothing is out of reach without a pointer. */}
      <pre
        id={id}
        className="bg-muted/40 rounded-md border px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap select-all [overflow-wrap:anywhere]"
      >
        {value}
      </pre>
    </figure>
  );
}
