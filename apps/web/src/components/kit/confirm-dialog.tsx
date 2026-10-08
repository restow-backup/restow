import { TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessageKey } from "@/lib/api";

import { runConfirm } from "./confirm-flow.js";
import { UI_NAMESPACE } from "./i18n.js";

export interface ConfirmDialogProps {
  /** Controlled open state; leave both open props out when using `trigger`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The element that opens the dialog (uncontrolled use). */
  trigger?: React.ReactElement;
  title: string;
  /** What will happen and what it affects. */
  description: React.ReactNode;
  /** Extra content between the description and the buttons (facts, affected objects). */
  children?: React.ReactNode;
  confirmLabel: string;
  /** Label of the dismiss button; "Cancel" when omitted. */
  cancelLabel?: string;
  /** Styles the confirm button as destructive: deleting, revoking, anything final. */
  destructive?: boolean;
  /** The action runs: buttons are busy and the dialog cannot be dismissed. */
  pending?: boolean;
  /** Why the last attempt failed; shown inside the dialog, which stays open. */
  error?: React.ReactNode;
  /** When set, the confirm button enables only after the user typed this text. */
  confirmationText?: string;
  /** Keeps the confirm button disabled, e.g. while a required field in `children` is empty. */
  confirmDisabled?: boolean;
  /**
   * Runs the action. Returning a promise (`mutation.mutateAsync`) keeps the
   * dialog pending until it settles: it closes on success and stays open with
   * the mapped cause on failure. Any other result (`mutation.mutate`) closes
   * an uncontrolled dialog at once; a controlled dialog stays open for its
   * owner to drive with `pending`, `error` and `open`.
   */
  onConfirm: () => unknown;
}

/** Whether the typed confirmation matches (surrounding spaces are ignored). */
export function confirmationMatches(expected: string | undefined, typed: string): boolean {
  return expected === undefined || typed.trim() === expected.trim();
}

/**
 * The question before a consequential action, on the shadcn AlertDialog.
 * It cannot be dismissed while the action runs, keeps itself open with the
 * cause when the action fails, and can require the user to type a name
 * before a destructive action enables.
 *
 * Two ways to use it: give it a `trigger` and an `onConfirm` that returns a
 * promise, and it handles pending, failure and closing on its own; or control
 * `open` (typical for row actions, where one dialog serves every row).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel,
  destructive = false,
  pending = false,
  error,
  confirmationText,
  confirmDisabled = false,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useTranslation(UI_NAMESPACE);
  const [internalOpen, setInternalOpen] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [failure, setFailure] = React.useState<unknown>(null);
  const [typed, setTyped] = React.useState("");
  const [wasOpen, setWasOpen] = React.useState(open ?? false);
  const inputId = React.useId();
  const inputRef = React.useRef<HTMLInputElement>(null);
  // Blocks a second submit (double Enter) before the busy state has rendered.
  const inFlight = React.useRef(false);

  const controlled = open !== undefined;
  const isOpen = open ?? internalOpen;
  const busy = pending || running;
  const confirmed = confirmationMatches(confirmationText, typed) && !confirmDisabled;

  // Every opening starts clean: no leftover text, no stale failure. Reset
  // while rendering, so the previous opening's state never shows for a frame.
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setTyped("");
      setFailure(null);
    }
  }

  const commitOpen = (next: boolean) => {
    if (!controlled) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
  };

  const confirm = async () => {
    if (busy || inFlight.current || !confirmed) {
      return;
    }
    inFlight.current = true;
    try {
      await runConfirm(onConfirm, controlled, {
        setRunning,
        // Wrapped, so a cause that happens to be a function is stored, not called as an updater.
        setFailure: (cause) => setFailure(() => cause),
        close: () => commitOpen(false),
      });
    } finally {
      inFlight.current = false;
    }
  };

  const shownError = error ?? (failure !== null ? t(`common:${errorMessageKey(failure)}`) : null);

  const body = (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void confirm();
      }}
    >
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="space-y-2">{description}</div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      {children}
      {confirmationText !== undefined ? (
        <div className="grid gap-2">
          <Label htmlFor={inputId} className="block leading-normal font-normal">
            {t("confirm.typePrompt")}{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold break-all">
              {confirmationText}
            </code>
          </Label>
          <Input
            ref={inputRef}
            id={inputId}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={busy}
          />
        </div>
      ) : null}
      {shownError ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{shownError}</AlertDescription>
        </Alert>
      ) : null}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>
          {cancelLabel ?? t("common:actions.cancel")}
        </AlertDialogCancel>
        <Button
          type="submit"
          variant={destructive ? "destructive" : "default"}
          loading={busy}
          disabled={!confirmed}
        >
          {confirmLabel}
        </Button>
      </AlertDialogFooter>
    </form>
  );

  return (
    <AlertDialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next && busy) {
          return;
        }
        commitOpen(next);
      }}
    >
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      <AlertDialogContent
        // Escape must not abandon a running action (outside clicks never close an alert dialog).
        onEscapeKeyDown={(event) => {
          if (busy) {
            event.preventDefault();
          }
        }}
        // With a typed confirmation, start in the field instead of on Cancel.
        onOpenAutoFocus={(event) => {
          if (confirmationText !== undefined) {
            event.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        {body}
      </AlertDialogContent>
    </AlertDialog>
  );
}
