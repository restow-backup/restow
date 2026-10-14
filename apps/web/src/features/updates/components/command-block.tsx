import { CopyButton } from "@/components/kit/copy-button";
import { cn } from "@/lib/utils";

/**
 * One shell command, copyable. The command is shown exactly as it is copied
 * and scrolls sideways on a narrow screen instead of wrapping (a wrapped
 * command cannot be told apart from two). `wrap` breaks it anywhere instead,
 * for a narrow place such as a dialog, where a scroll region would be hard to use.
 */
export function CommandBlock({
  command,
  copyLabel,
  className,
  wrap = false,
}: {
  command: string;
  /** Accessible name of the copy button, e.g. "Copy command". */
  copyLabel: string;
  className?: string;
  wrap?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 items-center gap-1 rounded-md border border-border bg-muted/50 pl-3",
        className,
      )}
    >
      <code
        className={cn(
          "min-w-0 flex-1 py-2 font-mono text-xs",
          wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "overflow-x-auto whitespace-pre",
        )}
        // A focusable scroll region, so a keyboard user can reach a long command.
        tabIndex={wrap ? undefined : 0}
      >
        {command}
      </code>
      <CopyButton value={command} label={copyLabel} />
    </div>
  );
}

/** Several commands in run order, each copyable on its own. */
export function CommandList({
  commands,
  copyLabel,
  className,
}: {
  commands: readonly string[];
  copyLabel: string;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      {commands.map((command) => (
        <CommandBlock key={command} command={command} copyLabel={copyLabel} />
      ))}
    </div>
  );
}
