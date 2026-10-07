import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";

import "../i18n";
import type { WarningRef } from "../api";
import { useAcknowledge } from "../hooks";

/** The longest note the server keeps (packages/core MAX_ACK_NOTE_LENGTH). */
export const NOTE_MAX_LENGTH = 1000;

/**
 * Acknowledge the warnings of one or many objects, with an optional note. Says before anything
 * happens what acknowledging means: the warning stops counting until a new problem appears, and
 * a failed backup cannot be acknowledged.
 */
export function AcknowledgeDialog({
  targets,
  open,
  onOpenChange,
  onDone,
}: {
  targets: readonly WarningRef[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}) {
  const { t } = useTranslation("warnings");
  const [note, setNote] = React.useState("");
  const acknowledge = useAcknowledge();
  const noteId = React.useId();

  React.useEffect(() => {
    if (!open) {
      setNote("");
    }
  }, [open]);

  const submit = () => {
    acknowledge.mutate(
      { targets, note: note.trim().length > 0 ? note.trim() : null },
      {
        onSuccess: (result) => {
          toast.success(t("toast.acknowledged", { count: result.acknowledged.length }), {
            description:
              result.skipped.length > 0
                ? t("toast.skipped", { count: result.skipped.length })
                : undefined,
          });
          onOpenChange(false);
          onDone?.();
        },
        onError: () => toast.error(t("toast.failed")),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-slot="acknowledge-dialog">
        <DialogHeader>
          <DialogTitle>{t("dialog.title", { count: targets.length })}</DialogTitle>
          <DialogDescription>{t("dialog.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={noteId}>{t("dialog.note")}</Label>
          <Textarea
            id={noteId}
            value={note}
            maxLength={NOTE_MAX_LENGTH}
            placeholder={t("dialog.notePlaceholder")}
            onChange={(event) => setNote(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("dialog.noteHelp")}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("dialog.cancel")}
          </Button>
          <Button onClick={submit} loading={acknowledge.isPending} disabled={targets.length === 0}>
            {t("dialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
