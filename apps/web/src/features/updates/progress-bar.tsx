import { Progress } from "@/components/ui/progress";

/** A progress bar of a whole percent, 0 to 100, clamped and rounded, with its accessible name. */
export function ProgressBar({
  value,
  label,
  className,
}: {
  /** Percent, 0 to 100. */
  value: number;
  label: string;
  className?: string;
}) {
  const percent = Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
  return <Progress value={percent} aria-label={label} className={className} />;
}
