import { cn } from "cn";
import { RotateCcw } from "lucide-react";

/**
 * The restore mark of a menu entry that leads to a restore (lib/navigation.ts
 * `NavItem.marker`): a turn-back arrow in a green circle at the right end of
 * the entry, beside its own icon, so the way back to data stands out in the
 * menu. Drawn only: the label already names the restore, so assistive
 * technology hears nothing more. Hidden in the collapsed rail, which shows
 * the entry's own icon alone.
 */
export function RestoreMarker({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-slot="restore-marker"
      className={cn(
        "ml-auto inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-success text-success-foreground group-data-[collapsible=icon]:hidden",
        className,
      )}
    >
      <RotateCcw className="size-2.5" strokeWidth={3} />
    </span>
  );
}
