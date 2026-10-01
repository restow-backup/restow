import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import { UI_NAMESPACE } from "./i18n.js";
import { IconButton, type IconButtonProps } from "./icon-button.js";

export interface RefreshButtonProps
  extends Omit<IconButtonProps, "icon" | "label" | "onClick" | "loading"> {
  onRefresh: () => void;
  /** A fetch is running (for example `query.isFetching`); the icon spins only then. */
  fetching?: boolean;
  /** Accessible name; defaults to "Refresh". */
  label?: string;
}

/**
 * Re-fetches the data on the page. The button stays focusable while a fetch
 * runs (keyboard focus is never lost) but ignores further clicks until it ends.
 */
export function RefreshButton({
  onRefresh,
  fetching = false,
  label,
  iconClassName,
  ...props
}: RefreshButtonProps) {
  const { t } = useTranslation(UI_NAMESPACE);
  const name = label ?? t("refresh.action");
  return (
    <IconButton
      {...props}
      icon={RefreshCw}
      label={name}
      tooltip={fetching ? t("refresh.refreshing") : name}
      aria-busy={fetching || undefined}
      iconClassName={cn(fetching && "animate-spin", iconClassName)}
      onClick={() => {
        if (!fetching) {
          onRefresh();
        }
      }}
    />
  );
}
