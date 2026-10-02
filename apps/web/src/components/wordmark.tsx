import { DEFAULT_PRODUCT_NAME } from "@restow/i18n";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

interface RestowMarkProps {
  className?: string;
  /** One colour (`currentColor`) for places that cannot carry the two brand colours. */
  mono?: boolean;
}

/**
 * The Restow mark (brand guide, section 2): a hold, an open rounded trough,
 * with one bar lying on its bottom. 48 x 48 grid. The hold takes --mark-hold
 * and the bar --mark-beam: Nile and Lapis in light mode, Limestone and Lapis
 * Dark in dark mode. These are the mark's own tokens, not --foreground and
 * --primary: the mark keeps the brand colours in every colour scheme (the
 * Neutral scheme recolours the interface, never the logo), and a white-label
 * installation overrides the two tokens to brand its own. Never the success
 * green.
 */
export function RestowMark({ className, mono = false }: RestowMarkProps) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={cn("size-[22px] shrink-0", className)}>
      <path
        d="M10 13 v15 a10 10 0 0 0 10 10 h8 a10 10 0 0 0 10-10 V13"
        fill="none"
        strokeWidth={7}
        strokeLinecap="round"
        className={mono ? "stroke-current" : "stroke-mark-hold"}
      />
      <rect
        x={15.5}
        y={25}
        width={17}
        height={7}
        rx={2}
        className={mono ? "fill-current" : "fill-mark-beam"}
      />
    </svg>
  );
}

interface BrandNameProps {
  className?: string;
}

/**
 * The product name from the branding. While it is the default name, it is set
 * as the wordmark of the brand guide (section 3): "restow" in bold, tight
 * tracking, then "backup suite" in a mono face, smaller and in the secondary
 * colour, both lowercase. Any other name an operator configures is shown as
 * written, without the descriptor. Screen readers always get the plain name.
 */
export function BrandName({ className }: BrandNameProps) {
  const { t } = useTranslation();
  const name = t("app.name");

  if (name !== DEFAULT_PRODUCT_NAME) {
    return <span className={cn("truncate", className)}>{name}</span>;
  }

  return (
    <span className={cn("truncate", className)}>
      <span className="sr-only">{name}</span>
      <span aria-hidden="true" className="inline-flex items-baseline gap-[0.45em]">
        <span className="font-wordmark font-bold tracking-[-0.03em]">restow</span>
        <span className="font-wordmark-tag text-[0.7em] font-normal text-muted-foreground">
          backup suite
        </span>
      </span>
    </span>
  );
}

interface WordmarkProps {
  className?: string;
  /** Mark only; the name stays for screen readers. */
  compact?: boolean;
}

/** Mark plus the product name from the branding, for the auth pages and loading states. */
export function Wordmark({ className, compact = false }: WordmarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold", className)}>
      <RestowMark className="size-7" />
      <BrandName className={cn("text-base tracking-tight", compact && "sr-only")} />
    </span>
  );
}
