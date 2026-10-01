/**
 * What a ConfirmDialog does once the user confirmed, free of React so every
 * branch is testable: the dialog passes its state setters in as effects.
 */

/** How a confirmation ended. */
export type ConfirmOutcome =
  /** The action finished and the dialog closed. */
  | "closed"
  /** The action failed; the dialog stays open and shows the cause. */
  | "failed"
  /** A controlled dialog's owner runs the action and closes the dialog itself. */
  | "handedOver";

/** The dialog state a confirmation changes. */
export interface ConfirmEffects {
  setRunning: (running: boolean) => void;
  /** The cause of the last failure; `null` clears it. */
  setFailure: (cause: unknown) => void;
  close: () => void;
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Runs `action` and settles the dialog:
 * - a promise keeps the dialog running until it settles, then closes it on
 *   success or keeps it open with the cause on failure;
 * - any other result closes an uncontrolled dialog at once (nobody else
 *   could), while a controlled one is left to its owner, who passes
 *   `pending`, `error` and `open`;
 * - an action that throws right away counts as a failure.
 */
export async function runConfirm(
  action: () => unknown,
  controlled: boolean,
  effects: ConfirmEffects,
): Promise<ConfirmOutcome> {
  effects.setFailure(null);
  let result: unknown;
  try {
    result = action();
  } catch (cause) {
    effects.setFailure(cause);
    return "failed";
  }

  if (!isPromiseLike(result)) {
    if (controlled) {
      return "handedOver";
    }
    effects.close();
    return "closed";
  }

  effects.setRunning(true);
  try {
    await result;
  } catch (cause) {
    effects.setRunning(false);
    effects.setFailure(cause);
    return "failed";
  }
  effects.setRunning(false);
  effects.close();
  return "closed";
}
