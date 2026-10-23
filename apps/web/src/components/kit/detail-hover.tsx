import type * as React from "react";
import { useTranslation } from "react-i18next";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";

import { LogBlock } from "./detail-sheet.js";
import { UI_NAMESPACE } from "./i18n.js";

export interface DetailHoverProps {
  /** The full text (an error, restic's or the node's words), shown as written. */
  text: string;
  /** One line above the text ("The restore point did not boot"). */
  title?: string;
  tone?: "destructive" | "warning" | "muted";
  /** What is hovered: a badge or a cut-off line. */
  children: React.ReactElement;
}

/**
 * The full text behind a badge or a line cut to fit a table cell: on hover or keyboard focus, a
 * card with the text as written in a scrolling monospace block and a Copy button. Unlike a
 * `title` tooltip it stays open while the pointer is on it, so the text can be selected.
 */
export function DetailHover({ text, title, tone = "muted", children }: DetailHoverProps) {
  const { t } = useTranslation(UI_NAMESPACE);
  return (
    <HoverCard openDelay={150} closeDelay={200}>
      <HoverCardTrigger asChild>
        {/* A button so the card also opens on keyboard focus; clicking it does nothing else. */}
        <button
          type="button"
          className="inline-flex max-w-full cursor-default rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {children}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        className="w-[min(36rem,calc(100vw-2rem))] space-y-2"
        data-slot="detail-hover"
      >
        {title ? <p className="text-sm font-medium break-words">{title}</p> : null}
        <LogBlock
          text={text}
          tone={tone}
          label={t("copy.action")}
          name={title ?? text.slice(0, 80)}
        />
      </HoverCardContent>
    </HoverCard>
  );
}
