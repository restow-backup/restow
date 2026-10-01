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
 * with one bar lying on its bottom. 48 x 48 grid; the hold is Nile in light
 * mode and Limestone in dark mode, the bar Lapis and its dark-mode step. The
 * colours are fixed brand colours, not app theme tokens, so the mark reads the
 * same on every surface.
 */
export function RestowMark({ className, mono = false }: RestowMarkProps) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={cn("size-[22px] shrink-0", className)}>
      <path
        d="M10 13 v15 a10 10 0 0 0 10 10 h8 a10 10 0 0 0 10-10 V13"
        fill="none"
        strokeWidth={7}
        strokeLinecap="round"
        className={mono ? "stroke-current" : "stroke-[#0F1B2D] dark:stroke-[#F4F5F7]"}
      />
      <rect
        x={15.5}
        y={25}
        width={17}
        height={7}
        rx={2}
        className={mono ? "fill-current" : "fill-[#2B4C9B] dark:fill-[#9DB4E6]"}
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
 * tracking, then "backup" in a mono face, smaller and in the secondary colour,
 * both lowercase. Any other name an operator configures is shown as written.
 * Screen readers always get the plain name.
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
        <span className="font-wordmark-tag text-[0.7em] font-normal text-[#6B7486] dark:text-[#A7B0BD]">
          backup
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
