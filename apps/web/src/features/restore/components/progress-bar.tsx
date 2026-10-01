import { cn } from "@/lib/utils";

interface ProgressBarProps {
  /** Share done, 0..1; null while the total is not known yet (indeterminate). */
  ratio: number | null;
  /** Accessible name, e.g. "Restore progress". */
  label: string;
  /** Bar colour: the default, or destructive when items failed. */
  tone?: "default" | "destructive";
  className?: string;
}

/** A thin, accessible progress bar; pulses while the amount of work is still unknown. */
export function ProgressBar({ ratio, label, tone = "default", className }: ProgressBarProps) {
  const percent = ratio === null ? null : Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  return (
    <div
      role="progressbar"
      // Reachable for assistive technology without entering the tab order.
      tabIndex={-1}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      {percent === null ? (
        <div className="absolute inset-0 animate-pulse rounded-full bg-primary/40" />
      ) : (
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out",
            tone === "destructive" ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  );
}
