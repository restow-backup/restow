import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * The foot of a newest-first list that is loaded page by page: how many
 * entries are shown and, while older ones may exist, a button to load them.
 * Nothing silently falls off the end of the list.
 */
export function OlderEntries({
  shownLabel,
  moreLabel,
  hasMore,
  loading,
  onMore,
}: {
  /** "The newest 100 restores are shown." */
  shownLabel: string;
  /** "Show older" */
  moreLabel: string;
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-sm text-muted-foreground"
      data-slot="older-entries"
    >
      <span>{shownLabel}</span>
      {hasMore ? (
        <Button type="button" variant="outline" size="sm" loading={loading} onClick={onMore}>
          {loading ? null : <ChevronDown aria-hidden="true" />}
          {moreLabel}
        </Button>
      ) : null}
    </div>
  );
}
